import type { Session, UserRef, Leader, Season, Event, Subevent, Block, Task, TaskInputs, AssessmentInputs, Report, Material, Meeting, Notification, RegistrationApplication, BlockRequest, SeasonSummary, FormerContact, ArchivedAccount, Merit, Comment } from '../utils/api/contract';
import { emptyCriteria, richText } from '../utils/api/contract';
import type { MeOut } from '../utils/api/types';

export const mockRoles = ['organizer', 'leader', 'hr', 'hr-deputy', 'chair', 'chair-deputy', 'editor', 'pending', 'rejected', 'archived', 'multi'] as const;
export type MockRole = typeof mockRoles[number];
export const mockRoleNames: Record<MockRole, string> = {
  organizer: 'Организатор', leader: 'Руководитель', hr: 'Мастер HR', 'hr-deputy': 'Зам мастера HR',
  chair: 'Председатель', 'chair-deputy': 'Зам председателя', editor: 'Редактор', pending: 'Ожидание одобрения',
  rejected: 'Отказ регистрации', archived: 'Архивный аккаунт', multi: 'Несколько ролей',
};
export const people: UserRef[] = [
  { user_id: 101, display_name: 'Анна Смирнова', avatar_url: null },
  { user_id: 102, display_name: 'Иван Петров', avatar_url: null },
  { user_id: 103, display_name: 'Мария Орлова', avatar_url: null },
  { user_id: 104, display_name: 'Алексей Соколов', avatar_url: null },
  { user_id: 105, display_name: 'Дарья Белова', avatar_url: null },
];
export const mockNow = '2026-10-18T12:00:00Z';
const allManagement = ['edit_event', 'manage_leaders', 'manage_deputies', 'manage_organizers', 'create_task', 'edit_task', 'review_assignment', 'view_unresolved_assignments', 'reassign_assignment', 'view_assessment_inputs', 'edit_assessment_inputs', 'create_report', 'edit_report', 'publish_report', 'edit_meeting', 'delete_meeting', 'create_volunteer_merit'];
const globalCaps = ['view_kkr', 'view_summary', 'edit_decisions', 'hr_review_request', 'block_review_request', 'edit_participant_category', 'edit_former_contacts'];
const materialCaps = ['create_material', 'edit_material', 'publish_material', 'delete_material'];
export function createFixtures(role: MockRole = 'organizer') {
  const chair = role === 'chair';
  const global = chair || role === 'chair-deputy' || role === 'hr';
  const manager = global || role === 'leader' || role === 'multi';
  const eventManager = chair || role === 'chair-deputy' || role === 'leader' || role === 'multi';
  const active = !['pending', 'rejected', 'archived'].includes(role);
  const userId = chair ? 104 : role === 'hr' ? 103 : manager ? 102 : 101;
  const user = people.find(p => p.user_id === userId)!;
  const caps = active ? [
    'read', ...(manager ? allManagement : []), ...(global ? globalCaps : []),
    ...(chair ? ['create_chair_merit'] : []),
    ...(chair || role === 'chair-deputy' ? ['create_event', 'manage_material_editors', 'correct_season', 'review_registrations'] : []),
    ...(chair ? ['transfer_chair', 'manage_chair_deputies', 'open_season', 'begin_summary', 'close_season', 'archive_account', 'restore_account'] : []),
    ...(chair || role === 'editor' || manager ? materialCaps : []),
  ] : [];
  const assignment = { role_assignment_id: `role-${role}`, role: chair ? 'chair' : role === 'hr' ? 'hr_master' : manager ? 'event_leader' : 'organizer', scope_kind: chair || role === 'hr' ? 'global' as const : 'event' as const, scope_id: chair || role === 'hr' ? null : 'event-1', revision: 1, capabilities: caps };
  const session: Session = { user_id: userId, account_state: role === 'archived' ? 'archived' : active ? 'active' : 'pending', registration_status: role === 'rejected' ? 'rejected' : active ? 'approved' : 'pending', capabilities: caps, assignments: active ? [assignment] : [] };
  const profile: MeOut = { user_id: userId, email: `member${userId}@example.com`, surname: user.display_name.split(' ')[1], name: user.display_name.split(' ')[0], patronymic: '', kkr_name: user.display_name, group_number: '321', location: 'Общежитие', blocks: 'Инфо', phone: '+79990000000', vk: 'https://vk.com/example', tg: 'https://t.me/example', budget: true, in_profcom: active, banned: false, super_user: chair, admin: manager, pgas_admin: chair, has_password: true };
  const leader: Leader = { role_assignment_id: 'leader-1', user: people[1], deputy_user_ids: [105], revision: 1, capabilities: chair || role === 'chair-deputy' ? ['manage_deputies'] : [] };
  const seasons: Season[] = [
    { season_id: 'season-previous', title: 'Лето и осень 2026', sequence_number: 1, previous_season_id: null, type: 'summer_autumn', starts_at: '2026-06-01T00:00:00Z', ends_at: '2026-10-31T20:59:59Z', state: 'open', is_current: false, revision: 1, capabilities: chair ? ['begin_summary', 'edit_season'] : [] },
    { season_id: 'season-1', title: 'Осень и зима 2026', sequence_number: 2, previous_season_id: 'season-previous', type: 'autumn_winter', starts_at: '2026-10-01T00:00:00Z', ends_at: '2027-01-31T20:59:59Z', state: 'open', is_current: true, revision: 1, capabilities: chair ? ['begin_summary', 'edit_season'] : [] },
    { season_id: 'season-next', title: 'Зима и весна 2027', sequence_number: 3, previous_season_id: 'season-1', type: 'winter_spring', starts_at: '2027-01-15T00:00:00Z', ends_at: '2027-05-31T20:59:59Z', state: 'planned', is_current: false, revision: 1, capabilities: chair ? ['open_season', 'edit_season'] : [] },
  ];
  const events: Event[] = [{ event_id: 'event-1', season_id: 'season-1', title: 'День математика', description: richText('Готовим программу и материалы вместе.'), leaders: [leader], report_series_id: 'series-event-1', starts_at: '2026-11-21T09:00:00Z', ends_at: '2026-11-21T18:00:00Z', revision: 1, capabilities: eventManager ? [...allManagement.filter(c => chair || role === 'chair-deputy' || !['manage_leaders', 'manage_deputies'].includes(c)), 'create_subevent', 'copy_event', 'create_head_merit'] : [] }];
  const subevents: Subevent[] = [{ subevent_id: 'subevent-1', event_id: 'event-1', title: 'Лекции и встречи', description: richText('Программа встреч с выпускниками.'), leaders: [{ ...leader, role_assignment_id: 'subevent-leader-1', capabilities: eventManager ? ['manage_deputies'] : [] }], organizer_user_ids: [101, 105], report_series_id: 'series-sub-1', revision: 1, capabilities: eventManager ? [...allManagement, 'edit_subevent'] : [] }];
  const blocks: Block[] = [{ block_id: 'block-info', name: 'Инфо', is_hr: false, description: richText('Рассказываем о жизни Профкома.'), master: { ...leader, role_assignment_id: 'block-master-1', capabilities: eventManager ? ['manage_deputies'] : [] }, members: [{ user: people[0], block_category: 'junior' }, { user: people[4], block_category: 'member' }], guide_material_id: 'material-1', community_url: 'https://vk.com/example', revision: 1, capabilities: ['view_tasks', 'leave_block', ...(manager ? ['create_task', 'create_volunteer_merit', 'edit_block', 'manage_deputies', 'block_review_request', 'remove_member'] : []), ...(global ? ['manage_leaders'] : [])] }];
  const tasks: Task[] = [{ task_id: 'task-1', season_id: 'season-1', scope: { kind: 'subevent', id: 'subevent-1' }, title: 'Подготовить материалы для встречи', description: richText('Соберите описание программы и список вопросов.\n\n- Проверить ссылки\n- Подготовить текст'), deadline_at: '2026-10-25T15:00:00Z', revision: 1, capabilities: ['comment_task', ...(manager ? ['edit_task', 'view_assessment_inputs', 'create_task'] : [])], assignments: [
    { assignment_id: 'assignment-1', assignee: people[0], status: 'assigned', submissions: [], assignee_unavailable_reason: null, review_note: null, revision: 1, capabilities: userId === 101 ? ['start_assignment', 'request_help', 'submit_result'] : manager ? ['review_assignment', 'view_assessment_inputs', 'edit_assessment_inputs', 'reassign_assignment'] : [] },
    { assignment_id: 'assignment-2', assignee: people[4], status: 'help_required', submissions: [], assignee_unavailable_reason: 'left_scope', review_note: null, revision: 1, capabilities: manager ? ['review_assignment', 'view_assessment_inputs', 'edit_assessment_inputs', 'reassign_assignment'] : [] },
  ] }];
  const inputs: TaskInputs = { task_id: 'task-1', assigned_at: '2026-10-18T09:00:00Z', deadline_at: tasks[0].deadline_at, criteria: emptyCriteria(), revision: 1, capabilities: manager ? ['view_assessment_inputs', 'edit_assessment_inputs'] : [] };
  const assessments: AssessmentInputs[] = tasks[0].assignments.map(a => ({ assignment_id: a.assignment_id, hours: 2, evaluation: null, effective_completed_at: null, revision: 1, capabilities: manager ? ['view_assessment_inputs', 'edit_assessment_inputs'] : [] }));
  const reports: Report[] = [{ report_id: 'report-1', owner_kind: 'subevent', owner_id: 'subevent-1', report_series_id: 'series-sub-1', season_id: 'season-1', kind: 'regular', title: 'Подготовка программы', content: richText('## Что сделали\nСогласовали тему встречи.\n\n## Проблемы\nНужна помощь с площадкой.'), files: [], state: 'published', published_at: '2026-10-17T12:00:00Z', published_version: 1, revision: 1, capabilities: ['view_report_versions', ...(eventManager ? ['edit_report', 'publish_report'] : [])], ...(eventManager ? { draft_title: 'Подготовка программы', draft_content: richText('## Что сделали\nСогласовали тему встречи.'), draft_files: [] } : {}) }];
  const materials: Material[] = [
    { material_id: 'material-1', kind: 'guide', owner_block_id: 'block-info', title: 'Гайд блока Инфо', description: 'С чего начать работу в команде', original_link: null, published_content: richText('## О работе\n**Проверяйте факты**, сохраняйте *ссылки*.\n\n- Подготовьте текст\n- Попросите обратную связь'), revision: 1, capabilities: manager ? materialCaps : [], ...(manager ? { draft_content: richText('## О работе\nЧерновик следующей версии') } : {}) },
    { material_id: 'material-kmb', kind: 'kmb', owner_block_id: null, title: 'КМБ', description: 'Материалы для новых участников', original_link: null, published_content: richText('## Добро пожаловать\nЗдесь собраны полезные материалы.'), revision: 1, capabilities: chair || role === 'editor' ? materialCaps : [] },
  ];
  const meetings: Meeting[] = [{ meeting_id: 'meeting-1', owner_kind: 'subevent', owner_id: 'subevent-1', title: 'Встреча команды', starts_at: '2026-10-23T16:00:00Z', join_url: 'https://example.com/meeting', revision: 1, capabilities: eventManager ? ['edit_meeting', 'delete_meeting'] : [] }];
  const notifications: Notification[] = [{ id: 'notification-1', kind: 'assignment', text: 'Вам назначена задача «Подготовить материалы для встречи»', created_at: mockNow, read_at: null, target: { kind: 'task', id: 'task-1' } }];
  const registration: RegistrationApplication = { user_id: userId, status: session.registration_status, attempts_used: 1, attempt_limit: 5, total_submissions: 1, rejection_reason: role === 'rejected' ? 'Уточните контактный телефон' : null, fields: { surname: profile.surname, name: profile.name, patronymic: null, group_number: '321', phone: profile.phone, email: profile.email, tg: profile.tg, vk: profile.vk, funding: 'budget', residence: profile.location }, revision: 1, capabilities: role === 'rejected' ? ['resubmit_registration'] : [] };
  const requests: BlockRequest[] = [{ request_id: 'request-1', user: people[4], block_id: 'block-info', state: 'pending_block', created_at: '2026-10-10T12:00:00Z', stage_entered_at: '2026-10-14T12:00:00Z', substitute_available_at: '2026-10-17T12:00:00Z', revision: 1, capabilities: manager ? ['block_review_request'] : [] }];
  const summary: SeasonSummary = { season_id: 'season-1', state: 'draft', version: 1, approved_at: null, capabilities: global ? ['view_summary', 'edit_decisions'] : [], rows: [
    { participant_id: 'participant-101', user: people[0], group_number: '321', category: 'junior', blocks: [{ block_id: 'block-info', name: 'Инфо' }], is_master: false, is_archived: false, source_scores: [{ source_kind: 'subevent_task', source_id: 'subevent-1', title: 'Лекции и встречи', score: 12.5 }], total_score: 12.5, evaluated_task_count: 2, rank: 1, previous_rank: 2, decisions: ['golden_red_bull', 'nice'], previous_decisions: ['kick_warning'] },
    { participant_id: 'participant-105', user: people[4], group_number: '322', category: 'activist', blocks: [], is_master: false, is_archived: true, source_scores: [], total_score: 0, evaluated_task_count: 0, rank: 2, previous_rank: null, decisions: [], previous_decisions: [] },
  ] };
  const former: FormerContact[] = [{ contact_id: 'former-1', surname: 'Волкова', name: 'Елена', phone: '+79990000001', email: 'former@example.com', tg: 'https://t.me/former', vk: 'https://vk.com/former', participation_periods: [{ from_year: 2020, to_year: 2022 }, { from_year: 2024, to_year: 2025 }] }];
  const archived: ArchivedAccount[] = [{ user_id: 110, display_name: 'Елена Волкова', archived_at: '2026-09-01T12:00:00Z', master_conflicts: [{ block_id: 'block-info', current_master: people[1] }] }];
  const merits: Merit[] = [];
  const comments: Comment[] = [{ comment_id: 'comment-1', task_id: 'task-1', author: people[1], content: richText('Если нужна помощь, напишите в комментариях.'), created_at: mockNow, updated_at: null, capabilities: userId === 102 ? ['edit_comment'] : [] }];
  return { role, user, profile, session, seasons, events, subevents, blocks, tasks, inputs, assessments, reports, materials, meetings, notifications, registration, requests, summary, former, archived, merits, comments, people, manager, eventManager, global, chair };
}
export type Fixtures = ReturnType<typeof createFixtures>;
