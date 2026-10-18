/** Development/test transport. Synthetic state is discarded on reload; no KKR calculations. */
import axios, { type AxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { api } from '../utils/api';
import { createFixtures, mockNow, type MockRole } from './fixtures';
import { richText, type AssignmentStatus, type Event, type Subevent, type Task, type TaskInputs, type Report, type ReportVersion, type Material, type FileRef, type Meeting, type Merit, type Decision, type Season } from '../utils/api/contract';

type Reply = [number, unknown];
type Body = Record<string, unknown>;
const fail = (status: number, code: string, message: string, fields?: object): Reply => [status, { detail: { code, message, fields } }];
const list = <T>(items: T[]): Reply => [200, { items, next_cursor: null }];
const dataOf = (config: AxiosRequestConfig): Body => typeof config.data === 'string' ? JSON.parse(config.data) as Body : (config.data ?? {}) as Body;
const clone = <T>(value: T): T => structuredClone(value);
const publicSubmission = (text: unknown) => typeof text === 'object' && text ? text as ReturnType<typeof richText> : richText(String(text ?? ''));

export function installMockTransport(role: MockRole = 'organizer', options: { delay?: number; scenario?: 'normal' | 'empty' | 'error' | 'conflict'; now?: string } = {}) {
  const state = createFixtures(role);
  const adapter = new MockAdapter(api, { delayResponse: options.delay ?? 100 });
  const uploads = new MockAdapter(axios);
  const files = new Map<string, FileRef & { complete: boolean; uploaded: boolean }>();
  const taskInputs = new Map<string, TaskInputs>([[state.inputs.task_id, state.inputs]]);
  const snapshot = (r: Report): ReportVersion => ({ report_id: r.report_id, version: r.published_version!, title: r.title, content: clone(r.content), files: clone(r.files), published_at: r.published_at!, published_by: clone(state.user) });
  const versions = new Map<string, ReportVersion[]>(state.reports.filter(r => r.published_version).map(r => [r.report_id, [snapshot(r)]]));
  const summaries = new Map(state.seasons.map(s => [s.season_id, { ...clone(state.summary), season_id: s.season_id }]));
  const categories = new Map(state.people.map(p => [p.user_id, { user_id: p.user_id!, category: 'junior' as 'junior' | 'activist', revision: 1, capabilities: state.global ? ['edit_participant_category'] : [] }]));
  const queueApplication = { ...clone(state.registration), user_id: 105, status: 'pending' as typeof state.registration.status, capabilities: ['reset_registration_limit'] };
  const requestCapabilities = (r: typeof state.requests[number]) => {
    if (!['pending_hr', 'pending_block'].includes(r.state)) return [];
    const expired = !!r.substitute_available_at && Date.parse(options.now ?? mockNow) >= Date.parse(r.substitute_available_at);
    const substitute = (state.chair || role === 'chair-deputy') && expired;
    return [...(r.user.user_id === state.session.user_id ? ['withdraw_request'] : []), ...(r.state === 'pending_hr' ? role === 'hr' || substitute ? ['hr_review_request'] : [] : state.blocks.find(b => b.block_id === r.block_id)?.master?.user.user_id === state.session.user_id || substitute ? ['block_review_request'] : [])];
  };
  const visibleReport = (report: Report) => { const r = clone(report); if (!r.capabilities.includes('edit_report')) { delete r.draft_title; delete r.draft_content; delete r.draft_files; } return r; };
  let sequence = 10;
  let leadership = { chair: state.people[3], deputies: [state.people[4]], revision: 1, capabilities: state.chair ? ['transfer_chair', 'manage_chair_deputies'] : [] };
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const changed = <T extends { revision: number }>(item: T) => { item.revision++; return [200, clone(item)] as Reply; };
  const mismatch = (data: Body, item: { revision: number }) => data.expected_revision !== undefined && data.expected_revision !== item.revision;
  const conflict = () => fail(409, 'revision_conflict', 'Данные изменились. Обновите страницу и повторите действие.');
  const denied = () => fail(403, 'forbidden', 'Действие недоступно');
  const filter = <T extends { season_id?: string }>(items: T[], url: URL) => url.searchParams.get('season_id') ? items.filter(x => x.season_id === url.searchParams.get('season_id')) : items;

  uploads.onAny().reply(config => {
    const fileId = config.url?.split('/').pop() ?? '';
    const file = files.get(fileId);
    if (!file) return fail(404, 'file_not_found', 'Файл не найден');
    file.uploaded = true;
    config.onUploadProgress?.({ loaded: file.size_bytes, total: file.size_bytes, bytes: file.size_bytes, lengthComputable: true, upload: true });
    return [200, ''];
  });

  adapter.onAny().reply(config => {
    const url = new URL(config.url ?? '/', 'https://mock.example');
    const path = url.pathname.replace(/^\/api(?=\/)/, '');
    Object.entries(config.params ?? {}).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, String(v)); });
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const method = (config.method ?? 'get').toLowerCase();
    const data = dataOf(config);
    if (options.scenario === 'error') return fail(503, 'unavailable', 'Сервис временно недоступен');
    if (options.scenario === 'conflict' && method !== 'get') return conflict();
    if (path === '/session') return [200, clone(state.session)];
    if (path.startsWith('/auth/')) return [200, { access_token: 'development-only', refresh_token: 'development-only', token_type: 'bearer' }];
    if (path === '/registrations/me') {
      if (method === 'patch') {
        if (state.registration.status === 'approved') return denied();
        if (mismatch(data, state.registration)) return conflict();
        state.registration.fields = clone(data.fields as typeof state.registration.fields);
        return changed(state.registration);
      }
      return [200, clone(state.registration)];
    }
    if (path === '/registrations/me/resubmit') {
      if (mismatch(data, state.registration)) return conflict();
      if (state.registration.status !== 'rejected') return conflict();
      if (state.registration.attempts_used >= 5) return fail(409, 'registration_attempt_limit', 'Исчерпан лимит отправок');
      state.registration.attempts_used++; state.registration.total_submissions++;
      state.registration.status = 'pending'; state.session.registration_status = 'pending';
      state.registration.capabilities = [];
      return changed(state.registration);
    }
    if (state.session.account_state !== 'active') return denied();
    if (path === '/profile/me' || path === `/profile/${state.profile.user_id}`) {
      if (method === 'patch') Object.assign(state.profile, data);
      return [200, clone(state.profile)];
    }
    if (path === '/contacts') return [200, state.people.map(p => ({ ...state.profile, user_id: p.user_id, name: p.display_name.split(' ')[0], surname: p.display_name.split(' ')[1], kkr_name: p.display_name, email: `member${p.user_id}@example.com` }))];
    if (path === '/contacts/emails') return [200, { emails: state.people.map(p => `member${p.user_id}@example.com`) }];
    if (path === '/leadership') return [200, clone(leadership)];
    if (path === '/leadership/transfer') {
      if (!state.chair) return denied();
      if (mismatch(data, leadership)) return conflict();
      state.session.capabilities = [];
      state.session.assignments = [];
      state.chair = false; state.global = false; state.manager = false; state.eventManager = false;
      state.events = []; state.subevents = []; state.tasks = []; state.meetings = []; state.reports = [];
      state.blocks.forEach(b => { b.capabilities = []; }); state.materials.forEach(m => { m.capabilities = []; });
      leadership = { chair: state.people.find(p => p.user_id === data.new_chair_user_id)!, deputies: [], revision: leadership.revision + 1, capabilities: [] };
      return [200, clone(leadership)];
    }
    if (path === '/leadership/deputies') {
      if (!state.chair) return denied();
      if (mismatch(data, leadership)) return conflict();
      if ((data.user_ids as number[]).length > 3) return fail(422, 'deputy_limit', 'Не более трёх заместителей');
      leadership.deputies = state.people.filter(p => (data.user_ids as number[]).includes(p.user_id!));
      leadership.revision++; return [200, clone(leadership)];
    }
    if (path === '/seasons/current') return [200, clone(state.seasons.find(s => s.is_current))];
    if (parts[0] === 'seasons') {
      if (parts.length === 1) {
        if (method === 'get') return list(options.scenario === 'empty' ? [] : clone(state.seasons));
        if (!state.chair) return denied();
        if (state.seasons.some(s => s.state === 'planned')) return fail(409, 'planned_exists', 'Ближайший следующий сезон уже подготовлен');
        const created: Season = { ...data as unknown as Season, season_id: id('season'), state: 'planned', is_current: false, sequence_number: state.seasons.length + 1, previous_season_id: state.seasons.at(-1)?.season_id ?? null, revision: 1, capabilities: ['open_season', 'edit_season'] };
        state.seasons.push(created); return [201, clone(created)];
      }
      const season = state.seasons.find(s => s.season_id === parts[1]);
      if (!season) return fail(404, 'not_found', 'Сезон не найден');
      if (parts[2] === 'summary.xlsx') return state.global ? [200, new Blob(['Synthetic export fixture'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })] : denied();
      if (parts[2] === 'summary') {
        if (!state.global) return denied();
        const summary = summaries.get(season.season_id)!;
        summary.capabilities = season.state === 'closed' ? state.chair ? ['edit_decisions', 'correct_summary'] : [] : ['edit_decisions'];
        if (parts[3] === 'correct') {
          if (!state.chair || season.state !== 'closed') return denied();
          if (data.expected_version !== summary.version) return conflict();
          const changes = data.changes as { id: string; expected_revision: number; values: object }[];
          if (changes.some(c => state.assessments.find(a => a.assignment_id === c.id)?.revision !== c.expected_revision)) return conflict();
          changes.forEach(c => { const a = state.assessments.find(a => a.assignment_id === c.id)!; Object.assign(a, c.values); a.revision++; });
          summary.version++; return [200, clone(summary)];
        }
        if (method === 'put') {
          if (season.state === 'closed' && !state.chair) return denied();
          if (data.expected_version !== summary.version) return conflict();
          const row = summary.rows.find(r => r.user.user_id === Number(parts[4]));
          if (row) row.decisions = data.decisions as Decision[];
          summary.version++;
        }
        return [200, clone(summary)];
      }
      if (parts[2] === 'master-bonuses') return state.global ? list([{ bonus_id: 'bonus-1', season_id: season.season_id, block_id: 'block-info', recipient_participant_id: 'participant-102', recipient: state.people[1], eligible_organizer_count: 1, amount: 2.5, calculation_version: 'master_bonus_v1', basis: [{ participant_id: 'participant-101', user: state.people[0], member_task_score: 10, included: true, exclusion: null }, { participant_id: 'participant-105', user: state.people[4], member_task_score: 0, included: false, exclusion: 'non_positive' }, { participant_id: 'participant-102', user: state.people[1], member_task_score: 4, included: false, exclusion: 'master' }] }]) : denied();
      if (method === 'get') return [200, clone(season)];
      if (!state.chair) return denied();
      if (mismatch(data, season)) return conflict();
      if (parts[2] === 'close') {
        const owners = [...state.events.filter(e => e.season_id === season.season_id).map(e => ({ kind: 'event', id: e.event_id, title: e.title })), ...state.subevents.filter(s => state.events.some(e => e.event_id === s.event_id && e.season_id === season.season_id)).map(s => ({ kind: 'subevent', id: s.subevent_id, title: s.title }))];
        const blockers = owners.filter(o => !state.reports.some(r => r.owner_kind === o.kind && r.owner_id === o.id && r.kind === 'final' && r.state === 'published')).map(o => ({ kind: 'missing_final_report', owner_kind: o.kind, owner_id: o.id, title: `Финальный отчёт: ${o.title}` }));
        const previous = state.seasons.find(s => s.season_id === season.previous_season_id); if (previous && previous.state !== 'closed') blockers.push({ kind: 'previous_season_not_closed', owner_kind: 'season', owner_id: previous.season_id, title: previous.title });
        state.tasks.filter(t => t.season_id === season.season_id).forEach(t => t.assignments.filter(a => !['accepted', 'not_completed', 'cancelled'].includes(a.status)).forEach(a => blockers.push({ kind: 'unfinished_assignment', owner_kind: 'assignment', owner_id: a.assignment_id, title: `${t.title}: ${a.assignee.display_name}` })));
        if (blockers.length) return fail(409, 'season_not_ready', 'Сезон пока нельзя закрыть', { blockers });
        season.state = 'closed'; season.is_current = false; season.capabilities = [];
        const summary = summaries.get(season.season_id)!; summary.state = 'approved'; summary.approved_at = mockNow; summary.version++;
        return [200, { season: clone(season), summary: clone(summary) }];
      }
      if (parts[2] === 'open') { state.seasons.forEach(s => { s.is_current = false; }); season.is_current = true; season.state = 'open'; season.capabilities = ['begin_summary', 'edit_season']; }
      else if (parts[2] === 'begin-summary') { season.state = 'summarizing'; season.capabilities = ['close_season']; }
      else Object.assign(season, data);
      return changed(season);
    }
    if (path === '/season-corrections') {
      if (!state.session.capabilities.includes('correct_season')) return denied();
      const event = state.events.find(e => e.event_id === data.object_id);
      if (!event || mismatch(data, event)) return conflict();
      if (state.seasons.find(s => s.season_id === event.season_id)?.state === 'closed' || state.seasons.find(s => s.season_id === data.target_season_id)?.state === 'closed') return conflict();
      const source = event.season_id; event.season_id = String(data.target_season_id); event.revision++;
      const subs = state.subevents.filter(s => s.event_id === event.event_id).map(s => s.subevent_id);
      state.tasks.filter(t => t.scope.kind === 'subevent' && subs.includes(t.scope.id)).forEach(t => { t.season_id = event.season_id; });
      state.reports.filter(r => r.owner_id === event.event_id || subs.includes(r.owner_id)).forEach(r => { r.season_id = event.season_id; });
      state.merits.filter(m => m.event_id === event.event_id || m.scope?.kind === 'subevent' && subs.includes(m.scope.id)).forEach(m => { m.season_id = event.season_id; });
      return [200, { object_kind: data.object_kind, object_id: data.object_id, source_season_id: source, target_season_id: event.season_id, revision: event.revision }];
    }
    if (path === '/events' && parts.length === 1) {
      if (method === 'get') return list(options.scenario === 'empty' ? [] : clone(filter(state.events, url)));
      if (!state.session.capabilities.includes('create_event')) return denied();
      const event: Event = { ...data as unknown as Event, event_id: id('event'), report_series_id: id('series'), leaders: [], starts_at: null, ends_at: null, revision: 1, capabilities: state.events[0]?.capabilities ?? [] };
      state.events.push(event); return [201, clone(event)];
    }
    if (parts[0] === 'events' || parts[0] === 'subevents') {
      const isEvent = parts[0] === 'events';
      const item = isEvent ? state.events.find(e => e.event_id === parts[1]) : state.subevents.find(s => s.subevent_id === parts[1]);
      if (!item) return fail(404, 'not_found', 'Мероприятие недоступно');
      if (parts[2] === 'meeting') {
        const kind = isEvent ? 'event' : 'subevent';
        if (isEvent && !state.eventManager) return denied();
        const meeting = state.meetings.find(m => m.owner_kind === kind && m.owner_id === parts[1]);
        if (method === 'get') return [200, clone(meeting ?? null)];
        if (!state.manager) return denied();
        if (meeting && mismatch(data, meeting)) return conflict();
        if (method === 'delete') { state.meetings = state.meetings.filter(m => m !== meeting); return [200, {}]; }
        const saved: Meeting = { ...data as unknown as Meeting, meeting_id: meeting?.meeting_id ?? id('meeting'), owner_kind: kind, owner_id: parts[1], revision: (meeting?.revision ?? 0) + 1, capabilities: ['edit_meeting', 'delete_meeting'] };
        state.meetings = [...state.meetings.filter(m => m !== meeting), saved]; return [200, clone(saved)];
      }
      if (isEvent && parts[2] === 'subevents') {
        if (method === 'get') return list(clone(state.subevents.filter(s => s.event_id === parts[1])));
        if (!state.manager) return denied();
        const sub: Subevent = { ...data as unknown as Subevent, subevent_id: id('subevent'), event_id: parts[1], leaders: [], organizer_user_ids: [], report_series_id: id('series'), revision: 1, capabilities: state.subevents[0]?.capabilities ?? [] };
        state.subevents.push(sub); return [201, clone(sub)];
      }
      if (isEvent && parts[2] === 'copy') {
        if (!state.session.capabilities.includes('create_event')) return denied();
        const event = { ...clone(item as Event), ...data, event_id: id('event'), leaders: [], revision: 1 } as Event;
        const subs = state.subevents.filter(s => s.event_id === parts[1]).map(s => ({ ...clone(s), subevent_id: id('subevent'), event_id: event.event_id, leaders: [], organizer_user_ids: [], revision: 1 }));
        state.events.push(event); state.subevents.push(...subs); return [200, { event: clone(event), subevents: clone(subs) }];
      }
      if (method === 'get') return [200, clone(item)];
      if (!state.manager) return denied();
      if (mismatch(data, item)) return conflict();
      if (parts[2] === 'leaders') item.leaders = (data.user_ids as number[]).map(uid => item.leaders.find(l => l.user.user_id === uid) ?? ({ role_assignment_id: id('leader'), user: state.people.find(p => p.user_id === uid)!, deputy_user_ids: [], revision: 1, capabilities: ['manage_deputies'] }));
      else if (parts[2] === 'organizers' && !isEvent) (item as Subevent).organizer_user_ids = data.user_ids as number[];
      else Object.assign(item, data);
      return changed(item);
    }
    if (parts[0] === 'role-assignments') {
      const leader = [...state.events, ...state.subevents, ...state.blocks].flatMap(x => 'leaders' in x ? x.leaders : x.master ? [x.master] : []).find(l => l.role_assignment_id === parts[1]);
      if (!leader || !state.manager) return denied();
      if (mismatch(data, leader)) return conflict();
      if ((data.user_ids as number[]).length > 2) return fail(422, 'deputy_limit', 'Не более двух заместителей');
      leader.deputy_user_ids = data.user_ids as number[]; return changed(leader);
    }
    if (path === '/report-series') return list([{ series_id: 'series-event-1', owner_kind: 'event', title: 'День математика', parent_series_id: null }, { series_id: 'series-sub-1', owner_kind: 'subevent', title: 'Лекции и встречи', parent_series_id: 'series-event-1' }]);
    if (path === '/tasks') {
      if (method === 'get') {
        let tasks = filter(state.tasks, url);
        if (url.searchParams.get('scope_id')) tasks = tasks.filter(t => t.scope.id === url.searchParams.get('scope_id'));
        if (url.searchParams.get('mine') === 'true') tasks = tasks.filter(t => t.assignments.some(a => a.assignee.user_id === state.session.user_id));
        if (url.searchParams.get('status')) tasks = tasks.filter(t => t.assignments.some(a => a.status === url.searchParams.get('status')));
        return list(options.scenario === 'empty' ? [] : clone(tasks));
      }
      if (!state.manager) return denied();
      const task: Task = { ...data as unknown as Task, task_id: id('task'), revision: 1, capabilities: ['edit_task', 'comment_task', 'view_assessment_inputs'], assignments: (data.assignees as { user_id: number; hours: number }[]).map(a => ({ assignment_id: id('assignment'), assignee: state.people.find(p => p.user_id === a.user_id)!, status: 'assigned', submissions: [], assignee_unavailable_reason: null, review_note: null, revision: 1, capabilities: ['review_assignment', 'view_assessment_inputs', 'edit_assessment_inputs'] })) };
      taskInputs.set(task.task_id, { task_id: task.task_id, assigned_at: mockNow, deadline_at: task.deadline_at, criteria: clone(data.criteria) as TaskInputs['criteria'], revision: 1, capabilities: ['edit_assessment_inputs'] });
      task.assignments.forEach((a, i) => state.assessments.push({ assignment_id: a.assignment_id, hours: (data.assignees as { hours: number }[])[i].hours, evaluation: null, effective_completed_at: null, revision: 1, capabilities: ['edit_assessment_inputs'] }));
      state.tasks.push(task); return [201, clone(task)];
    }
    if (parts[0] === 'tasks') {
      const task = state.tasks.find(t => t.task_id === parts[1]);
      if (!task) return fail(404, 'not_found', 'Задача недоступна');
      if (parts[2] === 'comments') {
        if (method === 'get') return list(clone(state.comments.filter(c => c.task_id === task.task_id)));
        const comment = { comment_id: id('comment'), task_id: task.task_id, author: state.user, content: publicSubmission(data.content), created_at: mockNow, updated_at: null, capabilities: ['edit_comment'] };
        state.comments.push(comment); return [201, clone(comment)];
      }
      if (parts[2] === 'assessment-inputs') {
        if (!state.manager) return denied();
        const inputs = taskInputs.get(task.task_id) ?? { ...clone(state.inputs), task_id: task.task_id, assigned_at: mockNow, deadline_at: task.deadline_at };
        taskInputs.set(task.task_id, inputs);
        if (method === 'patch') { if (mismatch(data, inputs)) return conflict(); Object.assign(inputs, data); inputs.revision++; task.deadline_at = inputs.deadline_at; }
        return [200, clone(inputs)];
      }
      if (method === 'get') return [200, clone(task)];
      if (!state.manager) return denied();
      if (mismatch(data, task)) return conflict();
      Object.assign(task, data); return changed(task);
    }
    if (path === '/assignments/unresolved') return state.manager ? list(state.tasks.flatMap(t => t.assignments.filter(a => !['accepted', 'not_completed', 'cancelled'].includes(a.status)).map(assignment => ({ assignment: clone(assignment), task_id: t.task_id, task_title: t.title, season_id: t.season_id, scope: t.scope, deadline_at: t.deadline_at })))) : denied();
    if (parts[0] === 'assignments') {
      const task = state.tasks.find(t => t.assignments.some(a => a.assignment_id === parts[1]));
      const assignment = task?.assignments.find(a => a.assignment_id === parts[1]);
      if (!task || !assignment) return fail(404, 'not_found', 'Назначение недоступно');
      if (parts[2] === 'assessment-inputs') {
        if (!state.manager) return denied();
        let assessment = state.assessments.find(a => a.assignment_id === assignment.assignment_id);
        if (!assessment) { assessment = { assignment_id: assignment.assignment_id, hours: 2, evaluation: null, effective_completed_at: null, revision: assignment.revision, capabilities: ['edit_assessment_inputs'] }; state.assessments.push(assessment); }
        if (method === 'patch') { if (mismatch(data, assessment)) return conflict(); Object.assign(assessment, data); assessment.revision++; }
        return [200, clone(assessment)];
      }
      if (mismatch(data, assignment)) return conflict();
      const own = assignment.assignee.user_id === state.session.user_id;
      if (['start', 'resume', 'request-help', 'submit'].includes(parts[2]) ? !own : !state.manager) return denied();
      if (parts[2] === 'reassign') {
        if (['accepted', 'not_completed', 'cancelled'].includes(assignment.status)) return conflict();
        const previous = clone(assignment); assignment.status = data.previous_outcome === 'cancelled' ? 'cancelled' : 'not_completed'; assignment.review_note = String(data.reason); assignment.revision++;
        const next = { ...clone(previous), assignment_id: id('assignment'), assignee: state.people.find(p => p.user_id === data.new_assignee_user_id)!, status: 'assigned' as const, submissions: [], revision: 1, assignee_unavailable_reason: null };
        const previousInputs = state.assessments.find(a => a.assignment_id === assignment.assignment_id);
        if (previousInputs) { previousInputs.evaluation = data.previous_outcome === 'cancelled' ? null : data.evaluation as 0 | -1; previousInputs.revision++; }
        state.assessments.push({ assignment_id: next.assignment_id, hours: Number(data.hours), evaluation: null, effective_completed_at: null, revision: 1, capabilities: ['edit_assessment_inputs'] });
        task.assignments.push(next); return [200, { previous_assignment: clone(assignment), assignment: clone(next) }];
      }
      const statuses: Record<string, AssignmentStatus> = { start: 'in_progress', resume: 'in_progress', 'request-help': 'help_required', submit: 'submitted', accept: 'accepted', 'request-revision': 'needs_revision', 'not-complete': 'not_completed', cancel: 'cancelled' };
      if (!statuses[parts[2]]) return fail(404, 'not_found', 'Команда не найдена');
      const allowed: Record<string, AssignmentStatus[]> = { start: ['assigned'], resume: ['help_required'], 'request-help': ['assigned', 'in_progress', 'needs_revision'], submit: ['assigned', 'in_progress', 'help_required', 'needs_revision'], accept: ['submitted'], 'request-revision': ['submitted'], 'not-complete': ['assigned', 'in_progress', 'help_required', 'submitted', 'needs_revision'], cancel: ['assigned', 'in_progress', 'help_required', 'submitted', 'needs_revision'] };
      if (!allowed[parts[2]].includes(assignment.status)) return conflict();
      assignment.status = statuses[parts[2]];
      if (data.review_note || data.reason) assignment.review_note = String(data.review_note ?? data.reason);
      if (parts[2] === 'submit') assignment.submissions.push({ submission_id: id('submission'), submitted_at: mockNow, text: publicSubmission(data.text), links: data.links as string[] ?? [], files: (data.file_ids as string[] ?? []).map(fid => files.get(fid)!).filter(Boolean).map(({ file_id, name, mime_type, size_bytes }) => ({ file_id, name, mime_type, size_bytes })) });
      const assessment = state.assessments.find(a => a.assignment_id === assignment.assignment_id);
      if (assessment && ['accept', 'not-complete', 'cancel'].includes(parts[2])) { assessment.evaluation = parts[2] === 'cancel' ? null : data.evaluation as 0 | -1 | 1 | 1.5; assessment.effective_completed_at = parts[2] === 'accept' ? assignment.submissions.at(-1)?.submitted_at ?? null : null; assessment.revision++; }
      assignment.capabilities = own && !['accepted', 'cancelled', 'not_completed'].includes(assignment.status) ? ['start_assignment', 'resume_assignment', 'request_help', 'submit_result'] : state.manager ? ['review_assignment', 'view_assessment_inputs', 'edit_assessment_inputs', 'reassign_assignment'] : [];
      return changed(assignment);
    }
    if (path === '/assessment-inputs/bulk-hours') {
      if (!state.manager) return denied();
      const items = data.items as { assignment_id: string; expected_revision: number }[];
      if (items.some(item => state.assessments.find(a => a.assignment_id === item.assignment_id)?.revision !== item.expected_revision)) return conflict();
      const changedItems = state.assessments.filter(a => items.some(i => i.assignment_id === a.assignment_id));
      changedItems.forEach(a => { a.hours = Number(data.hours); a.revision++; }); return [200, { items: clone(changedItems) }];
    }
    if (parts[0] === 'comments') {
      const comment = state.comments.find(c => c.comment_id === parts[1]);
      if (!comment || comment.author.user_id !== state.session.user_id) return denied();
      comment.content = publicSubmission(data.content); comment.updated_at = mockNow; return [200, clone(comment)];
    }
    if (parts[0] === 'reports' || path === '/report-history') {
      if (parts.length === 1) {
        if (method === 'get') return list(state.reports.filter(r => (r.state === 'published' || r.capabilities.includes('edit_report')) && (path !== '/report-history' || r.state === 'published') && (!url.searchParams.get('owner_id') || r.owner_id === url.searchParams.get('owner_id')) && (!url.searchParams.get('series_id') || r.report_series_id === url.searchParams.get('series_id')) && (!url.searchParams.get('year') || r.published_at?.startsWith(url.searchParams.get('year')!))).map(visibleReport));
        if (!state.manager) return denied();
        const report: Report = { ...data as unknown as Report, report_id: id('report'), season_id: 'season-1', report_series_id: data.owner_kind === 'event' ? 'series-event-1' : 'series-sub-1', content: publicSubmission(data.content), files: [], draft_content: publicSubmission(data.content), draft_title: String(data.title), draft_files: [], state: 'draft', published_at: null, published_version: null, revision: 1, capabilities: ['edit_report', 'publish_report', 'view_report_versions'] };
        state.reports.push(report); return [201, clone(report)];
      }
      const report = state.reports.find(r => r.report_id === parts[1]);
      if (!report) return fail(404, 'not_found', 'Отчёт недоступен');
      if (parts[2] === 'versions') return report.capabilities.includes('view_report_versions') ? list(clone(versions.get(report.report_id) ?? [])) : denied();
      if (method === 'get') return report.state === 'published' || report.capabilities.includes('edit_report') ? [200, visibleReport(report)] : denied();
      if (!report.capabilities.includes('edit_report')) return denied();
      if (mismatch(data, report)) return conflict();
      if (parts[2] === 'publish') { report.title = report.draft_title ?? report.title; report.content = clone(report.draft_content ?? report.content); report.files = clone(report.draft_files ?? report.files); report.state = 'published'; report.published_at = mockNow; report.published_version = (report.published_version ?? 0) + 1; }
      else { if (data.title) report.draft_title = String(data.title); if (data.content) report.draft_content = publicSubmission(data.content); if (data.file_ids) report.draft_files = (data.file_ids as string[]).map(fid => files.get(fid)!).filter(Boolean); }
      if (parts[2] === 'publish') versions.set(report.report_id, [...(versions.get(report.report_id) ?? []), snapshot(report)]);
      return changed(report);
    }
    if (path === '/materials') {
      if (method === 'get') return list(state.materials.filter(m => m.published_content || m.capabilities.includes('edit_material')).map(m => { const result = clone(m); if (!m.capabilities.includes('edit_material')) delete result.draft_content; return result; }));
      if (!state.session.capabilities.includes('create_material')) return denied();
      const material: Material = { ...data as unknown as Material, material_id: id('material'), owner_block_id: String(data.owner_block_id ?? '') || null, published_content: null, draft_content: publicSubmission(data.content), original_link: null, revision: 1, capabilities: ['edit_material', 'publish_material', 'delete_material'] };
      state.materials.push(material); return [201, clone(material)];
    }
    if (parts[0] === 'materials') {
      const material = state.materials.find(m => m.material_id === parts[1]);
      if (!material) return fail(404, 'not_found', 'Материал недоступен');
      if (method === 'get') { const result = clone(material); if (!material.capabilities.includes('edit_material')) delete result.draft_content; return material.published_content || material.capabilities.includes('edit_material') ? [200, result] : denied(); }
      if (!material.capabilities.includes('edit_material')) return denied();
      if (mismatch(data, material)) return conflict();
      if (method === 'delete') { state.materials = state.materials.filter(m => m !== material); return [200, {}]; }
      if (parts[2] === 'editors') return [200, { material_id: material.material_id, editor_user_ids: data.user_ids, revision: ++material.revision }];
      if (parts[2] === 'publish') material.published_content = clone(material.draft_content ?? material.published_content);
      else { if (data.content) material.draft_content = publicSubmission(data.content); if (data.title) material.title = String(data.title); if (data.description !== undefined) material.description = String(data.description); if (data.original_link !== undefined) material.original_link = data.original_link as string | null; }
      return changed(material);
    }
    if (path === '/blocks') return [200, clone(state.blocks)];
    if (parts[0] === 'blocks') {
      const block = state.blocks.find(b => b.block_id === parts[1]);
      if (!block) return fail(404, 'not_found', 'Блок не найден');
      if (method === 'get') return [200, clone(block)];
      if (parts[2] === 'leave') { block.members = block.members.filter(m => m.user.user_id !== state.session.user_id); return [200, { block_id: block.block_id, membership_state: 'left' }]; }
      if (!state.manager) return denied();
      if (mismatch(data, block)) return conflict();
      if (parts[2] === 'members') block.members = block.members.filter(m => m.user.user_id !== Number(parts[3]));
      else if (parts[2] === 'leader') block.master = { role_assignment_id: id('master'), user: state.people.find(p => p.user_id === data.user_id)!, deputy_user_ids: [], revision: 1, capabilities: ['manage_deputies'] };
      else Object.assign(block, data);
      return changed(block);
    }
    if (parts[0] === 'block-requests') {
      if (parts.length === 1 && method === 'get') return list(state.requests.map(r => ({ ...clone(r), capabilities: requestCapabilities(r) })).filter(r => r.user.user_id === state.session.user_id || r.capabilities.length));
      if (parts.length === 1) {
        if (state.requests.some(r => r.user.user_id === state.session.user_id && r.block_id === data.block_id && ['pending_hr', 'pending_block'].includes(r.state))) return conflict();
        if (state.blocks.find(b => b.block_id === data.block_id)?.members.some(m => m.user.user_id === state.session.user_id)) return conflict();
        const created = options.now ?? mockNow;
        const req = { ...clone(state.requests[0]), request_id: id('request'), user: state.user, block_id: String(data.block_id), state: 'pending_hr' as const, created_at: created, stage_entered_at: created, substitute_available_at: new Date(Date.parse(created) + 72 * 3600_000).toISOString(), revision: 1, capabilities: ['withdraw_request'] }; state.requests.push(req); return [201, clone(req)];
      }
      const req = state.requests.find(r => r.request_id === parts[1]);
      if (!req || mismatch(data, req)) return conflict();
      if (!['pending_hr', 'pending_block'].includes(req.state)) return conflict();
      const caps = requestCapabilities(req);
      if (parts[2] === 'withdraw' ? !caps.includes('withdraw_request') : !caps.includes(req.state === 'pending_hr' ? 'hr_review_request' : 'block_review_request')) return denied();
      if (parts[2] === 'block-approve' && req.state !== 'pending_block' || parts[2] === 'hr-approve' && req.state !== 'pending_hr') return conflict();
      const states = { 'hr-approve': 'pending_block', 'block-approve': 'approved', reject: 'rejected', withdraw: 'withdrawn' } as const;
      req.state = parts[2] === 'hr-approve' && state.blocks.find(b => b.block_id === req.block_id)?.is_hr ? 'approved' : states[parts[2] as keyof typeof states]; req.stage_entered_at = options.now ?? mockNow;
      req.substitute_available_at = ['pending_hr', 'pending_block'].includes(req.state) ? new Date(Date.parse(req.stage_entered_at) + 72 * 3600_000).toISOString() : null;
      req.capabilities = requestCapabilities(req);
      const block = state.blocks.find(b => b.block_id === req.block_id);
      if (req.state === 'approved' && block && !block.members.some(m => m.user.user_id === req.user.user_id)) block.members.push({ user: req.user, block_category: 'junior' });
      return changed(req);
    }
    if (parts[0] === 'registrations') {
      if (!state.session.capabilities.includes('review_registrations')) return denied();
      if (method === 'get') return list([clone(queueApplication)]);
      if (mismatch(data, queueApplication)) return conflict();
      if (parts[2] === 'reset-attempts') queueApplication.attempts_used = 0;
      else { queueApplication.status = parts[2] === 'approve' ? 'approved' : 'rejected'; queueApplication.rejection_reason = data.reason ? String(data.reason) : null; }
      return changed(queueApplication);
    }
    if (parts[0] === 'participants') {
      if (method !== 'get' && !state.global) return denied();
      const category = categories.get(Number(parts[1])); if (!category) return fail(404, 'not_found', 'Участник не найден');
      if (method === 'patch') { if (mismatch(data, category)) return conflict(); category.category = data.category as typeof category.category; category.revision++; }
      return [200, clone(category)];
    }
    if (path === '/contacts/archive') {
      if (method === 'get') return list(clone(state.former));
      if (!state.global) return denied();
      const contact = { ...data, contact_id: id('former') } as unknown as typeof state.former[number]; state.former.push(contact); return [201, clone(contact)];
    }
    if (parts[0] === 'contacts' && parts[1] === 'archive') {
      if (!state.global) return denied();
      const contact = state.former.find(c => c.contact_id === parts[2]);
      if (!contact) return fail(404, 'not_found', 'Контакт не найден');
      Object.assign(contact, data); return [200, clone(contact)];
    }
    if (path === '/avatars') return [200, { items: ['sun', 'moon', 'leaf', 'wave', 'star', 'mountain'].map(preset_id => ({ preset_id, title: preset_id, image_url: `/avatars/${preset_id}.svg` })) }];
    if (path === '/profile/me/avatar') { state.profile.photo_url = data.preset_id ? `/avatars/${data.preset_id}.svg` : '/avatars/sun.svg'; return [200, clone(state.profile)]; }
    if (path === '/accounts/archive') return state.chair ? list(clone(state.archived)) : denied();
    if (parts[0] === 'accounts') {
      if (!state.chair) return denied();
      const account = state.archived.find(a => a.user_id === Number(parts[1]));
      if (parts[2] === 'restore' && account?.master_conflicts?.length && !(data.master_conflicts as unknown[])?.length) return fail(409, 'master_conflict', 'Выберите мастера для восстановления', { master_conflicts: account.master_conflicts });
      if (parts[2] === 'restore') state.archived = state.archived.filter(a => a !== account);
      return [200, { account_state: parts[2] === 'restore' ? 'active' : 'archived' }];
    }
    if (path === '/files/upload-intents') {
      const file_id = id('file'); files.set(file_id, { file_id, name: String(data.name), mime_type: String(data.mime_type), size_bytes: Number(data.size_bytes), complete: false, uploaded: false });
      return [200, { file_id, upload_url: `https://uploads.mock.example/${file_id}`, method: 'PUT', headers: { 'Content-Type': data.mime_type }, expires_at: '2026-10-18T13:00:00Z' }];
    }
    if (parts[0] === 'files') {
      const file = files.get(parts[1]); if (!file) return fail(404, 'not_found', 'Файл не найден');
      if (parts[2] === 'complete') {
        if (!file.uploaded) return fail(409, 'upload_missing', 'Сначала загрузите файл'); file.complete = true;
        return [200, { file_id: file.file_id, name: file.name, mime_type: file.mime_type, size_bytes: file.size_bytes }];
      }
      return [200, { download_url: 'data:text/plain;charset=utf-8,Mock%20attachment', expires_at: '2026-10-18T13:00:00Z' }];
    }
    if (path === '/dashboard') return [200, { my_tasks: clone(state.tasks), upcoming_meetings: clone(state.meetings), my_blocks: clone(state.blocks), my_events: clone(state.events), actionable_requests: state.manager ? clone(state.requests) : [], unresolved_assignments: [], unread_notification_count: state.notifications.filter(n => !n.read_at).length }];
    if (path === '/calendar') return list([...state.tasks.map(t => ({ id: `calendar-${t.task_id}`, season_id: t.season_id, kind: 'task_deadline', title: t.title, starts_at: t.deadline_at, ends_at: null, target: { kind: 'task', id: t.task_id } })), ...state.meetings.map(m => ({ id: `calendar-${m.meeting_id}`, season_id: 'season-1', kind: 'meeting', title: m.title, starts_at: m.starts_at, ends_at: null, target: { kind: m.owner_kind, id: m.owner_id } }))].filter(item => (!url.searchParams.get('from') || item.starts_at >= url.searchParams.get('from')!) && (!url.searchParams.get('to') || item.starts_at <= url.searchParams.get('to')!)));
    if (path === '/notifications') return list(clone(state.notifications));
    if (parts[0] === 'notifications') { state.notifications.filter(n => parts[1] === 'read-all' || n.id === parts[1]).forEach(n => { n.read_at = mockNow; }); return [200, {}]; }
    if (path === '/assessments') return state.global ? list(state.tasks.filter(t => !url.searchParams.get('season_id') || t.season_id === url.searchParams.get('season_id')).flatMap(t => t.assignments.map(a => ({ contribution_id: `contribution-${a.assignment_id}`, season_id: t.season_id, participant_id: `participant-${a.assignee.user_id}`, user: a.assignee, source_kind: t.scope.kind === 'block' ? 'block_task' : 'subevent_task', source_id: t.scope.id, source_title: t.title, score: a.status === 'accepted' ? 12.5 : null, calculation_version: 'synthetic_fixture', assignment_inputs: clone(state.assessments.find(i => i.assignment_id === a.assignment_id)), capabilities: [] })))) : denied();
    if (path === '/merits' || parts[0] === 'merits') {
      if (!state.manager) return denied();
      if (method === 'get') return list(clone(filter(state.merits, url)));
      if (method === 'patch') { const merit = state.merits.find(m => m.merit_id === parts[1]); if (!merit || mismatch(data, merit)) return conflict(); Object.assign(merit, data); return changed(merit); }
      const merit: Merit = { ...data as unknown as Merit, merit_id: parts[1] ?? id('merit'), created_by: state.user, created_at: mockNow, revision: 1, capabilities: ['edit_assessment_inputs'] };
      state.merits.push(merit); return [201, clone(merit)];
    }
    if (path === '/guides') return [200, state.materials.map((m, i) => ({ guide_id: i + 1, title: m.title, owner_block: m.owner_block_id ? 'Инфо' : 'none', text: m.published_content?.body ?? '', description: m.description }))];
    if (parts[0] === 'guides') return [200, { guide_id: Number(parts[1]), title: 'КМБ', owner_block: 'none', text: '# КМБ\n\nМатериалы для участников', description: '' }];
    if (path === '/pgas') return [200, []];
    return fail(501, 'mock_not_implemented', `Для ${method.toUpperCase()} ${path} ещё нет сценария мока`);
  });
  return { state, adapter, restore: () => { adapter.restore(); uploads.restore(); } };
}
