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
