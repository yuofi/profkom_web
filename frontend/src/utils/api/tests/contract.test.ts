import { afterEach, describe, expect, it } from 'vitest';
import { createFixtures, mockRoles } from '../../../mocks/fixtures';
import { installMockTransport } from '../../../mocks/transport';
import { sessionApi } from '../session.api';
import { tasksApi } from '../tasks.api';
import { reportsApi } from '../reports.api';
import { seasonsApi } from '../seasons.api';
import { filesApi } from '../files.api';
import { membershipApi } from '../membership.api';
import { page, normalizeApiError, ApiError } from '../request';
import { richText } from '../contract';
import { QueryClient } from '@tanstack/react-query';
import { clearPrivateCache } from '../invalidation';
import { eventsApi } from '../events.api';
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });
const useMock = (role: Parameters<typeof installMockTransport>[0] = 'organizer') => (mock = installMockTransport(role, { delay: 0 }));

describe('Safe contract fixtures', () => {
  it.each(mockRoles)('%s never puts assessment inputs or scores in public tasks', role => {
    const fixture = createFixtures(role);
    for (const task of fixture.tasks) {
      for (const hidden of ['criteria', 'assigned_at', 'score', 'kkr_score']) expect(task).not.toHaveProperty(hidden);
      for (const assignment of task.assignments) for (const hidden of ['hours', 'evaluation', 'effective_completed_at', 'score']) expect(assignment).not.toHaveProperty(hidden);
    }
    expect(fixture.profile).not.toHaveProperty('kkr_score');
  });
  it('HR deputy does not inherit global KKR or HR-review capabilities', () => {
    const caps = createFixtures('hr-deputy').session.capabilities;
    expect(caps).not.toContain('view_kkr'); expect(caps).not.toContain('hr_review_request');
  });
  it('never grants chair-only actions to chair deputies', () => {
    const caps = createFixtures('chair-deputy').session.capabilities;
    expect(caps).toContain('view_summary'); expect(caps).not.toContain('transfer_chair'); expect(caps).not.toContain('close_season');
  });
});
describe('API commands through mock transport', () => {
  it('opens the next season without hiding or changing the previous open work', async () => {
    useMock('chair'); await seasonsApi.command('season-next', 'open', { expected_revision: 1 });
    const seasons = (await seasonsApi.list()).items;
    expect(seasons.find(s => s.season_id === 'season-1')).toMatchObject({ state: 'open', is_current: false });
    expect((await tasksApi.list({ mine: false })).items[0].season_id).toBe('season-1');
    expect(seasons.filter(s => s.is_current)).toHaveLength(1);
  });
  it('moves all event-owned records with the explicit season correction', async () => {
    useMock('chair'); await seasonsApi.correctSeason({ object_kind: 'event', object_id: 'event-1', expected_revision: 1, target_season_id: 'season-next', reason: 'Ошибочный сезон' });
    expect((await tasksApi.get('task-1')).season_id).toBe('season-next');
    expect((await reportsApi.get('report-1')).season_id).toBe('season-next');
  });
  it('saves several decisions without archiving an account or altering another season', async () => {
    const fixture = useMock('hr'); const before = (await seasonsApi.summary('season-1')).version;
    const result = await seasonsApi.decisions('season-1', 101, { expected_version: before, decisions: ['kick', 'nice'], reason: 'Решение' });
    expect(result.rows[0].decisions).toEqual(['kick', 'nice']); expect(fixture.state.session.account_state).toBe('active');
    expect((await seasonsApi.summary('season-previous')).rows[0].decisions).not.toEqual(['kick', 'nice']);
  });
  it('retains old assignment history and records an independent replacement', async () => {
    useMock('leader');
    const result = await tasksApi.reassign('assignment-2', { expected_revision: 1, new_assignee_user_id: 101, hours: 4, previous_outcome: 'not_completed', evaluation: -1, reason: 'Исполнитель вышел' });
    expect(result.previous_assignment.status).toBe('not_completed'); expect(result.assignment.assignment_id).not.toBe('assignment-2');
    expect((await tasksApi.assessment(result.assignment.assignment_id)).hours).toBe(4);
    expect((await tasksApi.get('task-1')).assignments).toHaveLength(3);
    expect((await tasksApi.assessment('assignment-2')).evaluation).toBe(-1);
  });
  it('applies bulk hours atomically and rejects a stale item', async () => {
    useMock('leader');
    await expect(tasksApi.bulkHours([{ assignment_id: 'assignment-1', expected_revision: 1 }, { assignment_id: 'assignment-2', expected_revision: 0 }], 9, 'Правка')).rejects.toMatchObject({ status: 409 });
    expect((await tasksApi.assessment('assignment-1')).hours).toBe(2);
    await tasksApi.bulkHours([{ assignment_id: 'assignment-1', expected_revision: 1 }, { assignment_id: 'assignment-2', expected_revision: 1 }], 9, 'Правка');
    expect((await tasksApi.assessment('assignment-2')).hours).toBe(9);
  });
  it('reviews a submission using its server submission time and retains revision history', async () => {
    const fixture = useMock('leader'); const a = fixture.state.tasks[0].assignments[0];
    a.status = 'submitted'; a.submissions.push({ submission_id: 's1', submitted_at: '2026-10-17T09:00:00Z', text: richText('Результат'), links: [], files: [] });
    const reviewed = await tasksApi.command(a.assignment_id, 'request-revision', { expected_revision: 1, review_note: 'Уточнить' });
    expect(reviewed.submissions).toHaveLength(1);
    a.status = 'submitted';
    await tasksApi.command(a.assignment_id, 'accept', { expected_revision: reviewed.revision, evaluation: 1.5 });
    expect((await tasksApi.assessment(a.assignment_id)).effective_completed_at).toBe('2026-10-17T09:00:00Z');
    await expect(tasksApi.command(a.assignment_id, 'cancel', { expected_revision: a.revision, reason: 'Повтор' })).rejects.toMatchObject({ status: 409 });
  });
  it('copies annual structure with empty assignments and no historical work', async () => {
    useMock('chair'); const copied = await eventsApi.copy('event-1', { season_id: 'season-next', title: 'Новый экземпляр' });
    expect(copied.event.event_id).not.toBe('event-1'); expect(copied.event.leaders).toEqual([]);
    expect(copied.subevents[0].organizer_user_ids).toEqual([]); expect(copied.subevents[0].leaders).toEqual([]);
    expect(copied.event.report_series_id).toBe('series-event-1');
  });
  it('preserves a shared deputy at another principal when one leader is removed', async () => {
    useMock('chair'); let event = await eventsApi.get('event-1');
    event = await eventsApi.leaders('events', event.event_id, [101, 102], { expected_revision: event.revision }) as typeof event;
    await eventsApi.deputies(event.leaders[0].role_assignment_id, [105], { expected_revision: event.leaders[0].revision });
    await eventsApi.deputies(event.leaders[1].role_assignment_id, [105], { expected_revision: event.leaders[1].revision });
    event = await eventsApi.get('event-1');
    await eventsApi.leaders('events', event.event_id, [102], { expected_revision: event.revision });
    expect((await eventsApi.get('event-1')).leaders[0].deputy_user_ids).toEqual([105]);
  });
  it('updates chair deputies and revokes global actions after a chair transfer', async () => {
    useMock('chair'); const initial = await sessionApi.leadership();
    const deputies = await sessionApi.deputies([101, 102], { expected_revision: initial.revision });
    expect((await sessionApi.leadership()).deputies).toHaveLength(2);
    await sessionApi.transfer(102, { expected_revision: deputies.revision });
    expect((await sessionApi.leadership()).deputies).toEqual([]);
    expect((await sessionApi.get()).capabilities).not.toContain('transfer_chair');
    await expect(sessionApi.deputies([101], { expected_revision: deputies.revision })).rejects.toMatchObject({ status: 403 });
  });
  it('keeps empty and unavailable scenarios explicit without a real-network fallback', async () => {
    mock = installMockTransport('organizer', { delay: 0, scenario: 'empty' });
    expect((await tasksApi.list()).items).toEqual([]); mock.restore();
    mock = installMockTransport('organizer', { delay: 0, scenario: 'error' });
    await expect(tasksApi.list()).rejects.toMatchObject({ status: 503, code: 'unavailable' });
  });
  it('loads explicit session and cursor list shapes', async () => {
    useMock(); expect((await sessionApi.get()).account_state).toBe('active');
    const result = await tasksApi.list({ mine: true }); expect(result.items).toHaveLength(1); expect(result.next_cursor).toBeNull();
  });
  it('does not silently adapt a backend array into the new list contract', async () => {
    useMock(); mock!.adapter.resetHandlers(); mock!.adapter.onGet('/wrong-shape').reply(200, []);
    await expect(page('/wrong-shape')).rejects.toMatchObject({ code: 'contract_mismatch' });
  });
  it('preserves submissions across help, submit and concurrent repeat', async () => {
    useMock(); const started = await tasksApi.command('assignment-1', 'start', { expected_revision: 1 });
    const help = await tasksApi.command('assignment-1', 'request-help', { expected_revision: started.revision, message: richText('Нужна помощь') });
    expect(help.status).toBe('help_required');
    const submitted = await tasksApi.command('assignment-1', 'submit', { expected_revision: help.revision, text: richText('Готово'), links: [], file_ids: [] });
    expect(submitted.submissions[0].submitted_at).toBe('2026-10-18T12:00:00Z');
    await expect(tasksApi.command('assignment-1', 'submit', { expected_revision: help.revision, text: richText('Повтор') })).rejects.toMatchObject({ status: 409 });
    expect((await tasksApi.get('task-1')).assignments[0].submissions).toHaveLength(1);
  });
  it('denies hidden inputs and calculated summaries to an organizer', async () => {
    useMock(); await expect(tasksApi.inputs('task-1')).rejects.toMatchObject({ status: 403 });
    await expect(seasonsApi.summary('season-1')).rejects.toMatchObject({ status: 403 });
  });
  it('keeps published report content while saving a draft', async () => {
    useMock('leader'); const before = await reportsApi.get('report-1');
    const draft = await reportsApi.update(before.report_id, { expected_revision: before.revision, content: richText('Новая версия') });
    expect(draft.content).toEqual(before.content); expect(draft.draft_content?.body).toBe('Новая версия');
    const published = await reportsApi.publish(draft.report_id, { expected_revision: draft.revision });
    expect(published.content.body).toBe('Новая версия'); expect(published.published_version).toBe(2);
    const history = await reportsApi.versions(published.report_id); expect(history.items).toHaveLength(2); expect(history.items[0].content).toEqual(before.content);
  });
  it('removes draft access after a report role is revoked, including history reads', async () => {
    const fixture = useMock('leader'); const report = fixture.state.reports[0]; report.capabilities = ['view_report_versions'];
    expect(await reportsApi.get(report.report_id)).not.toHaveProperty('draft_content');
    expect((await reportsApi.history(report.report_series_id, 2026)).items[0]).not.toHaveProperty('draft_content');
    await expect(reportsApi.update(report.report_id, { expected_revision: report.revision, content: richText('Старый автор') })).rejects.toMatchObject({ status: 403 });
  });
  it('keeps main meetings hidden from an organizer while showing the team meeting', async () => {
    useMock(); await expect(eventsApi.meeting('events', 'event-1')).rejects.toMatchObject({ status: 403 });
    expect((await eventsApi.meeting('subevents', 'subevent-1'))?.meeting_id).toBe('meeting-1');
  });
  it('returns structured blockers without closing the season', async () => {
    useMock('chair'); const season = (await seasonsApi.list()).items.find(s => s.season_id === 'season-1')!;
    const result = await seasonsApi.command(season.season_id, 'begin-summary', { expected_revision: season.revision });
    if (!('revision' in result)) throw Error('Unexpected fixture');
    try { await seasonsApi.command(season.season_id, 'close', { expected_revision: result.revision }); throw Error('Expected blocker'); }
    catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).blockers[0].kind).toBe('missing_final_report'); }
  });
  it('requires binary upload before complete and returns a FileRef', async () => {
    useMock(); const intent = await filesApi.intent({ owner_kind: 'assignment', owner_id: 'assignment-1', purpose: 'result', name: 'result.txt', mime_type: 'text/plain', size_bytes: 4 });
    await expect(filesApi.complete(intent.file_id)).rejects.toMatchObject({ status: 409 });
    const file = await filesApi.upload(new File(['test'], 'result.txt', { type: 'text/plain' }), { owner_kind: 'assignment', owner_id: 'assignment-1', purpose: 'result' });
    expect(file.name).toBe('result.txt'); expect(file.size_bytes).toBe(4); expect(file).not.toHaveProperty('download_url');
  });
  it('rejects working requests for pending accounts', async () => {
    useMock('pending'); expect((await sessionApi.get()).account_state).toBe('pending');
    await expect(tasksApi.list()).rejects.toMatchObject({ status: 403 });
    expect((await membershipApi.registration()).status).toBe('pending');
  });
});
it('preserves structured and legacy error messages', () => {
  const error = new ApiError('Изменено', 409, 'revision_conflict'); expect(normalizeApiError(error)).toBe(error);
  expect(normalizeApiError(new Error('Сбой')).message).toBe('Сбой');
});
it('removes cached private objects when access changes', async () => {
  const client = new QueryClient(); client.setQueryData(['session'], { user_id: 101 });
  client.setQueryData(['tasks', 'task-private'], { title: 'Закрытые данные' });
  await clearPrivateCache(client);
  expect(client.getQueryData(['tasks', 'task-private'])).toBeUndefined();
  expect(client.getQueryData(['session'])).toEqual({ user_id: 101 }); client.clear();
});
