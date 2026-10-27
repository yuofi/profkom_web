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
  kind: "block" | "subevent";
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
  role: string;
  scope_kind: "global" | "block" | "event" | "subevent" | "material";
  scope_id: string | null;
  principal_assignment_id?: string | null;
}
export interface Session {
  user_id: number;
  account_state: "pending" | "active" | "archived";
  registration_status: "pending" | "approved" | "rejected";
  access_revision?: string;
  capabilities: string[];
  assignments?: RoleAssignment[];
  /** A temporary password is in use: it must be changed before any work (АВ-52). */
  password_change_required?: boolean;
}
/** Shown once to the chair or deputy who handed it out; never stored by the client. */
export interface TemporaryPassword {
  user_id: number;
  email: string;
  temporary_password: string;
}
export interface Leadership extends Versioned {
  chair: UserRef;
  deputies: UserRef[];
}
export interface Leader extends Versioned {
  role_assignment_id: string;
  user: UserRef;
  deputy_user_ids: number[];
}
export type Category = "junior" | "activist";
export interface ParticipantCategory extends Versioned {
  user_id: number;
  category: Category;
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
}
export interface Block extends Versioned {
  block_id: string;
  name: string;
  is_hr: boolean;
  description: RichText;
  master: Leader | null;
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
  subevent_id: string;
  event_id: string;
  title: string;
  description: RichText;
  leaders: Leader[];
  organizer_user_ids: number[];
  report_series_id: string;
}
export interface ReportSeries {
  series_id: string;
  owner_kind: "event" | "subevent";
  title: string;
  parent_series_id: string | null;
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
  access_request_status: "pending" | "approved" | "rejected" | null;
  scope?: ScopeRef | null;
  assignable_users?: UserRef[];
  owner?: UserRef | null;
  is_private?: boolean;
  revision?: number;
  created_at?: string | null;
}
export interface TaskQueueCatalog extends Page<TaskQueue> {
  create_scopes?: (ScopeRef & { title: string })[];
}
export interface TaskQueueAccessRequest extends Versioned {
  request_id: string;
  user: UserRef;
  message: string;
  access_granted?: boolean;
  status: "pending" | "approved" | "rejected" | "revoked";
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
  from_status?: AssignmentStatus | null;
  to_status?: AssignmentStatus | null;
}
export interface Task extends Versioned {
  task_id: string;
  season_id: string;
  scope: TaskScopeRef;
  title: string;
  description: RichText;
  deadline_at: string;
  assignments: Assignment[];
  assignees?: UserRef[];
  watchers?: UserRef[];
  allowed_statuses?: AssignmentStatus[];
  task_key?: string;
  queue?: TaskQueueRef;
  parent_task?: { task_id: string; task_key: string; title: string } | null;
  parent_task_id?: string | null;
  parent_task_unavailable?: boolean;
  status?: AssignmentStatus;
  created_by?: UserRef | null;
  created_at?: string;
  updated_at?: string | null;
  scope_title?: string;
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
export interface TaskStatusChange extends Revision {
  status: AssignmentStatus;
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
  deadline_at: string;
}
export interface TaskInputs extends Versioned {
  task_id: string;
  assigned_at: string;
  deadline_at: string;
  criteria: Criteria;
}
export interface AssessmentInputs extends Versioned {
  workflow_revision?: number | null;
  workflow_status?: AssignmentStatus | null;
  assignment_id: string;
  hours: number | null;
  evaluation: -1 | 0 | 1 | 1.5 | null;
  effective_completed_at: string | null;
}
export type SourceKind =
  | "block_task"
  | "subevent_task"
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
  reason: string;
}
/** The fields PATCH /merits/{id} accepts: kind, season and scope are fixed at creation. */
export type MeritPatch = Pick<MeritCreate, "title" | "description" | "assigned_at" | "deadline_at" | "criteria" | "recipients">;
export interface Merit extends MeritCreate, Versioned {
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
}
export interface Comment {
  comment_id: string;
  task_id: string;
  author: UserRef;
  content: RichText;
  created_at: string;
  updated_at: string | null;
  capabilities: string[];
}
export interface Meeting extends Versioned {
  meeting_id: string;
  owner_kind: "event" | "subevent";
  owner_id: string;
  title: string;
  starts_at: string;
  join_url: string;
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
export type ParticipationRole = "member" | "master" | "deputy_master" | "event_leader" | "event_deputy" | "subevent_leader" | "subevent_deputy" | "organizer";
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
  master_conflicts?: { block_id: string; current_master: UserRef }[];
}
export interface TaskCreate {
  queue_id?: string;
  parent_task_id?: string | null;
  season_id: string;
  scope?: ScopeRef;
  title: string;
  description: RichText;
  deadline_at: string;
  criteria?: Criteria;
  assignees?: { user_id: number; hours?: number }[];
  watcher_user_ids?: number[];
  file_ids?: string[];
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
}
export const richText = (body = ""): RichText => ({ format: "markdown", body });
export const emptyCriteria = (): Criteria => ({
  unique: false,
  creative: false,
  external_communication: false,
  in_person: false,
  fixed_time: false,
});
