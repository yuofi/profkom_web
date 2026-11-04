/** API 1.3. Public, assessment-input and calculated DTOs are deliberately separate. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface Versioned {
  revision: number;
  capabilities: string[];
}
export interface Revision {
  expected_revision: number;
}
export interface RichText {
  format: "markdown";
  body: string;
}
export interface UserRef {
  user_id: number | null;
  display_name: string;
  avatar_url: string | null;
}
export interface ScopeRef {
  kind: "block" | "subevent" | "event" | "chair";
  id: string;
}
export type TaskScopeRef = ScopeRef | { kind: "queue"; id: string };
export interface FileRef {
  file_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}
export interface RoleAssignment extends Versioned {
  role_assignment_id: string;
  user_id?: number;
  role: string;
  /** `site`: a site-wide grant (bot_maintainer, broadcaster), scope_id null (BOT_API.md). */
  scope_kind: "global" | "block" | "event" | "subevent" | "material" | "site";
  scope_id: string | null;
  principal_assignment_id?: string | null;
}
export interface Session {
  user_id: number;
  account_state: "pending" | "active" | "archived";
  registration_status: "pending" | "approved" | "rejected";
  access_revision?: string;
  capabilities: string[];
  /** @deprecated Compatibility fields; permission checks use capabilities. */
  permissions?: string[];
  /** @deprecated Use capabilities and the dedicated leadership resource. */
  leadership?: { is_chair: boolean; is_deputy: boolean } | null;
  /** @deprecated Use capabilities. */
  super_user?: boolean;
  /** @deprecated Use capabilities. */
  admin?: boolean;
  /** @deprecated Use capabilities. */
  pgas_admin?: boolean;
  assignments?: RoleAssignment[];
  /** A temporary password is in use: it must be changed before any work (АВ-52). */
  password_change_required?: boolean;
  /** The VK link through HereBot (BOT_API.md, «Привязка VK»); null while the integration is
   *  off. An older server without stage 2 leaves it out, which reads as null. */
  bot_link?: SessionBotLink | null;
}
/** The state of the VK link through HereBot: only `ok` meets the requirement. */
export type BotLinkState = "none" | "ok" | "messages_denied" | "token_missing" | "token_invalid";
/** The bot's last check of the user's VK token; `unknown` (VK did not answer) does not block. */
export type BotTokenStatus = "ok" | "missing" | "invalid" | "unknown";
export interface SessionBotLink {
  state: BotLinkState;
  /** The link is already mandatory: always for a pending account, from the deadline for an active one. */
  required: boolean;
  /** An active account is closed until the link is fixed. */
  blocked: boolean;
  /** BOT_LINK_DEADLINE for active accounts, or null without it. */
  deadline: string | null;
}
/** GET /bot-link/me. With the integration off: enabled false, the rest null or false. */
export interface BotLinkMe {
  enabled: boolean;
  state: BotLinkState | null;
  vk_user_id: number | null;
  messages_allowed: boolean | null;
  token_status: BotTokenStatus | null;
  linked_at: string | null;
  required: boolean;
  blocked: boolean;
  deadline: string | null;
  /** The dialog with the bot (BOT_VK_URL), or null without the setting. */
  bot_url: string | null;
  /** The expiry of the unused code, or null. */
  code_expires_at: string | null;
}
/** POST /bot-link/code: a new one-time code; it replaces the previous one. */
export interface BotLinkCode {
  code: string;
  expires_at: string;
  /** `<BOT_VK_URL>?ref=<code>`, or null without BOT_VK_URL. */
  link_url: string | null;
  /** «привязать ABCDE-FGHJK»: the command for the bot when `ref` did not arrive. */
  command: string;
}
/** A broadcast through HereBot (BOT_API.md, «Рассылки», stage 4): `sending` while recipients
 *  wait, `done` when none does, `cancelled` when stopped while some still waited. */
export type BroadcastState = "sending" | "done" | "cancelled";
/** Recipients in VK by state; only readers with `broadcast.send` get them. */
export interface BroadcastCounts {
  total: number;
  pending: number;
  sent: number;
  /** VK answered 901: messages from the community are not allowed. */
  denied: number;
  failed: number;
  cancelled: number;
  /** Not sent within 24 hours. */
  expired: number;
}
/** BroadcastOut: GET /broadcasts/{id} for any active account, the list and the commands. */
export interface Broadcast {
  broadcast_id: string;
  text: string;
  /** null once the author's account was deleted by retention. */
  author: UserRef | null;
  created_at: string;
  state: BroadcastState;
  cancelled_at: string | null;
  /** null without the right to send broadcasts. */
  counts: BroadcastCounts | null;
}
/** GET /broadcasts/audience: active accounts that get the site notice (the author excluded)
 *  and how many of them the broadcast reaches in VK. */
export interface BroadcastAudience {
  total: number;
  reachable: number;
}
/** POST /broadcasts: 1–4000 characters after trimming; the key is a UUID (GL-07). */
export interface BroadcastInput {
  text: string;
  idempotency_key: string;
}
/** PUT /broadcasts/senders/{user_id}. */
export interface BroadcastSenderChange {
  user_id: number;
  sender: boolean;
}
/** Shown once to the chair or deputy who handed it out; never stored by the client. */
export interface TemporaryPassword {
  user_id: number;
  email: string;
  temporary_password: string;
}
export interface Leadership extends Versioned {
  chair: UserRef | null;
  deputies: UserRef[];
}
export interface Leader extends Versioned {
  role_assignment_id: string;
  user: UserRef;
  deputy_user_ids: number[];
  /** With include_deputies=true: the deputies in deputy_user_ids order, under the policy of `user`. */
  deputies?: UserRef[];
}
export type Category = "junior" | "activist";
export interface ParticipantCategory extends Versioned {
  user_id: number;
  category: Category;
}
export interface ParticipantCategoryBatch {
  items: ParticipantCategory[];
}
export interface RegistrationFields {
  surname: string;
  name: string;
  patronymic: string | null;
  group_number: string;
  phone: string;
  email: string;
  tg: string;
  vk: string;
  /** null: not chosen yet (a VK application, decision 28); approval needs a choice. */
  funding: "budget" | "contract" | null;
  residence: string;
}
export interface RegistrationApplication extends Versioned {
  user_id: number;
  status: "pending" | "approved" | "rejected";
  attempts_used: number;
  attempt_limit: 5;
  total_submissions: number;
  rejection_reason: string | null;
  fields: RegistrationFields;
  /** The applicant's VK link (stage 2); null while the integration is off. A pending
   *  application is ready for review only with all fields and state `ok`. */
  bot_link?: ApplicationBotLink | null;
}
export interface ApplicationBotLink {
  state: BotLinkState;
  /** null while nothing is linked. */
  vk_user_id: number | null;
}
export interface BlockRequest extends Versioned {
  request_id: string;
  user: UserRef;
  block_id: string;
  state: "pending_hr" | "pending_block" | "approved" | "rejected" | "withdrawn";
  created_at: string;
  stage_entered_at: string;
  substitute_available_at: string | null;
  /** A closed request: when it was decided and, for a rejection, why (decision 16). */
  decided_at?: string | null;
  decision_reason?: string | null;
  approvals: { stage: "hr" | "block"; actor: UserRef | null; at: string | null; substitute: boolean }[];
}
export interface BlockRef {
  block_id: string;
  name: string;
  avatar_url?: string | null;
}
export interface Block extends Versioned, BlockRef {
  block_id: string;
  name: string;
  is_hr: boolean;
  description: RichText;
  master: Leader | null;
  /** Scoped HR curator; this service role does not imply ordinary block membership. */
  hr?: UserRef | null;
  members: { user: UserRef; block_category: "junior" | "member" }[];
  guide_material_id: string | null;
  community_url: string | null;
}
export type SeasonState = "planned" | "open" | "summarizing" | "closed";
export interface Season extends Versioned {
  season_id: string;
  title: string;
  sequence_number: number;
  previous_season_id: string | null;
  type: "winter_spring" | "summer_autumn" | "autumn_winter";
  starts_at: string;
  ends_at: string;
  state: SeasonState;
  is_current: boolean;
}
export interface Event extends Versioned {
  all_day?: boolean;
  is_closed?: boolean;
  closed_at?: string | null;
  event_id: string;
  season_id: string;
  title: string;
  description: RichText;
  leaders: Leader[];
  report_series_id: string;
  starts_at: string | null;
  ends_at: string | null;
}
export interface Subevent extends Versioned {
  /** The parent event's title for breadcrumbs, without rereading the event. */
  event_title?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  all_day?: boolean;
  announcement?: RichText;
  working_access?: boolean;
  outside_parent_dates?: boolean;
  hr?: UserRef | null;
  organizers?: UserRef[];
  subevent_id: string;
  event_id: string;
  title: string;
  description: RichText;
  leaders: Leader[];
  organizer_user_ids: number[];
  report_series_id: string | null;
}
export interface ReportSeries {
  series_id: string;
  owner_kind: "event" | "subevent";
  title: string;
  parent_series_id: string | null;
}
/** GET /report-series/continuable: a series a new event (or a new subevent of the parent)
 *  may continue, with its latest instance the reader can open; null when there is none. */
export interface ContinuableSeries extends ReportSeries {
  latest: { title: string; season_id: string; season_title: string | null } | null;
}
export interface Criteria {
  unique: boolean;
  creative: boolean;
  external_communication: boolean;
  in_person: boolean;
  fixed_time: boolean;
}
export type AssignmentStatus =
  | "assigned"
  | "in_progress"
  | "help_required"
  | "submitted"
  | "accepted"
  | "needs_revision"
  | "not_completed"
  | "cancelled";
export interface Submission {
  submission_id: string;
  submitted_at: string;
  text: RichText;
  links: string[];
  files: FileRef[];
}
export interface Assignment extends Versioned {
  assignment_id: string;
  assignee: UserRef;
  status: AssignmentStatus;
  submissions: Submission[];
  assignee_unavailable_reason: "left_scope" | "archived" | null;
  review_note: string | null;
}
export interface TaskSubmission extends Submission {
  submitted_by?: UserRef | null;
}
export interface TaskQueueRef {
  queue_id: string;
  name: string;
  key: string;
}
export interface TaskQueue extends TaskQueueRef {
  access: "granted" | "locked";
  capabilities: string[];
  can_request_access: boolean;
  access_request_status: "pending" | "approved" | "rejected" | "cancelled" | null;
  access_request_id?: string | null;
  access_request_revision?: number | null;
  scope?: ScopeRef | null;
  /** Detail/create/update only. The catalogue does not calculate candidates. */
  assignable_users?: UserRef[];
  owner?: UserRef | null;
  is_private?: boolean;
  revision?: number;
  created_at?: string | null;
  owner_unavailable?: boolean;
}
export interface TaskQueueCatalog extends Page<TaskQueue> {
  can_create_queue?: boolean;
  create_scopes?: (ScopeRef & { title: string })[];
}
export interface TaskQueueAccessRequest extends Versioned {
  request_id: string;
  user: UserRef;
  message: string;
  access_granted?: boolean;
  status: "pending" | "approved" | "rejected" | "revoked" | "cancelled";
  created_at: string;
}
export interface TaskHistoryChange {
  field: string;
  label?: string;
  before: string | string[] | null;
  after: string | string[] | null;
  before_users?: UserRef[];
  after_users?: UserRef[];
}
export interface TaskHistoryEvent {
  event_id: string;
  kind: string;
  created_at: string;
  actor: UserRef | null;
  description: string;
  changes?: TaskHistoryChange[];
  from_status?: AssignmentStatus | TaskPublicStatus | null;
  to_status?: AssignmentStatus | TaskPublicStatus | null;
}
export interface TaskMentionRequest {
  request_id:string;task_id:string;task_key:string|null;target:UserRef|null;requested_by:UserRef|null;
  comment_id:string|null;status:"pending"|"approved"|"rejected";created_at:string;revision:number;capabilities:string[];
}
/** A person offered by GET /tasks/{id}/mention-candidates. */
export interface TaskCandidate extends UserRef {
  /** Reads the task already, or the actor approves access: assigning is accepted. */
  can_assign: boolean;
}
export type TaskPublicStatus = "open" | "in_progress" | "completed" | "closed";
export type TaskType = "task" | "milestone" | "epic";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export interface TaskChecklistItem { item_id: string; text: string; checked: boolean }
export interface TaskChecklistInput { item_id?: string; text: string; checked: boolean }
export interface TrackerTaskRef {
  task_id: string; task_key: string; title: string; status: TaskPublicStatus;
  deadline_at: string | null; starts_at: string | null; task_type: TaskType;
}
export type TaskLinkKind = "related" | "blocks" | "blocked_by" | "epic" | "epic_member" | "milestone" | "milestone_member";
export interface TaskLink { link_id: string; kind: TaskLinkKind; task: TrackerTaskRef; managed?: boolean }
export interface TaskPlanning {
  task_type: TaskType; priority: TaskPriority; starts_at: string | null;
}
export interface TaskPublicPatch extends Partial<TaskPlanning> {
  title?: string; description?: RichText; file_ids?: string[]; parent_task_id?: string | null;
  checklist?: TaskChecklistInput[];
}
export interface Task extends Versioned {
  task_type?: TaskType;
  priority?: TaskPriority;
  starts_at?: string | null;
  is_favorite?: boolean;
  checklist?: TaskChecklistItem[];
  links?: TaskLink[];
  children?: TrackerTaskRef[];
  task_id: string;
  season_id: string | null;
  scope: TaskScopeRef;
  title: string;
  description: RichText;
  deadline_at: string | null;
  assignments: Assignment[];
  assignees?: UserRef[];
  watchers?: UserRef[];
  allowed_statuses?: TaskPublicStatus[];
  task_key?: string;
  /** readable: the queue page opens for this user; a reader of one task may not read its queue. */
  queue?: TaskQueueRef & { readable?: boolean };
  parent_task?: { task_id: string; task_key: string; title: string } | null;
  parent_task_id?: string | null;
  parent_task_unavailable?: boolean;
  status?: TaskPublicStatus;
  created_by?: UserRef | null;
  created_at?: string;
  updated_at?: string | null;
  closed_at?: string | null;
  scope_title?: string;
  scope_avatar_url?: string | null;
  attachments?: FileRef[];
  submissions?: TaskSubmission[];
  legacy_status_conflict?: boolean;
  legacy_mixed_statuses?: boolean;
}
export interface TaskListPageResponse extends Page<Task> {
  total?: number;
  scopes?: (ScopeRef & { title: string })[];
  assignees?: UserRef[];
}
/** GET /tasks/facets: the list facets of one selection, for the open filter panel. */
export interface TaskFacets {
  scopes: (ScopeRef & { title: string })[];
  assignees: UserRef[];
}
/** GET /task-queues/create-access: some catalogue queue offers create_task. */
export interface TaskCreateAccess {
  can_create_task: boolean;
}
export interface TaskStatusChange extends Revision {
  status: TaskPublicStatus | AssignmentStatus;
  message?: RichText;
  text?: RichText;
  links?: string[];
  file_ids?: string[];
  evaluation?: -1 | 0 | 1 | 1.5;
  evaluations?: { assignment_id: string; evaluation: -1 | 0 | 1 | 1.5 }[];
  review_note?: string;
  reason?: string;
}
export interface UnresolvedAssignment {
  assignment: Assignment;
  task_id: string;
  task_title: string;
  season_id: string;
  scope: ScopeRef;
  deadline_at: string | null;
  scope_title?: string;
  scope_avatar_url?: string | null;
  /** Public task status; the accounting dialog opens only for a closed task. */
  task_status?: TaskPublicStatus | null;
}
/** GET /assignments/unresolved: one keyset page; `total` (all matching rows) with include_total. */
export interface UnresolvedAssignmentPage extends Page<UnresolvedAssignment> {
  total?: number;
}
export interface TaskInputs extends Versioned {
  task_id: string;
  assigned_at: string;
  deadline_at: string | null;
  criteria: Criteria;
}
export interface AssessmentInputs extends Versioned {
  workflow_revision?: number | null;
  workflow_status?: AssignmentStatus | null;
  assignment_id: string;
  /** With include_task_ids=true on /assessments: the task when the reader may open it. */
  task_id?: string | null;
  hours: number | null;
  evaluation: -1 | 0 | 1 | 1.5 | null;
  effective_completed_at: string | null;
}
export type SourceKind =
  | "block_task"
  | "subevent_task"
  | "event_task"
  | "chair_task"
  | "head_merit"
  | "chair_merit"
  | "block_volunteer"
  | "subevent_volunteer"
  | "master_bonus";
export interface Contribution {
  contribution_id: string;
  season_id: string;
  participant_id: string;
  user: UserRef;
  source_kind: SourceKind;
  source_id: string;
  source_title: string;
  score: number | null;
  calculation_version: string;
  assignment_inputs?: AssessmentInputs | null;
  merit_id?: string | null;
  bonus_id?: string | null;
  capabilities: string[];
}
export interface MeritCreate {
  season_id: string;
  source_kind:
    | "head_merit"
    | "chair_merit"
    | "block_volunteer"
    | "subevent_volunteer";
  event_id?: string | null;
  scope?: ScopeRef | null;
  title: string;
  description: RichText;
  assigned_at: string;
  deadline_at: string;
  criteria: Criteria;
  recipients: {
    user_id: number;
    hours: number;
    evaluation: -1 | 0 | 1 | 1.5;
    completed_at: string | null;
  }[];
  reason?: string;
}
/** GET /merits/contexts: the merit forms' scopes with only their merit capabilities. */
export interface MeritContexts {
  blocks: (BlockRef & { avatar_url: string | null; capabilities: string[] })[];
  events: { event_id: string; season_id: string; title: string; capabilities: string[] }[];
  subevents: { subevent_id: string; event_id: string; title: string; capabilities: string[] }[];
}
/** The fields PATCH /merits/{id} accepts: kind, season and scope are fixed at creation. */
export type MeritPatch = Pick<MeritCreate, "title" | "description" | "assigned_at" | "deadline_at" | "criteria" | "recipients">;
export interface Merit extends MeritCreate, Versioned {
  reason: string;
  merit_id: string;
  created_by: UserRef;
  created_at: string;
}
export type Decision = "golden_red_bull" | "kick_warning" | "kick" | "nice";
export interface SummaryRow {
  participant_id: string;
  user: UserRef;
  group_number: string;
  category: Category;
  blocks: { block_id: string; name: string }[];
  is_master: boolean;
  is_archived: boolean;
  source_scores: {
    source_kind: SourceKind;
    source_id: string;
    title: string;
    score: number;
  }[];
  total_score: number;
  evaluated_task_count: number;
  rank: number;
  previous_rank: number | null;
  decisions: Decision[];
  previous_decisions: Decision[];
}
export interface SeasonAnalyticsTotals {
  completed_tasks: number | null;
  credited_hours: number | null;
  kkr: number | null;
}
export interface SeasonAnalyticsBasis {
  kind: "current_ledger" | "approved_snapshot" | "unavailable";
  version: number | null;
  approved_at: string | null;
}
export interface SeasonAnalytics {
  season: Pick<Season, "season_id" | "title" | "state" | "starts_at" | "ends_at">;
  as_of: string;
  basis: SeasonAnalyticsBasis;
  filters: { participant_id: string | null; block_id: string | null };
  participants: { participant_id: string; user: UserRef }[];
  blocks: { block_id: string; name: string }[];
  totals: SeasonAnalyticsTotals;
  weekly: (SeasonAnalyticsTotals & { starts_on: string })[];
  unallocated: SeasonAnalyticsTotals & { contribution_count: number | null };
  source_breakdown: { source_kind: SourceKind | "unallocated"; kkr: number | null; contribution_count: number | null }[];
  season_comparison: {
    season_id: string; title: string; state: Season["state"]; starts_at: string; ends_at: string;
    basis: SeasonAnalyticsBasis; totals: SeasonAnalyticsTotals;
  }[];
  coverage: {
    accepted_assignments: number | null; missing_hours_assignments: number | null;
    undated_accepted_assignments: number | null; undated_contributions: number | null; notes: string[];
  };
}
export interface SeasonSummary {
  season_id: string;
  state: "draft" | "approved";
  version: number;
  approved_at: string | null;
  rows: SummaryRow[];
  capabilities: string[];
}
export interface SummaryVersionMetadata {
  version: number;
  changed_by: UserRef;
  changed_at: string;
  reason: string;
  previous_summary_version: number | null;
}
export interface SummaryVersionSnapshot extends SummaryVersionMetadata {
  summary: SeasonSummary;
  contributions: Pick<Contribution, "contribution_id" | "participant_id" | "source_kind" | "source_id" | "source_title" | "score" | "calculation_version">[];
  master_bonuses: Pick<MasterBonus, "bonus_id" | "recipient_participant_id" | "basis" | "amount" | "calculation_version">[];
}
export interface MasterBonus {
  bonus_id: string;
  season_id: string;
  block_id: string;
  recipient_participant_id: string | null;
  recipient: UserRef | null;
  eligible_organizer_count: number;
  amount: number;
  basis: {
    participant_id: string;
    user: UserRef;
    member_task_score: number;
    included: boolean;
    exclusion: "master" | "non_positive" | null;
  }[];
  calculation_version: "master_bonus_v1";
  is_final?: boolean;
}
export interface Report extends Versioned {
  report_id: string;
  owner_kind: "event" | "subevent";
  owner_id: string;
  report_series_id: string;
  season_id: string;
  kind: "regular" | "final";
  title: string;
  content: RichText;
  files: FileRef[];
  draft_title?: string;
  draft_content?: RichText;
  draft_files?: FileRef[];
  state: "draft" | "published";
  published_at: string | null;
  published_version: number | null;
  /** The owner event's or subevent's title, to name and link it. */
  owner_title?: string;
}
export interface ReportVersion {
  report_id: string;
  version: number;
  title: string;
  content: RichText;
  files: FileRef[];
  published_at: string;
  published_by: UserRef;
}
export interface Material extends Versioned {
  deleted_at?: string | null;
  placeholder?: boolean;
  community_url?: string | null;
  editor_user_ids?: number[];
  material_id: string;
  kind: string;
  owner_block_id: string | null;
  title: string;
  description: string;
  original_link: string | null;
  published_content: RichText | null;
  draft_content?: RichText;
  /** Editors only: the stored text with file:<id> links, never signed URLs. */
  source_content?: RichText;
  /** Block guides only: "block" reads to the block and the chair's team, "everyone" to all. */
  audience?: "block" | "everyone";
  /** When the readers' version was published; null for older publications. */
  published_at?: string | null;
}
export interface Comment {
  comment_id: string;
  attachments: FileRef[];
  task_id: string;
  author: UserRef;
  content: RichText;
  created_at: string;
  updated_at: string | null;
  history?: { content: RichText; edited_at: string; attachments?: FileRef[] }[];
  capabilities: string[];
  /** Safe current identities for canonical local profile links; never an access grant. */
  mentioned_users?: UserRef[];
}
export interface Meeting extends Versioned {
  meeting_id: string;
  owner_kind: "event" | "subevent";
  owner_id: string;
  title: string;
  starts_at: string;
  join_url: string;
}
/** A child team's announcement readable by the actor (GET /events/{id}/meetings). */
export interface TeamMeeting {
  subevent_id: string;
  subevent_title: string;
  meeting: Meeting;
}
export interface Target {
  kind: string;
  id: string;
}
export interface Notification {
  id: string;
  kind: string;
  text: string;
  created_at: string;
  read_at: string | null;
  target: Target | null;
}
export interface CalendarItem {
  all_day?: boolean;
  task_key?: string | null;
  scope?: TaskScopeRef | null;
  queue?: { queue_id: string; name: string; key: string } | null;
  status?: TaskPublicStatus | AssignmentStatus | null;
  event_id?: string | null;
  id: string;
  season_id: string;
  kind: "task_deadline" | "meeting" | "event";
  title: string;
  starts_at: string;
  ends_at: string | null;
  target: Target;
}
export interface Dashboard {
  my_tasks: Task[];
  upcoming_meetings: Meeting[];
  my_blocks: Block[];
  my_events: Event[];
  actionable_requests: BlockRequest[];
  unresolved_assignments: UnresolvedAssignment[];
  unread_notification_count: number;
  /** Waiting registrations; 0 without review_registrations (A-ROL-21). */
  pending_registration_count: number;
}
export type ParticipationRole = "member" | "master" | "deputy_master" | "event_leader" | "event_deputy" | "subevent_leader" | "subevent_deputy" | "organizer" | "subevent_hr";
export interface Participation {
  blocks: { block_id: string; name: string; roles: ParticipationRole[] }[];
  events: { event_id: string; title: string; season_id: string; roles: ParticipationRole[] }[];
}
export interface UploadIntent {
  file_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: string;
}
export interface UploadIntentCreate {
  owner_kind: string;
  owner_id?: string;
  purpose: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}
export interface AvatarPreset {
  preset_id: string;
  title: string;
  image_url: string;
}
export interface FormerContact {
  contact_id: string;
  revision: number;
  capabilities: string[];
  surname: string;
  name: string;
  patronymic?: string | null;
  phone: string;
  email: string;
  tg: string;
  vk: string;
  participation_periods: { from_year: number; to_year: number }[];
}
export interface ArchivedAccount {
  user_id: number;
  display_name: string;
  archived_at: string;
  master_conflicts?: { block_id: string; block_name?: string; current_master: UserRef }[];
  /** restore_account: absent for a deputy chair unless the viewer is the chair (PE-01). */
  capabilities?: string[];
}
export interface TaskCreate {
  task_type?: TaskType;
  priority?: TaskPriority;
  starts_at?: string | null;
  checklist?: TaskChecklistInput[];
  queue_id?: string;
  parent_task_id?: string | null;
  season_id: string;
  scope?: ScopeRef;
  title: string;
  description: RichText;
  deadline_at: string | null;
  criteria?: Criteria;
  assignees?: { user_id: number; hours?: number }[];
  watcher_user_ids?: number[];
  file_ids?: string[];
  /** A UUID: a repeat with the same key returns the task created by the first request. */
  idempotency_key?: string;
}
export interface SeasonBlocker {
  kind:
    | "unfinished_assignment"
    | "missing_assessment"
    | "missing_final_report"
    | "previous_season_not_closed";
  owner_kind: string;
  owner_id: string;
  /** Technical English; the screen builds its line from kind, subject and assignee. */
  title: string;
  subject?: string | null;
  assignee?: string | null;
  /** The task of a readable assignment blocker (readiness with include_task_ids=true). */
  task_id?: string | null;
}
export interface SeasonReadiness {
  ready: boolean;
  blockers: SeasonBlocker[];
  revision: number;
}
export const richText = (body = ""): RichText => ({ format: "markdown", body });
export const emptyCriteria = (): Criteria => ({
  unique: false,
  creative: false,
  external_communication: false,
  in_person: false,
  fixed_time: false,
});
