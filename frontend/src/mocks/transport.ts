/** Development/test transport. Synthetic state is discarded on reload; no KKR calculations. */
import { publicStatus } from "../pages/Workspace/trackerStatus";
import axios, { type AxiosRequestConfig } from "axios";
import MockAdapter from "axios-mock-adapter";
import { api } from "../utils/api";
import { createFixtures, mockNow, type MockRole } from "./fixtures";
import { profileFeatureMock } from "./profileFeatures";
import {
  richText,
  type AssignmentStatus,
  type TaskPublicStatus,
  type Event,
  type Subevent,
  type Task,
  type TaskInputs,
  type TaskHistoryEvent,
  type TaskHistoryChange,
  type TaskQueue,
  type TaskQueueCatalog,
  type TaskQueueAccessRequest,
  type TaskChecklistItem,
  type TaskLinkKind,
  type TrackerTaskRef,
  type TaskMentionRequest,
  type Report,
  type ReportVersion,
  type Material,
  type FileRef,
  type Meeting,
  type Merit,
  type Decision,
  type Season,
  type SeasonBlocker,
  type SeasonAnalytics,
  type SummaryVersionSnapshot,
  type ParticipationRole,
  type CalendarItem,
} from "../utils/api/contract";

type Reply = [number, unknown];
type Body = Record<string, unknown>;
const fail = (
  status: number,
  code: string,
  message: string,
  fields?: object,
): Reply => [status, { detail: { code, message, fields } }];
const list = <T>(items: T[]): Reply => [200, { items, next_cursor: null }];
const dataOf = (config: AxiosRequestConfig): Body =>
  typeof config.data === "string"
    ? (JSON.parse(config.data) as Body)
    : ((config.data ?? {}) as Body);
const clone = <T>(value: T): T => structuredClone(value);
/** As on the server: a command accepts exactly its own fields besides expected_revision. */
const extraInputs = (data: Body, accepted: string[]): Reply | undefined => {
  const extra = Object.keys(data).filter((key) => key !== "expected_revision" && !accepted.includes(key));
  return extra.length
    ? fail(422, "invalid_input", "Проверьте поля формы", {
        errors: extra.map((key) => ({ loc: ["body", key], msg: "Extra inputs are not permitted" })),
      })
    : undefined;
};
const publicSubmission = (text: unknown) =>
  typeof text === "object" && text
    ? (text as ReturnType<typeof richText>)
    : richText(String(text ?? ""));

export function installMockTransport(
  role: MockRole = "organizer",
  options: {
    delay?: number;
    scenario?: "normal" | "empty" | "error" | "conflict";
    now?: string;
  } = {},
) {
  const state = createFixtures(role);
  const commentMentions = (body: string) => {
    const prose = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, "").replace(/^(?: {4}|\t).*$/gm, "").replace(/(`+)[\s\S]*?\1(?!`)/g, "");
    const ids = new Set([...prose.matchAll(/(?<!!|\\)\[(?:\\.|[^\]\\\n])*\]\(\/contacts\/([1-9][0-9]*)\)/g)].map(match => Number(match[1])));
    return clone(state.people.filter(person => person.user_id !== null && ids.has(person.user_id)));
  };

  const profileFeatures = profileFeatureMock(state, () => taskHistory);
  if (options.scenario === "empty") {
    state.tasks = [];
    state.events = [];
    state.subevents = [];
    state.blocks = [];
    state.reports = [];
    state.meetings = [];
    state.materials = [];
    state.notifications = [];
    state.requests = [];
    state.former = [];
    state.archived = [];
    state.comments = [];
    state.summary.rows = [];
  }
  const adapter = new MockAdapter(api, { delayResponse: options.delay ?? 100 });
  const uploads = new MockAdapter(axios);
  const files = new Map<
    string,
    FileRef & { complete: boolean; uploaded: boolean; owner_kind?: string; owner_id?: string; purpose?: string; uploaded_by_user_id?: number }
  >();
  const commentFiles=(ids:unknown,taskId:string,previous:FileRef[]=[]):FileRef[]|null=>{
    if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length)return null;
    const result:FileRef[]=[];
    for(const id of ids){
      if(typeof id!=="string")return null;
      const kept=previous.find(file=>file.file_id===id);if(kept){result.push(clone(kept));continue;}
      const file=files.get(id);if(!file?.complete||file.owner_kind!=="task"||file.owner_id!==taskId||file.purpose!=="comment"||file.uploaded_by_user_id!==state.session.user_id)return null;
      result.push({file_id:file.file_id,name:file.name,mime_type:file.mime_type,size_bytes:file.size_bytes});
    }
    return result;
  };
  const taskInputs = new Map<string, TaskInputs>([
    [state.inputs.task_id, state.inputs],
  ]);
  const legacyMaterialIds = new Map(state.materials.map((material, index) => [index + 1, material.material_id]));
  const snapshot = (r: Report): ReportVersion => ({
    report_id: r.report_id,
    version: r.published_version!,
    title: r.title,
    content: clone(r.content),
    files: clone(r.files),
    published_at: r.published_at!,
    published_by: clone(state.user),
  });
  const versions = new Map<string, ReportVersion[]>(
    state.reports
      .filter((r) => r.published_version)
      .map((r) => [r.report_id, [snapshot(r)]]),
  );
  const summaries = new Map(
    state.seasons.map((s) => [
      s.season_id,
      { ...clone(state.summary), season_id: s.season_id },
    ]),
  );
  const summaryVersions = new Map<string, SummaryVersionSnapshot[]>();
  const rememberSummary = (seasonId: string, reason: string) => {
    const summary = summaries.get(seasonId)!;
    const history = summaryVersions.get(seasonId) ?? [];
    if (history.some(v => v.version === summary.version)) return;
    history.unshift({ version: summary.version, changed_by: clone(state.user), changed_at: mockNow,
      reason, previous_summary_version: null,
      summary: { ...clone(summary), capabilities: ["view_summary"] },
      contributions: summary.rows.flatMap(row => row.source_scores.map((c, index) => ({
        contribution_id: `${row.participant_id}-${index}`, participant_id: row.participant_id,
        source_kind: c.source_kind, source_id: c.source_id, source_title: c.title, score: c.score, calculation_version: "fixture_v1",
      }))), master_bonuses: [] });
    summaryVersions.set(seasonId, history);
  };
  const pgasAdmins = new Set<number>([102]);
  const categories = new Map(
    state.people.map((p) => [
      p.user_id,
      {
        user_id: p.user_id!,
        category: "junior" as "junior" | "activist",
        revision: 1,
        capabilities: state.global ? ["edit_participant_category"] : [],
      },
    ]),
  );
  const queueApplication = {
    ...clone(state.registration),
    user_id: 105,
    status: "pending" as typeof state.registration.status,
    capabilities: ["reset_registration_limit"],
  };
  // Public profile projection: current team identities/roles only. Never copy
  // task, private accounting or target-user capabilities into this resource.
  const participantTeams = (uid: number) => ({
    blocks: state.blocks.flatMap(block => {
      const roles: ParticipationRole[] = [];
      if (block.master?.user.user_id === uid) roles.push("master");
      if (block.master?.deputy_user_ids.includes(uid)) roles.push("deputy_master");
      if (block.members.some(member => member.user.user_id === uid)) roles.push("member");
      return roles.length ? [{ block_id: block.block_id, name: block.name, roles }] : [];
    }),
    events: state.events.flatMap(event => {
      if (state.seasons.find(season => season.season_id === event.season_id)?.state === "closed") return [];
      const roles: ParticipationRole[] = [];
      if (event.leaders.some(leader => leader.user.user_id === uid)) roles.push("event_leader");
      if (event.leaders.some(leader => leader.deputy_user_ids.includes(uid))) roles.push("event_deputy");
      for (const subevent of state.subevents.filter(item => item.event_id === event.event_id)) {
        if (subevent.leaders.some(leader => leader.user.user_id === uid)) roles.push("subevent_leader");
        if (subevent.leaders.some(leader => leader.deputy_user_ids.includes(uid))) roles.push("subevent_deputy");
        if (subevent.organizer_user_ids.includes(uid)) roles.push("organizer");
        if (subevent.hr?.user_id === uid) roles.push("subevent_hr");
      }
      return roles.length ? [{ event_id: event.event_id, title: event.title, season_id: event.season_id, roles: [...new Set(roles)] }] : [];
    }),
  });
  const requestCapabilities = (r: (typeof state.requests)[number]) => {
    if (!["pending_hr", "pending_block"].includes(r.state)) return [];
    const expired =
      !!r.substitute_available_at &&
      Date.parse(options.now ?? mockNow) >=
        Date.parse(r.substitute_available_at);
    const substitute = (state.chair || role === "chair-deputy") && expired;
    return [
      ...(r.user.user_id === state.session.user_id ? ["withdraw_request"] : []),
      ...(r.state === "pending_hr"
        ? role === "hr" || substitute
          ? ["hr_review_request"]
          : []
        : state.blocks.find((b) => b.block_id === r.block_id)?.master?.user
              .user_id === state.session.user_id || substitute
          ? ["block_review_request"]
          : []),
    ];
  };
  const visibleReport = (report: Report) => {
    const r = clone(report);
    if (!r.capabilities.includes("edit_report")) {
      delete r.draft_title;
      delete r.draft_content;
      delete r.draft_files;
    }
    return r;
  };
  const readsSubevent = (id: string) =>
    state.eventManager ||
    state.global ||  // the HR master reads every subevent too (УВ-4)
    state.subevents.some(
      (s) =>
        s.subevent_id === id &&
        (s.organizer_user_ids.includes(state.session.user_id) ||
          s.leaders.some(
            (l) =>
              l.user.user_id === state.session.user_id ||
              l.deputy_user_ids.includes(state.session.user_id),
          )),
    );
  const publicSubevent = (sub: Subevent): Subevent => {
    const working = readsSubevent(sub.subevent_id) || sub.hr?.user_id === state.session.user_id;
    return { ...clone(sub), starts_at: sub.starts_at ?? null, ends_at: sub.ends_at ?? null,
      announcement: sub.announcement ?? richText(""), all_day: sub.all_day ?? false, working_access: working,
      organizers: sub.organizer_user_ids.flatMap(uid => { const person = state.people.find(person => person.user_id === uid);return person ? [person] : []; }),
      description: working ? sub.description : richText(""), report_series_id: working ? sub.report_series_id : null,
      capabilities: working ? sub.capabilities : [] };
  };
  const readsEvent = (id: string) =>
    state.eventManager ||
    state.subevents.some(
      (s) => s.event_id === id && readsSubevent(s.subevent_id),
    );
  const readsScopeTask = (task: Task) =>
    task.scope.kind === "subevent"
      ? readsSubevent(task.scope.id)
      : state.chair ||
        role === "chair-deputy" ||
        state.blocks.some(
          (b) =>
            b.block_id === task.scope.id &&
            (b.members.some((m) => m.user.user_id === state.session.user_id) ||
              b.master?.user.user_id === state.session.user_id ||
              b.master?.deputy_user_ids.includes(state.session.user_id)),
        );
  const queueRequests: (TaskQueueAccessRequest & { queue_id: string })[] = [];
  const mentionRequests:TaskMentionRequest[]=[];const taskGrants=new Map<string,Set<number>>();
  const trackerAdmin = ["chair", "chair-deputy", "hr", "hr-deputy"].includes(role);
  const queueCreateScopes = (): NonNullable<TaskQueueCatalog["create_scopes"]> => {
    if (state.session.account_state !== "active" || state.session.registration_status !== "approved") return [];
    const all = state.chair || role === "chair-deputy", uid = state.session.user_id;
    const leads = (leaders: Event["leaders"]) => leaders.some(leader => leader.user.user_id === uid || leader.deputy_user_ids.includes(uid));
    const eventLead = (id: string) => state.events.some(event => event.event_id === id && leads(event.leaders));
    return [
      ...(all ? [{ kind: "chair" as const, id: "chair", title: "Председатель" }] : []),
      ...state.events.filter(event => all || leads(event.leaders)).map(event => ({ kind: "event" as const, id: event.event_id, title: event.title })),
      ...state.blocks.filter(block => all || block.master && leads([block.master])).map(block => ({ kind: "block" as const, id: block.block_id, title: block.name })),
      ...state.subevents.filter(subevent => all || leads(subevent.leaders) || eventLead(subevent.event_id)).map(subevent => ({ kind: "subevent" as const, id: subevent.subevent_id, title: subevent.title })),
    ];
  };
  const readsQueue = (queue: TaskQueue) => trackerAdmin || queue.owner?.user_id === state.session.user_id || queueRequests.some(r => r.queue_id === queue.queue_id && r.user.user_id === state.session.user_id && r.status === "approved") || (!queue.scope || readsScopeTask({ scope: queue.scope } as Task)) && !queue.is_private;
  const readsTask = (task: Task) => !!taskGrants.get(task.task_id)?.has(state.session.user_id) || (task.queue && state.queues.some(q => q.queue_id === task.queue!.queue_id) ? readsQueue(state.queues.find(q => q.queue_id === task.queue!.queue_id)!) : trackerAdmin || readsScopeTask(task));
  const visibleQueue = (queue: TaskQueue, includeAssignable = true): TaskQueue => {
    const own = queueRequests.filter(r => r.queue_id === queue.queue_id && r.user.user_id === state.session.user_id).at(-1);
    const access_request_status = own?.status === "revoked" ? null : own?.status ?? null;
    if (!readsQueue(queue)) return { queue_id: queue.queue_id, name: queue.name, key: queue.key, access: "locked", capabilities: access_request_status === "pending" ? ["cancel_queue_access_request"] : [], can_request_access: access_request_status !== "pending", access_request_status, access_request_id: own?.request_id ?? null, access_request_revision: own?.revision ?? null };
    const result: TaskQueue = { ...clone(queue), access: "granted", can_request_access: false, access_request_status, capabilities: [...new Set([...queue.capabilities, "create_task"])], ...(state.manager && queue.scope ? { assignable_users: clone(state.people), capabilities: [...new Set([...queue.capabilities, "create_task", "assign_task_others"])] } : {}) };
    if (!includeAssignable) delete result.assignable_users;
    return result;
  };
  let sequence = 10;
  let leadership = {
    chair: state.people[3],
    deputies: [state.people[4]],
    revision: 1,
    capabilities: state.chair
      ? ["transfer_chair", "manage_chair_deputies"]
      : [],
  };
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const changed = <T extends { revision: number }>(item: T) => {
    item.revision++;
    return [200, clone(item)] as Reply;
  };
  const mismatch = (data: Body, item: { revision: number }) =>
    data.expected_revision !== undefined &&
    data.expected_revision !== item.revision;
  const conflict = () =>
    fail(
      409,
      "revision_conflict",
      "Данные изменились. Обновите страницу и повторите действие.",
    );
  const denied = () => fail(403, "forbidden", "Действие недоступно");
  // Dates of a task are moved by the chair, deputies and HR master only (УВ-5).
  const kkrGlobal = () => state.global || role === "hr-deputy" && state.session.account_state === "active" && state.session.capabilities.includes("view_summary");
  const inputsCaps = () => ["edit_assessment_inputs", ...(kkrGlobal() ? ["edit_assessment_dates"] : [])];
  const seasonBlockers = (season: Season): SeasonBlocker[] => {
    const blockers: SeasonBlocker[] = [];
    const previous = state.seasons.find(item => item.season_id === season.previous_season_id);
    if (previous && previous.state !== "closed") blockers.push({ kind: "previous_season_not_closed", owner_kind: "season", owner_id: previous.season_id, title: "Previous season not closed", subject: previous.title });
    for (const task of state.tasks.filter(item => item.season_id === season.season_id && item.scope.kind !== "queue")) {
      for (const assignment of task.assignments) {
        const inputs = state.assessments.find(item => item.assignment_id === assignment.assignment_id);
        const status = inputs?.workflow_status ?? assignment.status;
        const kind = !["accepted", "not_completed", "cancelled"].includes(status) ? "unfinished_assignment"
          : ["accepted", "not_completed"].includes(status) && (inputs?.evaluation == null || status === "accepted" && inputs.hours == null) ? "missing_assessment" : null;
        if (kind) blockers.push({ kind, owner_kind: "assignment", owner_id: assignment.assignment_id, title: task.title, subject: task.title, assignee: assignment.assignee.display_name });
      }
    }
    const events = state.events.filter(event => event.season_id === season.season_id);
    const owners = [...events.map(event => ({ kind: "event", id: event.event_id, title: event.title })),
      ...state.subevents.filter(sub => events.some(event => event.event_id === sub.event_id)).map(sub => ({ kind: "subevent", id: sub.subevent_id, title: sub.title }))];
    for (const owner of owners) if (!state.reports.some(report => report.owner_kind === owner.kind && report.owner_id === owner.id && report.kind === "final" && report.state === "published")) blockers.push({ kind: "missing_final_report", owner_kind: owner.kind, owner_id: owner.id, title: owner.title, subject: owner.title });
    return blockers;
  };
  const filter = <T extends { season_id?: string | null }>(items: T[], url: URL) =>
    url.searchParams.get("season_id")
      ? items.filter((x) => x.season_id === url.searchParams.get("season_id"))
      : items;

  const taskHistory = new Map<string, TaskHistoryEvent[]>();
  const rememberTask = (task: Task, kind: string, description: string, from?: AssignmentStatus | TaskPublicStatus, to?: AssignmentStatus | TaskPublicStatus, changes?: TaskHistoryChange[]) => {
    const events = taskHistory.get(task.task_id) ?? [];
    events.push({ event_id: id("task-event"), kind, description, created_at: mockNow, actor: clone(state.user), from_status: from, to_status: to, changes });
    taskHistory.set(task.task_id, events);task.updated_at = mockNow;
  };
  const taskFiles = (ids: unknown): FileRef[] => ((ids as string[]) ?? []).map(fileId => files.get(fileId)).filter(file => !!file).map(file => ({ file_id: file!.file_id, name: file!.name, mime_type: file!.mime_type, size_bytes: file!.size_bytes }));
  const personalFavorites = new Map<number, Set<string>>([[state.session.user_id, new Set(state.tasks.filter(task => task.is_favorite).map(task => task.task_id))]]);
  const taskLinks: { link_id: string; source: string; target: string; kind: "related" | "blocks" | "epic" | "milestone" }[] = [];
  const linkHistoryTargets = new Map<string, string>();
  const publicTaskWritable = (task: Task) => task.scope.kind === "queue" || state.seasons.find(season => season.season_id === task.season_id)?.state !== "closed" || state.chair || role === "chair-deputy";
  const hydrateTask = (task: Task) => {
    task.status=publicStatus(task.status);
    task.task_type ??= "task";task.priority ??= "normal";task.starts_at ??= null;task.checklist ??= [];
    task.is_favorite = personalFavorites.get(state.session.user_id)?.has(task.task_id) ?? false;
    if (role === "hr" || role === "hr-deputy") {
      task.capabilities = task.capabilities.filter(cap => !["edit_task", "edit_task_description", "attach_task_file"].includes(cap));
      const closed = state.seasons.find(season => season.season_id === task.season_id)?.state === "closed";
      const queueOwner = state.queues.find(queue => queue.queue_id === (task.queue?.queue_id ?? task.scope.id))?.owner?.user_id;
      const independentOwner = task.scope.kind === "queue" && (task.created_by?.user_id === state.session.user_id || queueOwner === state.session.user_id);
      if (state.session.account_state === "active" && readsTask(task) && (!closed || independentOwner)) task.capabilities.push("edit_task", "edit_task_description", "attach_task_file");
    }
    task.capabilities = task.capabilities.filter(cap => !["edit_task_metadata", "manage_task_links", "edit_task_checklist", "change_task_type", "change_task_priority", "toggle_task_checklist", "assign_task_participants", "remove_task_watcher", "remove_task_assignee"].includes(cap));
    if (state.session.account_state === "active" && readsTask(task)) task.capabilities.push("toggle_task_checklist");
    if (publicTaskWritable(task)) {
      if (task.capabilities.includes("edit_task")) task.capabilities.push("edit_task_metadata", "manage_task_links", "change_task_type", "change_task_priority", "assign_task_participants", "remove_task_watcher", "remove_task_assignee");
      if (task.capabilities.includes("edit_task_description") || task.capabilities.includes("edit_task")) task.capabilities.push("edit_task_checklist");
    }
  };
  const assignmentStatus = (status: TaskPublicStatus): AssignmentStatus => ({open:"assigned",completed:"submitted",closed:"accepted"} as const)[status as "open"|"completed"|"closed"] ?? "in_progress";
  const taskRef = (task: Task): TrackerTaskRef => ({ task_id: task.task_id, task_key: task.task_key ?? "Задача", title: task.title, status: publicStatus(task.status), task_type: task.task_type ?? "task", starts_at: task.starts_at ?? null, deadline_at: task.deadline_at });
  const visibleTask = (task: Task): Task => {
    hydrateTask(task);const result = clone(task);
    const parentId = task.parent_task_id ?? task.parent_task?.task_id, parent = state.tasks.find(item => item.task_id === parentId && readsTask(item));
    result.parent_task = parent ? { task_id: parent.task_id, task_key: parent.task_key ?? "Задача", title: parent.title } : null;
    result.parent_task_id = parent?.task_id ?? null;result.parent_task_unavailable = !!parentId && !parent;
    result.children = state.tasks.filter(child => child.parent_task_id === task.task_id && readsTask(child)).map(taskRef);
    const inverse = { related: "related", blocks: "blocked_by", epic: "epic_member", milestone: "milestone_member" } as const;
    result.links = taskLinks.filter(link => link.source === task.task_id || link.target === task.task_id).flatMap(link => {
      const outward = link.source === task.task_id, other = state.tasks.find(item => item.task_id === (outward ? link.target : link.source));
      return other && readsTask(other) ? [{ link_id: link.link_id, kind: outward ? link.kind : inverse[link.kind], task: taskRef(other) }] : [];
    });
    return result;
  };
  const checklistValue = (raw: unknown, previous: TaskChecklistItem[] = []): { value?: TaskChecklistItem[]; error?: Reply } => {
    if (!Array.isArray(raw) || raw.length > 200) return { error: fail(422, "invalid_input", "Чеклист должен содержать не более 200 пунктов") };
    const used = new Set<string>(), value: TaskChecklistItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Object.keys(item).some(key => !["item_id", "text", "checked"].includes(key)) || typeof item.text !== "string" || !item.text.trim() || item.text.trim().length > 1000 || (item.checked !== undefined && typeof item.checked !== "boolean")) return { error: fail(422, "invalid_input", "Проверьте пункт чеклиста") };
      if (item.item_id !== undefined && (typeof item.item_id !== "string" || !previous.some(old => old.item_id === item.item_id))) return { error: fail(422, "invalid_input", "Пункт чеклиста недоступен") };
      const itemId = item.item_id ?? id("checklist");if (used.has(itemId)) return { error: fail(422, "invalid_input", "Пункт чеклиста повторяется") };
      used.add(itemId);value.push({ item_id: itemId, text: item.text.trim(), checked: item.checked ?? false });
    }
    return { value };
  };
  const stage2Patch = (data: Body, task?: Task): { value?: Pick<Task, "task_type" | "priority" | "starts_at" | "checklist">; error?: Reply } => {
    const type = "task_type" in data ? data.task_type : task?.task_type ?? "task", priority = "priority" in data ? data.priority : task?.priority ?? "normal";
    const implicitMilestoneStart = !!task && "task_type" in data && data.task_type === "milestone" && !("starts_at" in data);
    const starts = implicitMilestoneStart ? null : "starts_at" in data ? data.starts_at : task?.starts_at ?? null;
    if (!["task", "milestone", "epic"].includes(String(type)) || !["low", "normal", "high", "urgent"].includes(String(priority))) return { error: fail(422, "invalid_input", "Неизвестный тип или приоритет") };
    if (starts !== null && (typeof starts !== "string" || !Number.isFinite(Date.parse(starts)) || Date.parse(starts) > Date.parse(task?.deadline_at ?? String(data.deadline_at))) || type === "milestone" && starts !== null) return { error: fail(422, "invalid_input", "Проверьте плановую дату начала") };
    if (task && taskLinks.some(link => link.kind === "epic" || link.kind === "milestone" ? link.source === task.task_id && type !== "task" || link.target === task.task_id && type !== link.kind : false)) return { error: fail(422, "task_type_conflict", "Тип несовместим с существующими связями") };
    const checklist = "checklist" in data ? checklistValue(data.checklist, task?.checklist) : { value: task?.checklist ?? [] };if (checklist.error) return { error: checklist.error };
    return { value: { task_type: type as Task["task_type"], priority: priority as Task["priority"], starts_at: starts as string | null, checklist: checklist.value } };
  };
  const linksReach = (from: string, to: string) => {
    const seen = new Set<string>(), visit = [from];
    while (visit.length) { const item = visit.pop()!;if (item === to) return true;if (seen.has(item)) continue;seen.add(item);taskLinks.filter(link => link.kind === "blocks" && link.source === item).forEach(link => visit.push(link.target)); }
    return false;
  };
  const rememberLink = (task: Task, other: Task, added: boolean) => {
    rememberTask(task, "task_links_changed", added ? "Добавлена связь задачи" : "Удалена связь задачи", undefined, undefined, [{ field: "links", label: "Связи", before: added ? null : `${other.task_key} · ${other.title}`, after: added ? `${other.task_key} · ${other.title}` : null }]);
    const event = taskHistory.get(task.task_id)!.at(-1)!;linkHistoryTargets.set(event.event_id, other.task_id);
  };
  const refreshTake = (task: Task) => {
    task.capabilities = task.capabilities.filter(capability => capability !== "take_task");
    const assigned = (task.assignees ?? task.assignments.filter(item => !item.assignee_unavailable_reason).map(item => item.assignee)).some(person => person.user_id === state.session.user_id);
    if (task.capabilities.includes("change_task_status") && (!assigned || task.status !== "in_progress" || task.legacy_mixed_statuses)) task.capabilities.push("take_task");
  };
  state.tasks.forEach(task => { refreshTake(task);hydrateTask(task); });
  const refreshRoster = (task: Task) => {
    task.assignees ??= task.assignments.filter(a => !a.assignee_unavailable_reason).map(a => a.assignee);task.watchers ??= [];
    task.capabilities = task.capabilities.filter(c => !["join_task", "take_task", "watch_task", "unwatch_task", "remove_task_assignee", "edit_task_description"].includes(c));
    task.capabilities.push("change_task_status", "submit_task_result");
    if (!task.assignees.some(u => u.user_id === state.session.user_id)) task.capabilities.push("join_task");
    refreshTake(task);
    task.capabilities.push(task.watchers.some(u => u.user_id === state.session.user_id) ? "unwatch_task" : "watch_task");
    if (task.capabilities.includes("edit_task")) task.capabilities.push("edit_task_description");
    hydrateTask(task);
  };
  const transitionTask = (task: Task, data: Body): Reply => {
    const extra = extraInputs(data, ["status", "message", "text", "links", "file_ids", "reason"]);if (extra) return extra;
    if (!["open", "in_progress", "completed", "closed", "assigned", "help_required", "submitted", "accepted", "needs_revision", "not_completed", "cancelled"].includes(String(data.status))) return fail(422, "invalid_input", "Неизвестный статус");
    if (mismatch(data, task)) return conflict();
    const current = publicStatus(task.status), next = publicStatus(data.status as AssignmentStatus|TaskPublicStatus);
    const author=task.created_by?.user_id;const owner=state.queues.find(q=>q.queue_id===task.queue?.queue_id)?.owner?.user_id;
    if ((current==="closed"||next==="closed") && state.session.user_id!==(author??owner)) return denied();
    if(next==="closed"&&current!=="closed")task.closed_at=mockNow;
    task.status = next;task.revision++;task.assignments.forEach(a => { a.status = assignmentStatus(next);a.revision++; });refreshTake(task);
    rememberTask(task, "status_changed", "Изменён рабочий статус задачи", current, next);
    return [200, visibleTask(task)];
  };

  uploads.onAny().reply((config) => {
    const fileId = config.url?.split("/").pop() ?? "";
    const file = files.get(fileId);
    if (!file) return fail(404, "file_not_found", "Файл не найден");
    file.uploaded = true;
    config.onUploadProgress?.({
      loaded: file.size_bytes,
      total: file.size_bytes,
      bytes: file.size_bytes,
      lengthComputable: true,
      upload: true,
    });
    return [200, ""];
  });

  adapter.onAny().reply((config) => {
    const url = new URL(config.url ?? "/", "https://mock.example");
    const path = url.pathname.replace(/^\/api(?=\/)/, "");
    Object.entries(config.params ?? {}).forEach(([k, v]) => {
      if (v !== undefined) url.searchParams.set(k, String(v));
    });
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const method = (config.method ?? "get").toLowerCase();
    const data = dataOf(config);
    if (
      options.scenario === "error" &&
      !["/session", "/profile/me"].includes(path) &&
      !path.startsWith("/auth/")
    )
      return fail(503, "unavailable", "Сервис временно недоступен");
    if (options.scenario === "conflict" && method !== "get") return conflict();
    if (path === "/session") return [200, clone(state.session)];
    if (path.startsWith("/auth/"))
      return [
        200,
        {
          access_token: "development-only",
          refresh_token: "development-only",
          token_type: "bearer",
        },
      ];
    if (path === "/registrations/me") {
      if (method === "patch") {
        if (state.registration.status === "approved") return denied();
        if (mismatch(data, state.registration)) return conflict();
        state.registration.fields = clone(
          data.fields as typeof state.registration.fields,
        );
        return changed(state.registration);
      }
      return [200, clone(state.registration)];
    }
    if (path === "/registrations/me/resubmit") {
      if (mismatch(data, state.registration)) return conflict();
      if (state.registration.status !== "rejected") return conflict();
      if (state.registration.attempts_used >= 5)
        return fail(
          409,
          "registration_attempt_limit",
          "Исчерпан лимит отправок",
        );
      state.registration.attempts_used++;
      state.registration.total_submissions++;
      state.registration.status = "pending";
      state.session.registration_status = "pending";
      state.registration.capabilities = [];
      return changed(state.registration);
    }
    if (state.session.account_state !== "active") return denied();
    const profileReply = profileFeatures(path, method, data, url.searchParams);
    if (profileReply) return profileReply;
    if (
      parts[0] === "profile" &&
      /^\d+$/.test(parts[1] ?? "") &&
      Number(parts[1]) !== state.session.user_id &&
      method === "patch"
    )
      return denied();
    if (
      path === "/profile/me" ||
      path === `/profile/${state.profile.user_id}`
    ) {
      if (method === "patch") Object.assign(state.profile, data);
      return [200, clone(state.profile)];
    }
    if (path === "/contacts")
      return [
        200,
        state.people
          .filter((p) => !state.archived.some((a) => a.user_id === p.user_id))
          .map((p) => ({
            ...state.profile,
            user_id: p.user_id,
            name: p.display_name.split(" ")[0],
            surname: p.display_name.split(" ")[1],
            kkr_name: p.display_name,
            email: `member${p.user_id}@example.com`,
            photo_url:
              p.user_id === state.session.user_id
                ? state.profile.photo_url
                : "/avatars/default.svg",
          })),
      ];
    if (path === "/contacts/emails")
      return [
        200,
        { emails: state.people.map((p) => `member${p.user_id}@example.com`) },
      ];
    if (path === "/leadership") return [200, clone(leadership)];
    if (path === "/pgas-admins")
      return state.session.capabilities.includes("grant_pgas_admin") ? list(clone(state.people.filter((p) => pgasAdmins.has(p.user_id!)))) : denied();
    if (parts[0] === "users" && parts[2] === "pgas-admin") {
      if (!state.session.capabilities.includes("grant_pgas_admin")) return denied();
      if (data.pgas_admin) pgasAdmins.add(Number(parts[1]));
      else pgasAdmins.delete(Number(parts[1]));
      return [200, { user_id: Number(parts[1]), pgas_admin: !!data.pgas_admin }];
    }
    if (parts[0] === "accounts" && parts[2] === "temporary-password") {
      if (!state.session.capabilities.includes("reset_password")) return denied();
      const userId = Number(parts[1]);
      if (userId === leadership.chair.user_id || leadership.deputies.some((d) => d.user_id === userId))
        return fail(403, "forbidden", "Председатель и замы меняют пароль сами");
      return [200, { user_id: userId, email: `member${userId}@example.com`, temporary_password: "synthetic-temporary" }];
    }
    if (path === "/leadership/transfer") {
      if (!state.chair) return denied();
      if (mismatch(data, leadership)) return conflict();
      state.session.capabilities = [];
      state.session.assignments = [];
      state.chair = false;
      state.global = false;
      state.manager = false;
      state.eventManager = false;
      state.events = [];
      state.subevents = [];
      state.tasks = [];
      state.meetings = [];
      state.reports = [];
      state.blocks.forEach((b) => {
        b.capabilities = [];
      });
      state.materials.forEach((m) => {
        m.capabilities = [];
      });
      leadership = {
        chair: state.people.find((p) => p.user_id === data.new_chair_user_id)!,
        deputies: [],
        revision: leadership.revision + 1,
        capabilities: [],
      };
      return [200, clone(leadership)];
    }
    if (path === "/leadership/deputies") {
      if (!state.chair) return denied();
      if (mismatch(data, leadership)) return conflict();
      if ((data.user_ids as number[]).length > 3)
        return fail(422, "deputy_limit", "At most 3 deputies allowed", { limit: 3 });
      leadership.deputies = state.people.filter((p) =>
        (data.user_ids as number[]).includes(p.user_id!),
      );
      leadership.revision++;
      return [200, clone(leadership)];
    }
    if (path === "/seasons/current")
      return [200, clone(state.seasons.find((s) => s.is_current))];
    if (parts[0] === "seasons") {
      if (parts.length === 1) {
        if (method === "get")
          return list(options.scenario === "empty" ? [] : clone(state.seasons));
        if (!state.chair) return denied();
        if (state.seasons.some((s) => s.state === "planned"))
          return fail(
            409,
            "planned_exists",
            "Ближайший следующий сезон уже подготовлен",
          );
        const created: Season = {
          ...(data as unknown as Season),
          season_id: id("season"),
          state: "planned",
          is_current: false,
          sequence_number: state.seasons.length + 1,
          previous_season_id: state.seasons.at(-1)?.season_id ?? null,
          revision: 1,
          capabilities: ["open_season", "edit_season"],
        };
        state.seasons.push(created);
        return [201, clone(created)];
      }
      const season = state.seasons.find((s) => s.season_id === parts[1]);
      if (!season) return fail(404, "not_found", "Сезон не найден");
      if (parts[2] === "readiness" && method === "get") {
        if (!kkrGlobal()) return denied();
        const blockers = seasonBlockers(season);
        return [200, { ready: blockers.length === 0 && ["open", "summarizing"].includes(season.state), blockers, revision: season.revision }];
      }
      if (parts[2] === "analytics" && method === "get") {
        if (!kkrGlobal()) return denied();
        const participantId = url.searchParams.get("participant_id"), blockId = url.searchParams.get("block_id");
        const summary = summaries.get(season.season_id)!;
        const rows = summary.rows.filter(row => (!participantId || row.participant_id === participantId) && (!blockId || row.blocks.some(block => block.block_id === blockId)));
        const closed = season.state === "closed";
        const kkr = rows.reduce((sum, row) => sum + row.total_score, 0);
        const selectedUsers = new Set(rows.map(row => row.user.user_id));
        const accepted = state.tasks.filter(task => task.season_id === season.season_id && task.scope.kind !== "queue").flatMap(task => task.assignments.map(assignment => ({ task, assignment, inputs: state.assessments.find(input => input.assignment_id === assignment.assignment_id) }))).filter(item => selectedUsers.has(item.assignment.assignee.user_id) && item.inputs?.workflow_status === "accepted" && (!blockId || item.task.scope.kind === "block" && item.task.scope.id === blockId));
        const completed = new Set(accepted.map(item => item.task.task_id)).size, hours = accepted.reduce((sum, item) => sum + (item.inputs?.hours ?? 0), 0);
        const totals = { completed_tasks: closed ? null : completed, credited_hours: closed ? null : hours, kkr };
        const basis: SeasonAnalytics["basis"] = { kind: closed ? "approved_snapshot" : "current_ledger", version: closed ? summary.version : null, approved_at: closed ? season.ends_at : null };
        const analytics: SeasonAnalytics = {
          season: { season_id: season.season_id, title: season.title, state: season.state, starts_at: season.starts_at, ends_at: season.ends_at }, as_of: options.now ?? mockNow, basis,
          filters: { participant_id: participantId, block_id: blockId }, participants: summary.rows.map(row => ({ participant_id: row.participant_id, user: row.user })),
          blocks: [...new Map(summary.rows.flatMap(row => row.blocks).map(block => [block.block_id, block])).values()], totals, weekly: [],
          unallocated: { ...totals, contribution_count: rows.reduce((sum, row) => sum + row.source_scores.length, 0) },
          source_breakdown: rows.flatMap(row => row.source_scores).map(source => ({ source_kind: source.source_kind, kkr: source.score, contribution_count: 1 })),
          season_comparison: state.seasons.map(item => ({ season_id: item.season_id, title: item.title, state: item.state, starts_at: item.starts_at, ends_at: item.ends_at, basis: { kind: item.state === "closed" ? "approved_snapshot" : "current_ledger", version: item.state === "closed" ? summaries.get(item.season_id)?.version ?? 1 : null, approved_at: item.state === "closed" ? item.ends_at : null }, totals: item.season_id === season.season_id ? totals : { completed_tasks: null, credited_hours: null, kkr: summaries.get(item.season_id)?.rows.filter(row => !participantId || row.participant_id === participantId).reduce((sum, row) => sum + row.total_score, 0) ?? null } })),
          coverage: { accepted_assignments: closed ? null : accepted.length, missing_hours_assignments: closed ? null : 0, undated_accepted_assignments: closed ? null : accepted.length, undated_contributions: rows.reduce((sum, row) => sum + row.source_scores.length, 0), notes: ["Синтетические тестовые данные: даты распределения по неделям не заданы."] },
        };
        return [200, clone(analytics)];
      }
      if (parts[2] === "summary.xlsx")
        return kkrGlobal()
          ? [
              200,
              new Blob(["Synthetic export fixture"], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
            ]
          : denied();
      if (parts[2] === "summary") {
        if (!kkrGlobal()) return denied();
        const summary = summaries.get(season.season_id)!;
        if (parts[3] === "versions") {
          const history = summaryVersions.get(season.season_id) ?? [];
          if (parts[4]) {
            const version = history.find(v => v.version === Number(parts[4]));
            return version ? [200, clone(version)] : fail(404, "not_found", "Версия не найдена");
          }
          return list(history.map(v => ({ version: v.version, changed_by: v.changed_by, changed_at: v.changed_at,
            reason: v.reason, previous_summary_version: v.previous_summary_version })));
        }
        summary.capabilities =
          season.state === "closed"
            ? state.chair
              ? ["edit_decisions", "correct_summary"]
              : []
            : ["edit_decisions"];
        if (parts[3] === "correct") {
          if (!state.chair || season.state !== "closed") return denied();
          if (data.expected_version !== summary.version) return conflict();
          const changes = data.changes as {
            kind: "task_inputs" | "assessment_inputs" | "merit";
            id: string;
            expected_revision: number;
            values: object;
          }[];
          const recordFor = (c: (typeof changes)[number]) =>
            c.kind === "task_inputs"
              ? taskInputs.get(c.id)
              : c.kind === "merit"
                ? state.merits.find((m) => m.merit_id === c.id)
                : c.kind === "assessment_inputs"
                  ? state.assessments.find((a) => a.assignment_id === c.id)
                  : undefined;
          if (
            !changes?.length ||
            !String(data.reason ?? "").trim() ||
            changes.some(
              (c) =>
                !recordFor(c) ||
                Object.keys(c.values).some((k) =>
                  [
                    "score",
                    "total_score",
                    "season_id",
                    "capabilities",
                    "revision",
                  ].includes(k),
                ),
            )
          )
            return fail(
              422,
              "invalid_correction",
              "Проверьте исходные поля и причину",
            );
          if (
            changes.some((c) => recordFor(c)!.revision !== c.expected_revision)
          )
            return conflict();
          changes.forEach((c) => {
            const a = recordFor(c)!;
            Object.assign(a, c.values);
            a.revision++;
            if (c.kind === "task_inputs") {
              const task = state.tasks.find((t) => t.task_id === c.id);
              if (task && "deadline_at" in a) task.deadline_at = a.deadline_at;
            }
          });
          summary.version++;
          rememberSummary(season.season_id, String(data.reason));
          return [200, {...clone(summary), applied_revisions: changes.map(c => ({kind: c.kind, id: c.id, revision: recordFor(c)!.revision}))}];
        }
        if (method === "put") {
          if (season.state === "closed" && !state.chair) return denied();
          if (data.expected_version !== summary.version) return conflict();
          const row = summary.rows.find(
            (r) => r.user.user_id === Number(parts[4]),
          );
          if (row) row.decisions = data.decisions as Decision[];
          summary.version++;
          if (season.state === "closed") rememberSummary(season.season_id, String(data.reason ?? "Изменение отметок"));
        }
        return [200, clone(summary)];
      }
      if (parts[2] === "master-bonuses")
        return kkrGlobal()
          ? list([
              {
                bonus_id: "bonus-1",
                season_id: season.season_id,
                block_id: "block-info",
                recipient_participant_id: "participant-102",
                recipient: state.people[1],
                eligible_organizer_count: 1,
                amount: 2.5,
                calculation_version: "master_bonus_v1",
                basis: [
                  {
                    participant_id: "participant-101",
                    user: state.people[0],
                    member_task_score: 10,
                    included: true,
                    exclusion: null,
                  },
                  {
                    participant_id: "participant-105",
                    user: state.people[4],
                    member_task_score: 0,
                    included: false,
                    exclusion: "non_positive",
                  },
                  {
                    participant_id: "participant-102",
                    user: state.people[1],
                    member_task_score: 4,
                    included: false,
                    exclusion: "master",
                  },
                ],
              },
            ])
          : denied();
      if (method === "get") return [200, clone(season)];
      if (!state.chair) return denied();
      if (mismatch(data, season)) return conflict();
      if (parts[2] === "close") {
        const blockers = seasonBlockers(season);
        if (blockers.length)
          return fail(409, "season_not_ready", "Сезон пока нельзя закрыть", {
            blockers,
          });
        season.state = "closed";
        season.is_current = false;
        season.capabilities = [];
        const summary = summaries.get(season.season_id)!;
        summary.state = "approved";
        summary.approved_at = mockNow;
        summary.version++;
        rememberSummary(season.season_id, "Утверждение итогов");
        return [200, { season: clone(season), summary: clone(summary) }];
      }
      if (parts[2] === "open") {
        state.seasons.forEach((s) => {
          s.is_current = false;
        });
        season.is_current = true;
        season.state = "open";
        season.capabilities = ["begin_summary", "edit_season"];
      } else if (parts[2] === "begin-summary") {
        season.state = "summarizing";
        season.capabilities = ["close_season"];
      } else Object.assign(season, data);
      return changed(season);
    }
    if (path === "/season-corrections") {
      if (!state.session.capabilities.includes("correct_season"))
        return denied();
      const event = state.events.find((e) => e.event_id === data.object_id);
      if (!event || mismatch(data, event)) return conflict();
      if (
        state.seasons.find((s) => s.season_id === event.season_id)?.state ===
          "closed" ||
        state.seasons.find((s) => s.season_id === data.target_season_id)
          ?.state === "closed"
      )
        return conflict();
      const source = event.season_id;
      event.season_id = String(data.target_season_id);
      event.revision++;
      const subs = state.subevents
        .filter((s) => s.event_id === event.event_id)
        .map((s) => s.subevent_id);
      state.tasks
        .filter((t) => t.scope.kind === "subevent" && subs.includes(t.scope.id))
        .forEach((t) => {
          t.season_id = event.season_id;
        });
      state.reports
        .filter(
          (r) => r.owner_id === event.event_id || subs.includes(r.owner_id),
        )
        .forEach((r) => {
          r.season_id = event.season_id;
        });
      state.merits
        .filter(
          (m) =>
            m.event_id === event.event_id ||
            (m.scope?.kind === "subevent" && subs.includes(m.scope.id)),
        )
        .forEach((m) => {
          m.season_id = event.season_id;
        });
      return [
        200,
        {
          object_kind: data.object_kind,
          object_id: data.object_id,
          source_season_id: source,
          target_season_id: event.season_id,
          revision: event.revision,
        },
      ];
    }
    if (path === "/events" && parts.length === 1) {
      if (method === "get")
        return list(
          options.scenario === "empty"
            ? []
            : clone(
                filter(state.events, url),  // event cards are visible to everyone (УВ-3)
              ),
        );
      if (!state.session.capabilities.includes("create_event")) return denied();
      // As on the server: an existing series must be an event series.
      if (data.report_series_id && !state.events.some((e) => e.report_series_id === data.report_series_id))
        return fail(422, "invalid_input", "Invalid report_series_id for event");
      const event: Event = {
        ...(data as unknown as Event),
        event_id: id("event"),
        report_series_id: (data.report_series_id as string | undefined) ?? id("series"),
        leaders: [],
        starts_at: typeof data.starts_at === "string" ? data.starts_at : null,
        ends_at: typeof data.ends_at === "string" ? data.ends_at : null,
        all_day: !!data.all_day,
        revision: 1,
        capabilities: state.events[0]?.capabilities ?? [],
      };
      state.events.push(event);
      return [201, clone(event)];
    }
    if (parts[0] === "events" || parts[0] === "subevents") {
      const isEvent = parts[0] === "events";
      const item = isEvent
        ? state.events.find((e) => e.event_id === parts[1])
        : state.subevents.find((s) => s.subevent_id === parts[1]);
      if (!item) return fail(404, "not_found", "Мероприятие недоступно");
      // Unreadable reads answer as missing ones (A-SEC-6); commands are refused.
      const hidden = () => (method === "get" ? fail(404, "not_found", "Объект недоступен") : denied());
      if (!isEvent && parts.length === 2 && method === "get") {
        return [200, publicSubevent(item as Subevent)];
      }
      if (!isEvent && parts[2] === "hr") {
        if (!["chair", "chair-deputy", "hr"].includes(role)) return denied();
        if (mismatch(data, item)) return conflict();
        const sub = item as Subevent;sub.hr = state.people.find(person => person.user_id === Number(data.user_id)) ?? null;return changed(sub);
      }
      if (!isEvent && !readsSubevent(parts[1])) return hidden();
      if (parts[2] === "meeting") {
        const kind = isEvent ? "event" : "subevent";
        // Same rule as the server: the owner's capabilities decide reading and writing.
        if (!item.capabilities.includes("view_meeting")) return hidden();
        const meeting = state.meetings.find(
          (m) => m.owner_kind === kind && m.owner_id === parts[1],
        );
        if (method === "get") return [200, clone(meeting ?? null)];
        if (!item.capabilities.includes("edit_meeting")) return denied();
        if (meeting && mismatch(data, meeting)) return conflict();
        if (method === "delete") {
          state.meetings = state.meetings.filter((m) => m !== meeting);
          return [200, {}];
        }
        const saved: Meeting = {
          ...(data as unknown as Meeting),
          meeting_id: meeting?.meeting_id ?? id("meeting"),
          owner_kind: kind,
          owner_id: parts[1],
          revision: (meeting?.revision ?? 0) + 1,
          capabilities: item.capabilities.filter((c) => c === "edit_meeting" || c === "delete_meeting"),
        };
        state.meetings = [
          ...state.meetings.filter((m) => m !== meeting),
          saved,
        ];
        return [200, clone(saved)];
      }
      if (isEvent && parts[2] === "subevents") {
        if (method === "get")
          return list(
            state.subevents.filter((s) => s.event_id === parts[1]).map(publicSubevent),
          );
        if (!state.manager) return denied();
        // As on the server: an existing series must be a child series of the parent's.
        const parentSeries = state.events.find((e) => e.event_id === parts[1])?.report_series_id;
        if (data.report_series_id && !state.subevents.some((x) => x.report_series_id === data.report_series_id
          && state.events.find((e) => e.event_id === x.event_id)?.report_series_id === parentSeries))
          return fail(422, "invalid_input", "Invalid report_series_id for subevent: must be child series of parent event");
        const sub: Subevent = {
          ...(data as unknown as Subevent),
          subevent_id: id("subevent"),
          event_id: parts[1],
          leaders: [],
          organizer_user_ids: [],
          report_series_id: (data.report_series_id as string | undefined) ?? id("series"),
          revision: 1,
          capabilities: state.subevents[0]?.capabilities ?? [],
        };
        state.subevents.push(sub);
        return [201, clone(sub)];
      }
      if (isEvent && parts[2] === "copy") {
        if (!state.session.capabilities.includes("create_event"))
          return denied();
        const event = {
          ...clone(item as Event),
          ...data,
          event_id: id("event"),
          leaders: [],
          revision: 1,
        } as Event;
        const subs = state.subevents
          .filter((s) => s.event_id === parts[1])
          .map((s) => ({
            ...clone(s),
            subevent_id: id("subevent"),
            event_id: event.event_id,
            leaders: [],
            organizer_user_ids: [],
            revision: 1,
          }));
        state.events.push(event);
        state.subevents.push(...subs);
        return [200, { event: clone(event), subevents: clone(subs) }];
      }
      if (method === "get") return [200, clone(item)];
      if (!state.manager) return denied();
      if (mismatch(data, item)) return conflict();
      if (parts[2] === "leaders")
        item.leaders = (data.user_ids as number[]).map(
          (uid) =>
            item.leaders.find((l) => l.user.user_id === uid) ?? {
              role_assignment_id: id("leader"),
              user: state.people.find((p) => p.user_id === uid)!,
              deputy_user_ids: [],
              revision: 1,
              capabilities: ["manage_deputies"],
            },
        );
      else if (parts[2] === "organizers" && !isEvent)
        (item as Subevent).organizer_user_ids = data.user_ids as number[];
      else Object.assign(item, data);
      return changed(item);
    }
    if (parts[0] === "role-assignments") {
      const leader = [...state.events, ...state.subevents, ...state.blocks]
        .flatMap((x) =>
          "leaders" in x ? x.leaders : x.master ? [x.master] : [],
        )
        .find((l) => l.role_assignment_id === parts[1]);
      if (!leader || !state.manager) return denied();
      if (mismatch(data, leader)) return conflict();
      if ((data.user_ids as number[]).length > 2)
        return fail(422, "deputy_limit", "At most 2 deputies allowed per leader", { limit: 2 });
      leader.deputy_user_ids = data.user_ids as number[];
      return changed(leader);
    }
    if (path === "/report-series")
      return list([
        {
          series_id: "series-event-1",
          owner_kind: "event",
          title: "День математика",
          parent_series_id: null,
        },
        {
          series_id: "series-sub-1",
          owner_kind: "subevent",
          title: "Лекции и встречи",
          parent_series_id: "series-event-1",
        },
      ]);
    if (parts[0] === "task-queues") {
      if (parts.length === 1) {
        if (method === "get") { const scopes = queueCreateScopes();return [200, { items: state.queues.map(queue => visibleQueue(queue, false)), next_cursor: null, create_scopes: scopes, can_create_queue: scopes.length > 0 }]; }
        if (state.session.account_state !== "active") return denied();
        const scope = data.scope as Record<string, unknown> | null | undefined;
        if (!scope || Object.keys(scope).some(key => !["kind", "id"].includes(key)) || !["block", "event", "subevent", "chair"].includes(String(scope.kind)) || typeof scope.id !== "string") return fail(422, "validation_error", "Требуется точный контекст команды");
        if (!queueCreateScopes().some(item => item.kind === scope.kind && item.id === scope.id)) return denied();
        if (!/^[A-Z]+$/.test(String(data.key)) || state.queues.some(q => q.key === data.key)) return fail(422, "invalid_input", "Проверьте ключ очереди");
        const owner = data.owner_user_id === undefined ? state.user : state.people.find(p => p.user_id === Number(data.owner_user_id));
        if (!owner || owner.user_id !== state.session.user_id) return denied();
        const queue: TaskQueue = { queue_id: id("queue"), name: String(data.name), key: String(data.key), scope: data.scope ? clone(data.scope) as TaskQueue["scope"] : null, owner: clone(owner), is_private: !!data.is_private, revision: 1, created_at: mockNow, access: "granted", can_request_access: false, access_request_status: null, capabilities: ["create_task", ...(owner.user_id === state.session.user_id ? ["manage_queue", "view_queue_requests"] : [])] };
        state.queues.push(queue);return [200, visibleQueue(queue)];
      }
      const queue = state.queues.find(q => q.queue_id === parts[1]);
      if (!queue) return fail(404, "not_found", "Очередь недоступна");
      const owns = queue.owner?.user_id === state.session.user_id;
      if (parts[2] === "access-requests") {
        if (parts.length === 3 && method === "get") return owns ? list(clone(queueRequests.filter(r => r.queue_id === queue.queue_id))) : denied();
        if (parts.length === 3) {
          if (!visibleQueue(queue).can_request_access) return denied();
          const item: TaskQueueAccessRequest & { queue_id: string } = { request_id: id("queue-request"), queue_id: queue.queue_id, user: clone(state.user), message: String(data.message ?? ""), status: "pending", created_at: mockNow, revision: 1, capabilities: [] };
          queueRequests.push(item);return [201, visibleQueue(queue)];
        }
        if (parts[4] === "cancel") {
          const item=queueRequests.find(r=>r.request_id===parts[3]&&r.queue_id===queue.queue_id&&r.user.user_id===state.session.user_id);
          if(!item)return denied();if(mismatch(data,item))return conflict();if(item.status!=="pending")return fail(409,"conflict","Запрос уже обработан");
          item.status="cancelled";item.revision++;return [200,visibleQueue(queue)];
        }
        if (!owns) return denied();
        const item = queueRequests.find(r => r.request_id === parts[3] && r.queue_id === queue.queue_id);
        if (!item) return fail(404, "not_found", "Запрос недоступен");
        if (mismatch(data, item)) return conflict();
        item.status = parts[4] === "approve" ? "approved" : "rejected";item.capabilities = [];return changed(item);
      }
      if (parts[2] === "members") {
        if (!owns) return denied();
        const item = queueRequests.find(r => r.queue_id === queue.queue_id && r.user.user_id === Number(parts[3]) && r.status === "approved");
        if (!item) return fail(404, "not_found", "Участник недоступен");
        if (mismatch(data, item)) return conflict();
        item.status = "revoked";return changed(item);
      }
      if (!readsQueue(queue)) return fail(403, "queue_access_required", "Нет доступа к очереди", { queue: { queue_id: queue.queue_id, name: queue.name, key: queue.key }, can_request_access: visibleQueue(queue).can_request_access, access_request_status: visibleQueue(queue).access_request_status, access_request_id: visibleQueue(queue).access_request_id, access_request_revision: visibleQueue(queue).access_request_revision });
      if (method === "get") return [200, visibleQueue(queue)];
      if (!owns) return denied();
      if (mismatch(data, { revision: queue.revision! })) return conflict();
      if (typeof data.name === "string") queue.name = data.name;
      if (typeof data.is_private === "boolean") queue.is_private = data.is_private;
      if (data.owner_user_id !== undefined) queue.owner = state.people.find(p => p.user_id === Number(data.owner_user_id)) ?? queue.owner;
      queue.revision!++;return [200, visibleQueue(queue)];
    }
    if (path === "/tasks") {
      if (method === "get") {
        let tasks = filter(state.tasks, url).filter(readsTask);
        if (url.searchParams.get("queue_id")) tasks = tasks.filter(t => t.queue?.queue_id === url.searchParams.get("queue_id"));
        if (url.searchParams.get("scope_id"))
          tasks = tasks.filter(
            (t) => t.scope.id === url.searchParams.get("scope_id"),
          );
        if (url.searchParams.get("mine") === "true")
          tasks = tasks.filter((t) =>
            t.assignments.some(
              (a) => a.assignee.user_id === state.session.user_id,
            ),
          );
        if (url.searchParams.get("status")) tasks = tasks.filter(t => (t.status ?? t.assignments[0]?.status) === url.searchParams.get("status"));
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        if (query) tasks = tasks.filter(t => `${t.title} ${t.task_key ?? ""} ${t.description.body}`.toLowerCase().includes(query));
        if (url.searchParams.get("unfinished") === "true") tasks = tasks.filter(t => publicStatus(t.status)!=="closed");
        if (url.searchParams.get("overdue") === "true") tasks = tasks.filter(t => t.deadline_at !== null && t.deadline_at < (options.now ?? mockNow) && publicStatus(t.status)!=="closed");
        if (url.searchParams.get("assignee_user_id")) tasks = tasks.filter(t => t.assignments.some(a => a.assignee.user_id === Number(url.searchParams.get("assignee_user_id"))));
        if (url.searchParams.has("task_type") && !["task", "milestone", "epic"].includes(url.searchParams.get("task_type")!)) return fail(422, "invalid_input", "Неизвестный тип задачи");
        if (url.searchParams.has("priority") && !["low", "normal", "high", "urgent"].includes(url.searchParams.get("priority")!)) return fail(422, "invalid_input", "Неизвестный приоритет");
        if (url.searchParams.has("favorite") && !["true", "false"].includes(url.searchParams.get("favorite")!)) return fail(422, "invalid_input", "Проверьте фильтр избранного");
        tasks.forEach(hydrateTask);
        if (url.searchParams.has("task_type")) tasks = tasks.filter(task => task.task_type === url.searchParams.get("task_type"));
        if (url.searchParams.has("priority")) tasks = tasks.filter(task => task.priority === url.searchParams.get("priority"));
        if (url.searchParams.has("favorite")) tasks = tasks.filter(task => !!task.is_favorite === (url.searchParams.get("favorite") === "true"));
        const from = url.searchParams.get("date_from"), until = url.searchParams.get("date_to");
        if (from && !Number.isFinite(Date.parse(from)) || until && !Number.isFinite(Date.parse(until))) return fail(422, "invalid_input", "Проверьте период");
        if (from) tasks = tasks.filter(task => !!task.deadline_at && Date.parse(task.deadline_at) >= Date.parse(from));
        if (until) tasks = tasks.filter(task => !!task.deadline_at && Date.parse(task.task_type === "milestone" ? task.deadline_at : task.starts_at ?? task.deadline_at) < Date.parse(until));
        const sort = url.searchParams.get("sort"), direction = url.searchParams.get("order") === "desc" ? -1 : 1;
        const priorities = { low: 0, normal: 1, high: 2, urgent: 3 };
        const sortValue = (task: Task) => sort === "priority" ? String(priorities[task.priority ?? "normal"]) : sort === "starts" ? task.starts_at ?? task.deadline_at : sort === "updated" ? task.updated_at ?? task.created_at ?? "" : sort === "created" ? task.created_at ?? "" : task.deadline_at;
        tasks = [...tasks].sort((a, b) => { const left = sortValue(a), right = sortValue(b);if (left == null || right == null) return left == null && right == null ? a.task_id.localeCompare(b.task_id) : left == null ? 1 : -1;return direction * (left.localeCompare(right) || a.task_id.localeCompare(b.task_id)); });
        if (options.scenario === "empty") tasks = [];
        const offset = Number((url.searchParams.get("cursor") ?? "mock:0").split(":")[1]), limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        const scopes = [...new Map(state.tasks.filter(readsTask).map(task => [`${task.scope.kind}:${task.scope.id}`, { ...task.scope, title: task.scope_title ?? "Команда" }])).values()];
        return [200, { items: tasks.slice(offset, offset + limit).map(visibleTask), total: tasks.length, scopes, assignees: clone(state.people), next_cursor: offset + limit < tasks.length ? `mock:${offset + limit}` : null }];
      }
      const extraTask = extraInputs(data, ["queue_id", "scope", "season_id", "title", "description", "deadline_at", "assignees", "watcher_user_ids", "file_ids", "parent_task_id", "criteria", "task_type", "priority", "starts_at", "checklist"]);if (extraTask) return extraTask;
      const stage2 = stage2Patch(data);if (stage2.error) return stage2.error;
      const selectedQueue = state.queues.find(q => q.queue_id === data.queue_id);
      if (selectedQueue ? !readsQueue(selectedQueue) : !data.scope || !(trackerAdmin || readsScopeTask({ scope: data.scope } as Task))) return denied();
      if (!state.manager && ((data.assignees ?? []) as { user_id: number }[]).some(a => a.user_id !== state.session.user_id)) return denied();
      const chosenScope: Task["scope"] = selectedQueue?.scope ?? (selectedQueue ? { kind: "queue", id: selectedQueue.queue_id } : clone(data.scope) as Task["scope"]);
      const task: Task = {
        season_id: String(data.season_id),
        scope: chosenScope,
        title: String(data.title),
        description: publicSubmission(data.description),
        deadline_at: String(data.deadline_at),
        task_id: id("task"),
        ...stage2.value,
        task_key: `TASK-${state.tasks.length + 1}`, status: "open", created_by: clone(state.user), created_at: mockNow, updated_at: mockNow,
        scope_title: chosenScope.kind === "queue" ? selectedQueue?.name : chosenScope.kind === "block" ? state.blocks.find(b => b.block_id === chosenScope.id)?.name : state.subevents.find(t => t.subevent_id === chosenScope.id)?.title,
        attachments: [], submissions: [], revision: 1,
        capabilities: ["change_task_status", "join_task", "watch_task", "remove_task_assignee", "submit_task_result", "edit_task_description", "edit_task", "comment_task", "view_assessment_inputs", "attach_task_file", "review_task", ...(((data.assignees ?? []) as { user_id: number }[]).some(a => a.user_id === state.session.user_id) ? ["start_task", "resume_task", "request_task_help", "submit_task_result"] : [])],
        assignments: (
          (data.assignees ?? []) as { user_id: number; hours: number }[]
        ).map((a) => ({
          assignment_id: id("assignment"),
          assignee: state.people.find((p) => p.user_id === a.user_id)!,
          status: "assigned",
          submissions: [],
          assignee_unavailable_reason: null,
          review_note: null,
          revision: 1,
          capabilities: [
            "review_assignment",
            "view_assessment_inputs",
            "edit_assessment_inputs",
            "reassign_assignment",
            ...(a.user_id === state.session.user_id
              ? ["start_assignment", "request_help", "submit_result"]
              : []),
          ],
        })),
      };
      if (!task.deadline_at) return fail(422, "invalid_input", "Для обычной задачи нужен срок");
      taskInputs.set(task.task_id, {
        task_id: task.task_id,
        assigned_at: mockNow,
        deadline_at: task.deadline_at,
        criteria: clone(data.criteria) as TaskInputs["criteria"],
        revision: 1,
        capabilities: inputsCaps(),
      });
      task.assignments.forEach((a, i) =>
        state.assessments.push({
          assignment_id: a.assignment_id,
          hours: ((data.assignees ?? []) as { hours?: number }[])[i].hours ?? 0,
          evaluation: null,
          effective_completed_at: null,
          revision: 1,
          capabilities: inputsCaps(),
        }),
      );
      const queue = state.queues.find(q => q.queue_id === data.queue_id || (!data.queue_id && q.scope?.id === task.scope.id && q.scope?.kind === task.scope.kind));
      if (queue) { task.queue = { queue_id: queue.queue_id, name: queue.name, key: queue.key };task.task_key = `${queue.key}-${state.tasks.filter(t => t.queue?.queue_id === queue.queue_id).length + 1}`; }
      if (typeof data.parent_task_id === "string") { const parent = state.tasks.find(t => t.task_id === data.parent_task_id);if (parent) { task.parent_task_id = parent.task_id;task.parent_task = { task_id: parent.task_id, task_key: parent.task_key!, title: parent.title }; } }
      task.assignees = task.assignments.map(a => a.assignee);task.watchers = ((data.watcher_user_ids ?? []) as number[]).map(uid => state.people.find(p => p.user_id === uid)!).filter(Boolean);task.attachments = taskFiles(data.file_ids);refreshRoster(task);
      state.tasks.push(task);rememberTask(task, "task_created", "Создана задача");
      return [201, visibleTask(task)];
    }
    if (parts[0] === "tasks") {
      const task = state.tasks.find((t) => t.task_id === parts[1]);
      if (!task) return fail(404, "not_found", "Задача недоступна");
      if (!readsTask(task))
        return method === "get" ? fail(404, "not_found", "Задача недоступна") : denied();
      const managesAccess=task.created_by?.user_id===state.session.user_id||state.queues.find(queue=>queue.queue_id===task.queue?.queue_id)?.owner?.user_id===state.session.user_id;
      if(parts[2]==="mention-candidates")return list(clone(state.people));
      if(parts[2]==="mentions") {
        if(method==="get")return list(clone(managesAccess?mentionRequests.filter(row=>row.task_id===task.task_id):[]));
        if(!managesAccess)return denied();const row=mentionRequests.find(row=>row.request_id===parts[3]&&row.task_id===task.task_id);
        if(!row)return fail(404,"not_found","Призыв недоступен");if(mismatch(data,row))return conflict();if(row.status!=="pending")return fail(409,"conflict","Призыв уже обработан");
        row.status=parts[4]==="approve"?"approved":"rejected";row.revision++;row.capabilities=row.status==="approved"?["revoke_task_access"]:[];
        if(row.status==="approved"&&row.target?.user_id){const ids=taskGrants.get(task.task_id)??new Set<number>();ids.add(row.target.user_id);taskGrants.set(task.task_id,ids);}return [200,clone(row)];
      }
      if(parts[2]==="access") {if(!managesAccess)return denied();const uid=Number(parts[3]);taskGrants.get(task.task_id)?.delete(uid);mentionRequests.filter(row=>row.task_id===task.task_id&&row.target?.user_id===uid).forEach(row=>row.capabilities=[]);return [200,{revoked:true}];}
      if(parts[2]==="description-checklist") {
        if(mismatch(data,task))return conflict();const neutral=(body:string)=>body.replace(/^( {0,3}(?:[-+*]|\d+[.)])[ \t]+\[)[ xX](\])/gm,"$1 $2");
        if(typeof data.body!=="string"||neutral(task.description.body)!==neutral(data.body))return denied();
        const before=task.description.body;task.description=richText(data.body);task.revision++;rememberTask(task,"task_updated","Изменены отметки чеклиста",undefined,undefined,[{field:"description",before,after:data.body}]);return [200,visibleTask(task)];
      }
      if (parts[2] === "accounting-batch") {
        if (!task.capabilities.includes("view_assessment_inputs")) return denied();
        if (publicStatus(task.status) !== "closed") return fail(409,"task_not_closed","Сначала закройте задачу");
        const inputs=taskInputs.get(task.task_id)??{...clone(state.inputs),task_id:task.task_id,deadline_at:task.deadline_at};taskInputs.set(task.task_id,inputs);
        const assessments=task.assignments.map(assignment=>({assignment,inputs:state.assessments.find(row=>row.assignment_id===assignment.assignment_id)!}));
        const closed=state.seasons.find(season=>season.season_id===task.season_id)?.state==="closed";
        if(method==="put"){
          if(!inputs.capabilities.includes("edit_assessment_inputs"))return denied();
          if(data.expected_public_revision!==task.revision||data.expected_revision!==inputs.revision)return conflict();
          const given=data.assignments as {assignment_id:string;expected_revision:number;hours:number|null;evaluation:-1|0|1|1.5|null;excluded:boolean}[];
          if(!Array.isArray(given)||given.length!==assessments.length||new Set(given.map(row=>row.assignment_id)).size!==assessments.length)return conflict();
          for(const value of given){const row=assessments.find(item=>item.assignment.assignment_id===value.assignment_id);if(!row||value.expected_revision!==row.inputs.revision)return conflict();if(!value.excluded&&(value.hours===null||!Number.isFinite(value.hours)||value.hours<0||value.evaluation===null))return fail(422,"missing_assessment","Заполните часы и оценки");}
          if(closed&&!data.reason)return fail(422,"invalid_input","Укажите причину исправления");
          if(JSON.stringify(inputs.criteria)!==JSON.stringify(data.criteria)){inputs.criteria=clone(data.criteria) as TaskInputs["criteria"];inputs.revision++;}
          for(const value of given){const row=assessments.find(item=>item.assignment.assignment_id===value.assignment_id)!;row.inputs.hours=value.hours;row.inputs.evaluation=value.excluded?null:value.evaluation;row.inputs.workflow_status=value.excluded?"cancelled":value.evaluation!>0?"accepted":"not_completed";row.inputs.effective_completed_at=task.closed_at??row.inputs.effective_completed_at;row.inputs.revision++;}
        }
        return [200,{task_id:task.task_id,public_revision:task.revision,revision:inputs.revision,criteria:clone(inputs.criteria),closed_at:task.closed_at??null,season_closed:closed,assigned_at:inputs.assigned_at,deadline_at:task.deadline_at,capabilities:clone(inputs.capabilities),assignments:assessments.map(({assignment,inputs:row})=>({assignment_id:assignment.assignment_id,assignee:clone(assignment.assignee),hours:row.hours,evaluation:row.evaluation,excluded:row.workflow_status==="cancelled",effective_completed_at:row.effective_completed_at,revision:row.revision,is_current:true}))}];
      }
      if (parts[2] === "history") return list((taskHistory.get(task.task_id) ?? []).map(event => {
        const result = clone(event), targetId = linkHistoryTargets.get(event.event_id), target = state.tasks.find(item => item.task_id === targetId);
        if (targetId && (!target || !readsTask(target))) result.changes = [{ field: "links", label: "Связь недоступна", before: null, after: null }];return result;
      }));
      hydrateTask(task);
      if (parts[2] === "checklist" && parts[4] === "toggle" && parts.length === 5 && method === "post") {
        const extra = extraInputs(data, ["checked"]);if (extra) return extra;
        if (!Number.isInteger(data.expected_revision) || typeof data.checked !== "boolean") return fail(422, "invalid_input", "Укажите версию задачи и состояние пункта");
        if (mismatch(data, task)) return conflict();
        const item = task.checklist?.find(entry => entry.item_id === parts[3]);
        if (!item) return fail(404, "not_found", "Пункт чеклиста недоступен");
        if (item.checked === data.checked) return [200, visibleTask(task)];
        const before = (task.checklist ?? []).map(entry => `- [${entry.checked ? "x" : " "}] ${entry.text}`);
        item.checked = data.checked;
        const after = (task.checklist ?? []).map(entry => `- [${entry.checked ? "x" : " "}] ${entry.text}`);
        rememberTask(task, "task_updated", "Изменена отметка чеклиста", undefined, undefined, [{ field: "checklist", label: "Чеклист", before, after }]);
        task.revision++;return [200, visibleTask(task)];
      }
      if (parts[2] === "favorite" && method === "post") {
        if (Object.keys(data).some(key => key !== "favorite") || typeof data.favorite !== "boolean") return fail(422, "invalid_input", "Укажите состояние избранного");
        const saved = personalFavorites.get(state.session.user_id) ?? new Set<string>();
        if (data.favorite) saved.add(task.task_id);else saved.delete(task.task_id);personalFavorites.set(state.session.user_id, saved);
        return [200, visibleTask(task)];
      }
      if (parts[2] === "links") {
        if (!task.capabilities.includes("manage_task_links")) return denied();
        if (!Number.isInteger(data.expected_revision)) return fail(422, "invalid_input", "Укажите версию задачи");
        if (mismatch(data, task)) return conflict();
        if (parts.length === 4 && method === "delete") {
          const extra = extraInputs(data, []);if (extra) return extra;
          const at = taskLinks.findIndex(link => link.link_id === parts[3] && (link.source === task.task_id || link.target === task.task_id));
          if (at < 0) return fail(404, "not_found", "Связь недоступна");
          const link = taskLinks[at], other = state.tasks.find(item => item.task_id === (link.source === task.task_id ? link.target : link.source));if (!other || !readsTask(other)) return fail(404, "not_found", "Связь недоступна");
          taskLinks.splice(at, 1);task.revision++;other.revision++;rememberLink(task, other, false);rememberLink(other, task, false);return [200, visibleTask(task)];
        }
        if (parts.length !== 3 || method !== "post") return fail(404, "not_found", "Действие недоступно");
        const extra = extraInputs(data, ["target_task_id", "kind"]);if (extra) return extra;
        const other = state.tasks.find(item => item.task_id === data.target_task_id && readsTask(item));
        if (!other) return fail(404, "not_found", "Задача недоступна");
        if (other.task_id === task.task_id || other.season_id !== task.season_id) return fail(422, "invalid_input", "Недопустимая связь задач");
        const requested = String(data.kind) as TaskLinkKind;
        if (!["related", "blocks", "blocked_by", "epic", "epic_member", "milestone", "milestone_member"].includes(requested)) return fail(422, "invalid_input", "Неизвестный тип связи");
        let source = task, target = other, kind: "related" | "blocks" | "epic" | "milestone";
        if (["blocked_by", "epic_member", "milestone_member"].includes(requested)) { source = other;target = task;kind = requested === "blocked_by" ? "blocks" : requested === "epic_member" ? "epic" : "milestone"; }
        else kind = requested as typeof kind;
        if (kind === "related" && source.task_id > target.task_id) [source, target] = [target, source];
        if (taskLinks.some(link => link.kind === kind && link.source === source.task_id && link.target === target.task_id)) return [200, visibleTask(task)];
        if (kind === "blocks" && linksReach(target.task_id, source.task_id)) return fail(422, "invalid_input", "Зависимости образуют цикл");
        if ((kind === "epic" || kind === "milestone") && ((source.task_type ?? "task") !== "task" || (target.task_type ?? "task") !== kind)) return fail(422, "invalid_input", "Типы задач несовместимы с этой связью");
        if (kind === "epic" && taskLinks.some(link => link.kind === "epic" && link.source === source.task_id)) return fail(409, "task_epic_conflict", "У задачи уже есть эпик");
        taskLinks.push({ link_id: id("task-link"), source: source.task_id, target: target.task_id, kind });
        task.revision++;other.revision++;rememberLink(task, other, true);rememberLink(other, task, true);return [200, visibleTask(task)];
      }
      if (parts[2] === "take" && method === "post") {
        const extra = extraInputs(data, []);if (extra) return extra;
        if (!Number.isInteger(data.expected_revision)) return fail(422, "invalid_input", "Укажите версию задачи");
        if (mismatch(data, task)) return conflict();refreshRoster(task);
        const assigned = task.assignees!.some(person => person.user_id === state.session.user_id), previous = task.status ?? "assigned";
        if (assigned && previous === "in_progress" && !task.legacy_mixed_statuses) return [200, visibleTask(task)];
        if (!assigned) task.assignees!.push(clone(state.user));task.watchers = task.watchers!.filter(person => person.user_id !== state.session.user_id);
        let assignment = task.assignments.find(item => item.assignee.user_id === state.session.user_id);
        if (!assignment) {
          const aid = id("assignment");assignment = { assignment_id: aid, assignee: clone(state.user), status: "in_progress", submissions: [], assignee_unavailable_reason: null, review_note: null, revision: 1, capabilities: [] };task.assignments.push(assignment);
          state.assessments.push({ assignment_id: aid, hours: 0, evaluation: null, effective_completed_at: null, revision: 1, workflow_revision: 1, workflow_status: "assigned", capabilities: state.manager && task.scope.kind !== "queue" ? inputsCaps() : [] });
        }
        assignment.assignee_unavailable_reason = null;task.status = "in_progress";task.legacy_mixed_statuses = false;
        task.assignments.filter(item => task.assignees!.some(person => person.user_id === item.assignee.user_id)).forEach(item => { item.status = "in_progress";item.revision++; });
        task.revision++;refreshRoster(task);
        if (!assigned) rememberTask(task, "task_people_updated", "Изменён состав задачи");
        if (previous !== "in_progress") rememberTask(task, "status_changed", "Изменён рабочий статус задачи", previous, "in_progress");
        return [200, visibleTask(task)];
      }
      if (parts[2] === "status") return transitionTask(task, data);
      if (parts[2] === "submit-result") {
        if (mismatch(data, task)) return conflict();
        const body = publicSubmission(data.text), links = (data.links ?? []) as string[], ids = (data.file_ids ?? []) as string[];
        if (!body.body.trim() && !links.length && !ids.length) return fail(422, "invalid_input", "Добавьте результат работы, ссылку или файл");
        const result = { submission_id: id("submission"), submitted_at: mockNow, submitted_by: clone(state.user), text: body, links, files: taskFiles(ids) };
        task.submissions ??= [];task.submissions.push(result);return transitionTask(task, { expected_revision: task.revision, status: "submitted" });
      }
      if(parts[2]==="watchers"&&parts[4]==="remove") {
        if(!task.capabilities.includes("remove_task_watcher"))return denied();if(mismatch(data,task))return conflict();
        const uid=Number(parts[3]);if(!task.watchers?.some(person=>person.user_id===uid))return fail(404,"not_found","Наблюдатель недоступен");task.watchers=task.watchers.filter(person=>person.user_id!==uid);refreshRoster(task);rememberTask(task,"roster_changed","Изменён состав задачи");return changed(task);
      }
      if(parts[2]==="assignees"&&parts[4]==="add") {
        if(!task.capabilities.includes("assign_task_participants"))return denied();if(mismatch(data,task))return conflict();
        const person=state.people.find(person=>person.user_id===Number(parts[3]));if(!person)return fail(422,"invalid_input","Участник недоступен");
        task.assignees??=[];if(task.assignees.some(row=>row.user_id===person.user_id))return [200,visibleTask(task)];task.assignees.push(clone(person));task.watchers=task.watchers?.filter(row=>row.user_id!==person.user_id);
        if(!task.assignments.some(row=>row.assignee.user_id===person.user_id)){const aid=id("assignment");task.assignments.push({assignment_id:aid,assignee:clone(person),status:assignmentStatus(publicStatus(task.status)),revision:1,capabilities:[],submissions:[],assignee_unavailable_reason:null,review_note:null});state.assessments.push({assignment_id:aid,hours:0,evaluation:null,effective_completed_at:null,revision:1,workflow_revision:1,workflow_status:"assigned",capabilities:inputsCaps()});}
        refreshRoster(task);rememberTask(task,"roster_changed","Изменён состав задачи");return changed(task);
      }
      if (["join", "watch", "unwatch"].includes(parts[2]) || parts[2] === "assignees") {
        if(parts[2]==="assignees"&&!task.capabilities.includes("remove_task_assignee"))return denied();
        if (mismatch(data, task)) return conflict();refreshRoster(task);
        if (parts[2] === "join") {
          if (!task.assignees!.some(p => p.user_id === state.session.user_id)) task.assignees!.push(clone(state.user));
          task.watchers = task.watchers!.filter(p => p.user_id !== state.session.user_id);
          if (!task.assignments.some(a => a.assignee.user_id === state.session.user_id)) {
            const aid = id("assignment");task.assignments.push({ assignment_id: aid, assignee: clone(state.user), status: assignmentStatus(publicStatus(task.status)), submissions: [], assignee_unavailable_reason: null, review_note: null, revision: 1, capabilities: [] });
            state.assessments.push({ assignment_id: aid, hours: 0, evaluation: null, effective_completed_at: null, revision: 1, workflow_revision: 1, workflow_status: "assigned", capabilities: state.manager && task.scope.kind !== "queue" ? inputsCaps() : [] });
          }
        } else if (parts[2] === "watch") { if (!task.watchers!.some(p => p.user_id === state.session.user_id)) task.watchers!.push(clone(state.user)); }
        else if (parts[2] === "unwatch") task.watchers = task.watchers!.filter(p => p.user_id !== state.session.user_id);
        else {
          const uid = Number(parts[3]), person = task.assignees!.find(p => p.user_id === uid);if (!person) return fail(404, "not_found", "Исполнитель не найден");
          task.assignees = task.assignees!.filter(p => p.user_id !== uid);if (!task.watchers!.some(p => p.user_id === uid)) task.watchers!.push(person);
        }
        refreshRoster(task);rememberTask(task, "task_people_updated", "Изменён состав задачи");return changed(task);
      }
      if (parts[2] === "comments") {
        if (method === "get")
          return list(
            clone(state.comments.filter((c) => c.task_id === task.task_id).map(comment => ({...comment,mentioned_users:commentMentions(comment.content.body)}))),
          );
        const attachments=commentFiles(data.file_ids??[],task.task_id);if(!attachments)return fail(422,"invalid_input","Некорректные файлы комментария");
        if(!publicSubmission(data.content).body.trim()&&!attachments.length)return fail(422,"invalid_input","Добавьте текст или файл");
        const comment = {
          attachments,
          comment_id: id("comment"),
          task_id: task.task_id,
          author: state.user,
          content: publicSubmission(data.content),
          created_at: mockNow,
          updated_at: null,
          capabilities: ["edit_comment"],
          mentioned_users: commentMentions(publicSubmission(data.content).body),
        };
        const mentions=(data.mentioned_user_ids??[]) as number[];
        if(!Array.isArray(mentions)||mentions.some(uid=>!state.people.some(person=>person.user_id===uid)))return fail(422,"invalid_input","Участник недоступен");
        for(const uid of new Set(mentions)){if(!mentionRequests.some(row=>row.task_id===task.task_id&&row.target?.user_id===uid&&row.status==="pending"))mentionRequests.push({request_id:id("mention"),task_id:task.task_id,task_key:task.task_key??null,target:clone(state.people.find(person=>person.user_id===uid)!),requested_by:clone(state.user),comment_id:comment.comment_id,status:"pending",created_at:mockNow,revision:1,capabilities:["approve_task_mention","reject_task_mention"]});}
        state.comments.push(comment);rememberTask(task, "comment_added", "Добавлен комментарий");
        return [201, clone(comment)];
      }
      if (parts[2] === "assessment-inputs") {
        if (!task.deadline_at || !task.season_id) return denied();
        if (!task.capabilities.includes("view_assessment_inputs"))
          return denied();
        const inputs = taskInputs.get(task.task_id) ?? {
          ...clone(state.inputs),
          task_id: task.task_id,
          assigned_at: mockNow,
          deadline_at: task.deadline_at,
        };
        taskInputs.set(task.task_id, inputs);
        if (method === "patch") {
          if ((data.assigned_at || data.deadline_at) && !inputs.capabilities.includes("edit_assessment_dates"))
            return denied();
          if (mismatch(data, inputs)) return conflict();
          Object.assign(inputs, data);
          inputs.revision++;
          task.deadline_at = inputs.deadline_at;
        }
        return [200, clone(inputs)];
      }
      if (method === "get") return [200, visibleTask(task)];
      const extraTask = extraInputs(data, ["title", "description", "parent_task_id", "file_ids", "task_type", "priority", "starts_at", "checklist"]);if (extraTask) return extraTask;
      if (!Number.isInteger(data.expected_revision)) return fail(422, "invalid_input", "Укажите версию задачи");
      if (mismatch(data, task)) return conflict();
      if ("task_type" in data && !task.capabilities.includes("change_task_type")) return denied();
      if ("priority" in data && !task.capabilities.includes("change_task_priority")) return denied();
      if ("starts_at" in data && !task.capabilities.includes("edit_task_metadata")) return denied();
      if ("checklist" in data && !task.capabilities.includes("edit_task_checklist")) return denied();
      const hasClassic = ["title", "description", "parent_task_id", "file_ids"].some(key => key in data);
      if (hasClassic && !publicTaskWritable(task)) return denied();
      if (["title", "parent_task_id", "file_ids"].some(key => key in data) && !task.capabilities.includes("edit_task")) return denied();
      if ("description" in data && !task.capabilities.includes("edit_task_description") && !task.capabilities.includes("edit_task")) return denied();
      const stage2 = stage2Patch(data, task);if (stage2.error) return stage2.error;
      const changes: TaskHistoryChange[] = [];
      for (const field of ["task_type", "priority", "starts_at"] as const) {
        if ((field in data || field === "starts_at" && "task_type" in data && data.task_type === "milestone" && !("starts_at" in data)) && stage2.value![field] !== task[field]) changes.push({ field, label: field === "task_type" ? "Тип задачи" : field === "priority" ? "Приоритет" : "Плановое начало", before: task[field] ?? null, after: stage2.value![field] ?? null });
      }
      if ("checklist" in data && JSON.stringify(stage2.value!.checklist) !== JSON.stringify(task.checklist)) changes.push({ field: "checklist", label: "Чеклист", before: (task.checklist ?? []).map(item => `- ${item.checked ? "[x]" : "[ ]"} ${item.text}`), after: (stage2.value!.checklist ?? []).map(item => `- ${item.checked ? "[x]" : "[ ]"} ${item.text}`) });
      if (typeof data.title === "string" && data.title !== task.title) changes.push({ field: "title", label: "Название", before: task.title, after: data.title });
      if (data.description && publicSubmission(data.description).body !== task.description.body) changes.push({ field: "description", label: "Описание", before: task.description.body, after: publicSubmission(data.description).body });
      if ("parent_task_id" in data) {
        const parent = state.tasks.find(t => t.task_id === data.parent_task_id && readsTask(t));
        if (data.parent_task_id && (!parent || parent.task_id === task.task_id || parent.season_id !== task.season_id)) return fail(422, "invalid_input", "Недопустимая родительская задача");
        const before = task.parent_task?.task_key ?? null;task.parent_task_id = parent?.task_id ?? null;task.parent_task = parent ? { task_id: parent.task_id, task_key: parent.task_key!, title: parent.title } : null;
        changes.push({ field: "parent_task", label: "Родительская задача", before, after: parent?.task_key ?? null });
      }
      Object.assign(task, stage2.value);
      if (data.file_ids) task.attachments = taskFiles(data.file_ids);
      if (typeof data.title === "string") task.title = data.title;
      if (data.description) task.description = publicSubmission(data.description);
      if (changes.length || hasClassic) {
        rememberTask(task, "task_updated", "Обновлена задача", undefined, undefined, changes);
        task.revision++;
      }
      return [200, visibleTask(task)];
    }
    if (path === "/assignments/unresolved")
      return state.manager
        ? list(
            state.tasks.flatMap((t) =>
              t.assignments
                .filter(
                  (a) =>
                    a.capabilities.includes("reassign_assignment") &&
                    !["accepted", "not_completed", "cancelled"].includes(
                      a.status,
                    ),
                )
                .map((assignment) => ({
                  assignment: clone(assignment),
                  task_id: t.task_id,
                  task_title: t.title,
                  season_id: t.season_id,
                  scope: t.scope,
                  deadline_at: t.deadline_at,
                })),
            ),
          )
        : denied();
    if (parts[0] === "assignments") {
      const task = state.tasks.find((t) =>
        t.assignments.some((a) => a.assignment_id === parts[1]),
      );
      const assignment = task?.assignments.find(
        (a) => a.assignment_id === parts[1],
      );
      if (!task || !assignment)
        return fail(404, "not_found", "Назначение недоступно");
      if (parts[2] === "assessment-inputs") {
        if (!assignment.capabilities.includes("view_assessment_inputs"))
          return denied();
        let assessment = state.assessments.find(
          (a) => a.assignment_id === assignment.assignment_id,
        );
        if (!assessment) {
          assessment = {
            assignment_id: assignment.assignment_id,
            workflow_status: "assigned", workflow_revision: assignment.revision,
            hours: 2,
            evaluation: null,
            effective_completed_at: null,
            revision: assignment.revision,
            capabilities: inputsCaps(),
          };
          state.assessments.push(assessment);
        }
        if (method === "patch") {
          if (data.effective_completed_at && !assessment.capabilities.includes("edit_assessment_dates"))
            return denied();
          if (mismatch(data, assessment)) return conflict();
          let observedDate = assessment.effective_completed_at;
          if (Number(data.evaluation) > 0 && !data.effective_completed_at && !observedDate) {
            observedDate = [...(task.submissions ?? []), ...task.assignments.flatMap(a => a.submissions)].map(s => s.submitted_at).sort().at(-1) ?? null;
            if (!observedDate) return fail(422, "invalid_input", "Для оценки нужна фактическая сдача или разрешённая расчётная дата");
          }
          Object.assign(assessment, data);
          if (!assessment.effective_completed_at && observedDate) assessment.effective_completed_at = observedDate;
          assessment.revision++;
          // Inputs have their own revision; the assignee's moves only with the status.
          if (typeof data.evaluation === "number") assessment.workflow_status = data.evaluation >= 1 ? "accepted" : "not_completed";
          assessment.workflow_revision = assessment.revision;
        }
        return [200, clone(assessment)];
      }
      const privateReview = ["accept", "request-revision", "not-complete", "cancel"].includes(parts[2]);
      const privateInputs = state.assessments.find(a => a.assignment_id === assignment.assignment_id);
      if (mismatch(data, privateReview && privateInputs ? { revision: privateInputs.workflow_revision ?? privateInputs.revision } : assignment)) return conflict();
      const own = assignment.assignee.user_id === state.session.user_id;
      if (
        ["start", "resume", "request-help", "submit"].includes(parts[2])
          ? !own
          : !assignment.capabilities.includes("review_assignment")
      )
        return denied();
      if (parts[2] === "reassign") {
        if (
          ["accepted", "not_completed", "cancelled"].includes(assignment.status)
        )
          return conflict();
        const previous = clone(assignment);
        assignment.status =
          data.previous_outcome === "cancelled" ? "cancelled" : "not_completed";
        assignment.review_note = String(data.reason);
        assignment.revision++;
        const next = {
          ...clone(previous),
          assignment_id: id("assignment"),
          assignee: state.people.find(
            (p) => p.user_id === data.new_assignee_user_id,
          )!,
          status: "assigned" as const,
          submissions: [],
          revision: 1,
          assignee_unavailable_reason: null,
          review_note: null,
        };
        const previousInputs = state.assessments.find(
          (a) => a.assignment_id === assignment.assignment_id,
        );
        if (previousInputs) {
          previousInputs.evaluation =
            data.previous_outcome === "cancelled"
              ? null
              : (data.evaluation as 0 | -1);
          previousInputs.revision++;
        }
        state.assessments.push({
          assignment_id: next.assignment_id,
          hours: Number(data.hours),
          evaluation: null,
          effective_completed_at: null,
          revision: 1,
          capabilities: inputsCaps(),
        });
        task.assignments.push(next);
        return [
          200,
          { previous_assignment: clone(assignment), assignment: clone(next) },
        ];
      }
      const statuses: Record<string, AssignmentStatus> = { start: "in_progress", resume: "in_progress", "request-help": "help_required", submit: "submitted", accept: "accepted", "request-revision": "needs_revision", "not-complete": "not_completed", cancel: "cancelled" };
      const next = statuses[parts[2]];
      if (!next) return fail(404, "not_found", "Команда не найдена");
      const allowed: Record<string, string[]> = { start: [], resume: [], "request-help": ["message"], submit: ["text", "links", "file_ids"], accept: ["evaluation", "review_note"], "request-revision": ["review_note"], "not-complete": ["evaluation", "reason"], cancel: ["reason"] };
      const extra = extraInputs(data, allowed[parts[2]]);if (extra) return extra;
      if (privateReview) {
        const observedDate = privateInputs?.effective_completed_at ?? [...(task.submissions ?? []), ...task.assignments.flatMap(a => a.submissions)].map(s => s.submitted_at).sort().at(-1) ?? null;
        if (next === "accepted" && !observedDate) return fail(422, "invalid_input", "Для приёмки нужна фактическая сдача");
        if (privateInputs) {
          if (next === "accepted" && !privateInputs.effective_completed_at) privateInputs.effective_completed_at = observedDate;
          privateInputs.workflow_status = next;privateInputs.workflow_revision = (privateInputs.workflow_revision ?? privateInputs.revision) + 1;privateInputs.revision++;
          if (["accepted", "not_completed"].includes(next)) privateInputs.evaluation = Number(data.evaluation) as -1 | 0 | 1 | 1.5;
          if (next === "cancelled") privateInputs.evaluation = null;
        }
        return [200, clone(assignment)];
      }
      if (next === "submitted") {
        const result = { submission_id: id("submission"), submitted_at: mockNow, submitted_by: clone(state.user), text: publicSubmission(data.text), links: (data.links ?? []) as string[], files: taskFiles(data.file_ids) };task.submissions ??= [];task.submissions.push(result);assignment.submissions.push(clone(result));
      }
      const response = transitionTask(task, { expected_revision: task.revision, status: next });
      return response[0] === 200 ? [200, clone(assignment)] : response;
    }
    if (path === "/assessment-inputs/bulk-hours") {
      if (!state.manager) return denied();
      const items = data.items as {
        assignment_id: string;
        expected_revision: number;
      }[];
      if (
        items.some(
          (item) =>
            state.assessments.find(
              (a) => a.assignment_id === item.assignment_id,
            )?.revision !== item.expected_revision,
        )
      )
        return conflict();
      const changedItems = state.assessments.filter((a) =>
        items.some((i) => i.assignment_id === a.assignment_id),
      );
      changedItems.forEach((a) => {
        a.hours = Number(data.hours);
        a.revision++;
      });
      return [200, { items: clone(changedItems) }];
    }
    if (parts[0] === "comments") {
      const comment = state.comments.find((c) => c.comment_id === parts[1]);
      const task = comment && state.tasks.find(t => t.task_id === comment.task_id);
      if (!comment || !task || !readsTask(task)) return denied();
      const attachments=data.file_ids===undefined?comment.attachments:commentFiles(data.file_ids,task.task_id,comment.attachments);
      if(!attachments)return fail(422,"invalid_input","Некорректные файлы комментария");
      if(!publicSubmission(data.content).body.trim()&&!attachments.length)return fail(422,"invalid_input","Добавьте текст или файл");
      const before = comment.content.body;
      comment.attachments=attachments;
      comment.content = publicSubmission(data.content);
      comment.mentioned_users = commentMentions(comment.content.body);
      rememberTask(task, "comment_edited", "Комментарий отредактирован", undefined, undefined, [{ field: "comment", label: "Комментарий", before, after: comment.content.body }]);
      comment.updated_at = mockNow;
      return [200, clone(comment)];
    }
    if (parts[0] === "reports" || path === "/report-history") {
      if (parts.length === 1) {
        if (method === "get")
          return list(
            state.reports
              .filter(
                (r) =>
                  (r.state === "published" ||
                    r.capabilities.includes("edit_report")) &&
                  (path !== "/report-history" || r.state === "published") &&
                  (!url.searchParams.get("owner_id") ||
                    r.owner_id === url.searchParams.get("owner_id")) &&
                  (!url.searchParams.get("series_id") ||
                    r.report_series_id === url.searchParams.get("series_id")) &&
                  (!url.searchParams.get("year") ||
                    r.published_at?.startsWith(url.searchParams.get("year")!)),
              )
              .map(visibleReport),
          );
        if (!state.manager) return denied();
        const report: Report = {
          ...(data as unknown as Report),
          report_id: id("report"),
          season_id: "season-1",
          report_series_id:
            data.owner_kind === "event" ? "series-event-1" : "series-sub-1",
          content: publicSubmission(data.content),
          files: [],
          draft_content: publicSubmission(data.content),
          draft_title: String(data.title),
          draft_files: [],
          state: "draft",
          published_at: null,
          published_version: null,
          revision: 1,
          capabilities: [
            "edit_report",
            "publish_report",
            "view_report_versions",
          ],
        };
        state.reports.push(report);
        return [201, clone(report)];
      }
      const report = state.reports.find((r) => r.report_id === parts[1]);
      if (!report) return fail(404, "not_found", "Отчёт недоступен");
      if (parts[2] === "versions")
        return report.capabilities.includes("view_report_versions")
          ? list(clone(versions.get(report.report_id) ?? []))
          : fail(404, "not_found", "Отчёт недоступен");
      if (method === "get")
        return report.state === "published" ||
          report.capabilities.includes("edit_report")
          ? [200, visibleReport(report)]
          : fail(404, "not_found", "Отчёт недоступен");
      if (!report.capabilities.includes("edit_report")) return denied();
      if (mismatch(data, report)) return conflict();
      if (parts[2] === "publish") {
        report.title = report.draft_title ?? report.title;
        report.content = clone(report.draft_content ?? report.content);
        report.files = clone(report.draft_files ?? report.files);
        report.state = "published";
        report.published_at = mockNow;
        report.published_version = (report.published_version ?? 0) + 1;
      } else {
        if (data.title) report.draft_title = String(data.title);
        if (data.content) report.draft_content = publicSubmission(data.content);
        if (data.file_ids)
          report.draft_files = (data.file_ids as string[])
            .map((fid) => files.get(fid)!)
            .filter(Boolean);
      }
      if (parts[2] === "publish")
        versions.set(report.report_id, [
          ...(versions.get(report.report_id) ?? []),
          snapshot(report),
        ]);
      return changed(report);
    }
    // As on the server: editors get the stored text, readers no draft.
    const materialView = (m: Material) => {
      const result = clone(m);
      if (m.capabilities.includes("edit_material"))
        result.source_content = clone(m.draft_content ?? m.published_content ?? richText(""));
      else delete result.draft_content;
      return result;
    };
    if (parts[0] === "materials" && parts[1] === "legacy-guides") {
      const material = state.materials.find(item => item.material_id === legacyMaterialIds.get(Number(parts[2])));
      if (method !== "get" || !material || (!material.published_content && !material.capabilities.includes("edit_material"))) return fail(404, "not_found", "Гайд недоступен");
      return [200, { guide_id: Number(parts[2]), material_id: material.material_id, revision: material.revision }];
    }
    if (path === "/materials") {
      if (method === "get")
        return list(
          state.materials
            .filter(
              (m) =>
                m.published_content || m.capabilities.includes("edit_material"),
            )
            .map(materialView),
        );
      if (!state.session.capabilities.includes("create_material"))
        return denied();
      if (data.kind !== "guide" && !state.session.capabilities.includes("create_shared_material"))
        return denied();
      const material: Material = {
        ...(data as unknown as Material),
        material_id: id("material"),
        owner_block_id: String(data.owner_block_id ?? "") || null,
        published_content: null,
        draft_content: publicSubmission(data.content),
        original_link: null,
        revision: 1,
        capabilities: ["edit_material", "publish_material", "delete_material"],
      };
      state.materials.push(material);
      return [201, materialView(material)];
    }
    if (path === "/materials/deleted") {
      if (!state.session.capabilities.includes("restore_material")) return denied();
      return list(state.deletedMaterials.map((m) => ({ ...clone(m), published_content: null, capabilities: ["restore_material"] })));
    }
    if (parts[0] === "materials" && parts[2] === "restore") {
      if (!state.session.capabilities.includes("restore_material")) return denied();
      const deleted = state.deletedMaterials.find((m) => m.material_id === parts[1]);
      if (!deleted) return fail(409, "conflict", "Материал не удалён");
      if (mismatch(data, deleted)) return conflict();
      state.deletedMaterials = state.deletedMaterials.filter((m) => m !== deleted);
      state.materials.push(deleted);
      return changed(deleted);
    }
    if (parts[0] === "materials") {
      const material = state.materials.find((m) => m.material_id === parts[1]);
      if (!material) return fail(404, "not_found", "Материал недоступен");
      if (method === "get")
        return material.published_content ||
          material.capabilities.includes("edit_material")
          ? [200, materialView(material)]
          : denied();
      if (method === "delete") {
        if (!material.capabilities.includes("delete_material")) return denied();
        state.materials = state.materials.filter((m) => m !== material);
        material.revision += 1;
        state.deletedMaterials.push(material);  // reversible, as on the server
        return [200, {}];
      }
      if (!material.capabilities.includes("edit_material")) return denied();
      if (mismatch(data, material)) return conflict();
      if (parts[2] === "editors")
        return [
          200,
          {
            material_id: material.material_id,
            editor_user_ids: data.user_ids,
            revision: ++material.revision,
          },
        ];
      if (parts[2] === "audience") {
        if (!material.audience) return fail(422, "invalid_input", "Только у гайда блока есть читатели");
        material.audience = data.audience as "block" | "everyone";
        material.revision += 1;
        return [200, materialView(material)];
      }
      if (parts[2] === "publish")
        material.published_content = clone(
          material.draft_content ?? material.published_content,
        );
      else {
        if (data.content)
          material.draft_content = publicSubmission(data.content);
        if (data.title) material.title = String(data.title);
        if (data.description !== undefined)
          material.description = String(data.description);
        if (data.original_link !== undefined)
          material.original_link = data.original_link as string | null;
      }
      material.revision += 1;
      return [200, materialView(material)];
    }
    if (path === "/blocks") return [200, clone(state.blocks)];
    if (parts[0] === "blocks" && parts[2] === "hr" && method === "put") {
      const block = state.blocks.find(item => item.block_id === parts[1]);
      if (!block) return fail(404, "not_found", "Блок недоступен");
      if (!block.capabilities.includes("assign_block_hr")) return denied();
      if (mismatch(data, block)) return conflict();
      const person = data.user_id === null ? null : state.people.find(item => item.user_id === data.user_id);
      if (data.user_id !== null && !person) return fail(422, "invalid_input", "Выберите действующего участника");
      block.hr = person ? clone(person) : null;
      return changed(block);
    }
    if (parts[0] === "blocks") {
      const block = state.blocks.find((b) => b.block_id === parts[1]);
      if (!block) return fail(404, "not_found", "Блок не найден");
      if (method === "get") return [200, clone(block)];
      if (parts[2] === "leave") {
        return fail(403, "self_leave_forbidden", "Попросите руководителя блока или HR исключить вас из состава");
      }
      if (parts[2] === "members" && method === "delete") {
        if (!block.capabilities.includes("remove_member")) return denied();
        const uid = Number(parts[3]);
        if (uid === state.session.user_id) return fail(403, "self_leave_forbidden", "Самостоятельный выход недоступен");
        if (uid === block.master?.user.user_id || block.master?.deputy_user_ids.includes(uid))
          return fail(409, "active_block_leader", "Сначала передайте или снимите руководящую роль");
        block.members = block.members.filter(member => member.user.user_id !== uid);
        return [200, { block_id: block.block_id, membership_state: "left" }];
      }
      const avatarChange = Object.hasOwn(data, "avatar_file_id");
      if (avatarChange && !block.capabilities.includes("edit_block")) return denied();
      if (!state.manager && !avatarChange) return denied();
      if (mismatch(data, block)) return conflict();
      if (avatarChange) {
        const fid = data.avatar_file_id;
        const file = typeof fid === "string" ? files.get(fid) : undefined;
        if (fid !== null && (!file || !file.complete || file.owner_kind !== "block" || file.owner_id !== block.block_id || file.uploaded_by_user_id !== state.session.user_id)) return fail(422, "invalid_input", "Нужен завершённый собственный аватар блока");
        const previous = block.avatar_url?.match(/^\/api\/files\/([^/]+)\/content$/)?.[1];
        if (previous && previous !== fid) files.delete(decodeURIComponent(previous));
        block.avatar_url = typeof fid === "string" ? `/api/files/${encodeURIComponent(fid)}/content` : null;
        for (const task of state.tasks.filter(task => task.scope.kind === "block" && task.scope.id === block.block_id)) { task.scope_title = block.name;task.scope_avatar_url = block.avatar_url; }
      }
      if (parts[2] === "members")
        block.members = block.members.filter(
          (m) => m.user.user_id !== Number(parts[3]),
        );
      else if (parts[2] === "leader")
        block.master = {
          role_assignment_id: id("master"),
          user: state.people.find((p) => p.user_id === data.user_id)!,
          deputy_user_ids: [],
          revision: 1,
          capabilities: ["manage_deputies"],
        };
      else { const update = { ...data };delete update.avatar_file_id;Object.assign(block, update); }
      return changed(block);
    }
    if (parts[0] === "block-requests") {
      if (parts.length === 1 && method === "get")
        return list(
          state.requests
            .map((r) => ({ ...clone(r), capabilities: requestCapabilities(r) }))
            .filter(
              (r) =>
                state.global ||
                r.user.user_id === state.session.user_id ||
                r.capabilities.length,
            ),
        );
      if (parts.length === 1) {
        if (
          state.requests.some(
            (r) =>
              r.user.user_id === state.session.user_id &&
              r.block_id === data.block_id &&
              ["pending_hr", "pending_block"].includes(r.state),
          )
        )
          return conflict();
        if (
          state.blocks
            .find((b) => b.block_id === data.block_id)
            ?.members.some((m) => m.user.user_id === state.session.user_id)
        )
          return conflict();
        const created = options.now ?? mockNow;
        const req = {
          ...clone(state.requests[0]),
          request_id: id("request"),
          user: state.user,
          block_id: String(data.block_id),
          state: "pending_hr" as const,
          created_at: created,
          stage_entered_at: created,
          substitute_available_at: new Date(
            Date.parse(created) + 72 * 3600_000,
          ).toISOString(),
          approvals: [],
          revision: 1,
          capabilities: ["withdraw_request"],
        };
        state.requests.push(req);
        return [201, clone(req)];
      }
      const req = state.requests.find((r) => r.request_id === parts[1]);
      if (!req || mismatch(data, req)) return conflict();
      if (!["pending_hr", "pending_block"].includes(req.state))
        return conflict();
      const caps = requestCapabilities(req);
      if (
        parts[2] === "withdraw"
          ? !caps.includes("withdraw_request")
          : !caps.includes(
              req.state === "pending_hr"
                ? "hr_review_request"
                : "block_review_request",
            )
      )
        return denied();
      if (
        (parts[2] === "block-approve" && req.state !== "pending_block") ||
        (parts[2] === "hr-approve" && req.state !== "pending_hr")
      )
        return conflict();
      const states = {
        "hr-approve": "pending_block",
        "block-approve": "approved",
        reject: "rejected",
        withdraw: "withdrawn",
      } as const;
      if (parts[2] === "hr-approve" || parts[2] === "block-approve") {
        req.approvals.push({
          stage: req.state === "pending_hr" ? "hr" : "block",
          actor: clone(state.user),
          at: options.now ?? mockNow,
          substitute: (state.chair || role === "chair-deputy") && !!req.substitute_available_at && Date.parse(options.now ?? mockNow) >= Date.parse(req.substitute_available_at),
        });
      }
      req.state =
        parts[2] === "hr-approve" &&
        state.blocks.find((b) => b.block_id === req.block_id)?.is_hr
          ? "approved"
          : states[parts[2] as keyof typeof states];
      req.stage_entered_at = options.now ?? mockNow;
      req.substitute_available_at = ["pending_hr", "pending_block"].includes(
        req.state,
      )
        ? new Date(
            Date.parse(req.stage_entered_at) + 72 * 3600_000,
          ).toISOString()
        : null;
      req.capabilities = requestCapabilities(req);
      const block = state.blocks.find((b) => b.block_id === req.block_id);
      if (
        req.state === "approved" &&
        block &&
        !block.members.some((m) => m.user.user_id === req.user.user_id)
      )
        block.members.push({ user: req.user, block_category: "junior" });
      return changed(req);
    }
    if (parts[0] === "registrations") {
      if (!state.session.capabilities.includes("review_registrations"))
        return denied();
      if (method === "get") {
        const status = url.searchParams.get("status");
        return list(!status || status === queueApplication.status ? [clone(queueApplication)] : []);
      }
      if (mismatch(data, queueApplication)) return conflict();
      if (parts[2] === "reset-attempts") queueApplication.attempts_used = 0;
      else {
        queueApplication.status =
          parts[2] === "approve" ? "approved" : "rejected";
        queueApplication.rejection_reason = data.reason
          ? String(data.reason)
          : null;
      }
      return changed(queueApplication);
    }
    if (path === "/participants/categories" && method === "get") {
      const raw = url.searchParams.get("user_ids") ?? "";
      const pieces = raw.split(",").map(value => value.trim());
      const ids = [...new Set(pieces.map(Number))].sort((a, b) => a - b);
      if (raw.length > 4096 || pieces.some(value => !/^[1-9][0-9]{0,18}$/.test(value)) || ids.length > 200)
        return fail(422, "invalid_input", "Проверьте список участников");
      return [200, { items: ids.flatMap(id => { const item = categories.get(id);return item ? [clone(item)] : []; }) }];
    }
    if (parts[0] === "participants" && parts[2] === "participation" && method === "get") {
      const target = Number(parts[1]);
      if (state.session.account_state !== "active" || state.session.registration_status !== "approved") return denied();
      if (!state.people.some(person => person.user_id === target) || state.archived.some(person => person.user_id === target)) return fail(404, "not_found", "Участник не найден");
      return [200, participantTeams(target)];
    }
    if (parts[0] === "participants") {
      if (method !== "get" && !state.global) return denied();
      const category = categories.get(Number(parts[1]));
      if (!category) return fail(404, "not_found", "Участник не найден");
      if (method === "patch") {
        if (mismatch(data, category)) return conflict();
        category.category = data.category as typeof category.category;
        category.revision++;
      }
      return [200, clone(category)];
    }
    if (path === "/contacts/archive") {
      if (method === "get") return list(state.former.map(contact => ({ ...clone(contact), capabilities: state.global ? ["edit_former_contact"] : [] })));
      if (!state.global) return denied();
      if ("expected_revision" in data) return fail(422, "validation_error", "Unexpected creation revision", { errors: [{ loc: ["body", "expected_revision"], msg: "Extra inputs are not permitted" }] });
      const invalid = extraInputs(data, ["surname", "name", "patronymic", "phone", "email", "tg", "vk", "participation_periods"]);
      if (invalid) return invalid;
      const contact = {
        ...data,
        contact_id: id("former"),
        revision: 1,
        capabilities: ["edit_former_contact"],
      } as unknown as (typeof state.former)[number];
      state.former.push(contact);
      return [201, clone(contact)];
    }
    if (parts[0] === "contacts" && parts[1] === "archive") {
      if (!state.global) return denied();
      const contact = state.former.find((c) => c.contact_id === parts[2]);
      if (!contact) return fail(404, "not_found", "Контакт не найден");
      const invalid = extraInputs(data, ["surname", "name", "patronymic", "phone", "email", "tg", "vk", "participation_periods"]);
      if (invalid) return invalid;
      if (!Number.isInteger(data.expected_revision) || Number(data.expected_revision) < 1) return fail(422, "validation_error", "Expected revision is required", { errors: [{ loc: ["body", "expected_revision"], msg: "A positive integer is required" }] });
      if (mismatch(data, contact)) return conflict();
      const fields = Object.fromEntries(Object.entries(data).filter(([name]) => name !== "expected_revision"));
      Object.assign(contact, fields);
      return changed(contact);
    }
    if (path === "/avatars")
      return [
        200,
        {
          items: Object.entries({
            sun: "Солнце",
            moon: "Луна",
            leaf: "Лист",
            wave: "Волна",
            star: "Звезда",
            mountain: "Горы",
            default: "По умолчанию",
          }).map(([preset_id, title]) => ({
            preset_id,
            title,
            image_url: `/avatars/${preset_id}.svg`,
          })),
        },
      ];
    if (path === "/profile/me/avatar") {
      if (data.file_id && !files.get(String(data.file_id))?.complete)
        return conflict();
      state.profile.photo_url = data.preset_id
        ? `/avatars/${data.preset_id}.svg`
        : "/avatars/wave.svg";
      return [200, clone(state.profile)];
    }
    if (path === "/accounts/archive")
      return state.chair ? list(clone(state.archived)) : denied();
    if (parts[0] === "accounts") {
      if (!state.chair) return denied();
      const account = state.archived.find(
        (a) => a.user_id === Number(parts[1]),
      );
      if (parts[2] === "archive") {
        if (Number(parts[1]) === leadership.chair.user_id)
          return fail(
            409,
            "chair_transfer_required",
            "Сначала передайте пост председателя",
          );
        const person = state.people.find((p) => p.user_id === Number(parts[1]));
        if (!person) return fail(404, "not_found", "Аккаунт не найден");
        if (!account)
          state.archived.push({
            user_id: person.user_id!,
            display_name: person.display_name,
            archived_at: mockNow,
          });
      }
      if (
        parts[2] === "restore" &&
        account?.master_conflicts?.length &&
        !(data.master_conflicts as unknown[])?.length
      )
        return fail(
          409,
          "master_conflicts",
          "Resolve master conflicts",
          { master_conflicts: account.master_conflicts },
        );
      if (parts[2] === "restore")
        state.archived = state.archived.filter((a) => a !== account);
      return [
        200,
        { account_state: parts[2] === "restore" ? "active" : "archived" },
      ];
    }
    if (path === "/files/upload-intents") {
      if(data.owner_kind==="task"&&data.purpose==="comment") {const task=state.tasks.find(task=>task.task_id===data.owner_id);if(!task||!readsTask(task))return denied();}
      if (data.owner_kind === "block") {
        const block = state.blocks.find(block => block.block_id === data.owner_id);
        if (!block) return fail(404, "not_found", "Блок не найден");
        if (!block.capabilities.includes("edit_block")) return denied();
        if (data.purpose !== "avatar" || !["image/png", "image/jpeg", "image/webp"].includes(String(data.mime_type)) || Number(data.size_bytes) > 10 * 1024 * 1024) return fail(422, "invalid_input", "Некорректный аватар блока");
      }
      const file_id = id("file");
      files.set(file_id, {
        file_id,
        name: String(data.name),
        mime_type: String(data.mime_type),
        size_bytes: Number(data.size_bytes),
        complete: false,
        uploaded: false,
        owner_kind: typeof data.owner_kind === "string" ? data.owner_kind : undefined,
        owner_id: typeof data.owner_id === "string" ? data.owner_id : undefined,
        purpose: typeof data.purpose === "string" ? data.purpose : undefined,
        uploaded_by_user_id: state.session.user_id,
      });
      return [
        200,
        {
          file_id,
          upload_url: `https://uploads.mock.example/${file_id}`,
          method: "PUT",
          headers: { "Content-Type": data.mime_type },
          expires_at: "2026-10-18T13:00:00Z",
        },
      ];
    }
    if (parts[0] === "files") {
      const file = files.get(parts[1]);
      if (!file) return fail(404, "not_found", "Файл не найден");
      if(file.owner_kind==="task"&&file.purpose==="comment") {
        const task=state.tasks.find(task=>task.task_id===file.owner_id);
        const bound=state.comments.some(comment=>comment.task_id===file.owner_id&&comment.attachments.some(item=>item.file_id===file.file_id));
        if(!task||!readsTask(task)||(!bound&&file.uploaded_by_user_id!==state.session.user_id))return fail(404,"not_found","Файл не найден");
      }
      if (file.owner_kind === "block") {
        const block = state.blocks.find(block => block.block_id === file.owner_id);
        const own = file.uploaded_by_user_id === state.session.user_id && block?.capabilities.includes("edit_block");
        const bound = block?.avatar_url === `/api/files/${encodeURIComponent(file.file_id)}/content`;
        if (!block || (parts[2] === "complete" ? !own : !bound && !own)) return fail(404, "not_found", "Файл не найден");
      }
      if (parts[2] === "content") return file.complete ? [200, new Blob(["Mock attachment"], { type: file.mime_type })] : fail(404, "not_found", "Файл не готов");
      if (parts[2] === "complete") {
        if (!file.uploaded)
          return fail(409, "upload_missing", "Сначала загрузите файл");
        file.complete = true;
        return [
          200,
          {
            file_id: file.file_id,
            name: file.name,
            mime_type: file.mime_type,
            size_bytes: file.size_bytes,
          },
        ];
      }
      return [
        200,
        {
          download_url: `/api/files/${file.file_id}/content`,
          expires_at: "2026-10-18T13:00:00Z",
        },
      ];
    }
    if (path === "/participation") {
      const uid = state.session.user_id;
      return [200, {
        blocks: state.blocks.flatMap((block) => {
          const roles: ParticipationRole[] = [];
          if (block.master?.user.user_id === uid) roles.push("master");
          if (!block.is_hr && block.master?.deputy_user_ids.includes(uid)) roles.push("deputy_master");
          if (block.members.some((member) => member.user.user_id === uid)) roles.push("member");
          return roles.length ? [{ block_id: block.block_id, name: block.name, roles }] : [];
        }),
        events: state.events.flatMap((event) => {
          if (state.seasons.find((season) => season.season_id === event.season_id)?.state === "closed") return [];
          const roles: ParticipationRole[] = [];
          if (event.leaders.some((leader) => leader.user.user_id === uid)) roles.push("event_leader");
          if (event.leaders.some((leader) => leader.deputy_user_ids.includes(uid))) roles.push("event_deputy");
          for (const subevent of state.subevents.filter((subevent) => subevent.event_id === event.event_id)) {
            if (subevent.leaders.some((leader) => leader.user.user_id === uid)) roles.push("subevent_leader");
            if (subevent.leaders.some((leader) => leader.deputy_user_ids.includes(uid))) roles.push("subevent_deputy");
            if (subevent.organizer_user_ids.includes(uid)) roles.push("organizer");
          }
          return roles.length ? [{ event_id: event.event_id, title: event.title, season_id: event.season_id, roles: [...new Set(roles)] }] : [];
        }),
      }];
    }
    if (path === "/dashboard")
      return [
        200,
        {
          my_tasks: clone(
            state.tasks.filter((t) =>
              t.assignments.some(
                (a) => a.assignee.user_id === state.session.user_id,
              ),
            ),
          ),
          upcoming_meetings: clone(
            state.meetings.filter((m) =>
              m.owner_kind === "event"
                ? state.eventManager
                : readsSubevent(m.owner_id),
            ),
          ),
          my_blocks: clone(
            state.blocks.filter(
              (b) =>
                state.session.capabilities.includes("view_all_areas") ||
                b.members.some(
                  (m) => m.user.user_id === state.session.user_id,
                ) ||
                b.master?.user.user_id === state.session.user_id ||
                b.master?.deputy_user_ids.includes(state.session.user_id),
            ),
          ),
          my_events: clone(state.events.filter((e) => readsEvent(e.event_id))),
          actionable_requests: clone(
            state.requests.filter((r) =>
              requestCapabilities(r).some((c) => c.endsWith("review_request")),
            ),
          ),
          unresolved_assignments: [],
          unread_notification_count: state.notifications.filter(
            (n) => !n.read_at,
          ).length,
          pending_registration_count:
            state.session.capabilities.includes("review_registrations") && queueApplication.status === "pending" ? 1 : 0,
        },
      ];
    if (path === "/calendar" || path === "/workspace/home") {
      const active = new Set(["open", "in_progress", "completed"]);
      const mine = url.searchParams.get("mine") !== "false", watching = url.searchParams.get("watching") === "true";
      const personal = (task: Task) => (task.assignees ?? task.assignments.map(assignment => assignment.assignee)).some(user => user.user_id === state.session.user_id) || watching && !!task.watchers?.some(user => user.user_id === state.session.user_id);
      const publicState = (task: Task) => publicStatus(task.status ?? task.assignments[0]?.status);
      const rows: CalendarItem[] = [
        ...state.tasks.filter(task => readsTask(task) && !!task.deadline_at && (!mine || personal(task))).map(task => ({ id: `calendar-${task.task_id}`, season_id: task.season_id!, kind: "task_deadline" as const, title: task.title, starts_at: task.deadline_at!, ends_at: null, all_day: false, status: publicState(task), scope: task.scope, queue: task.queue, task_key: task.task_key, target: { kind: "task", id: task.task_id } })),
        ...state.meetings.filter(meeting => meeting.owner_kind === "event" ? state.eventManager : readsSubevent(meeting.owner_id)).map(meeting => ({ id: `calendar-${meeting.meeting_id}`, season_id: "season-1", kind: "meeting" as const, title: meeting.title, starts_at: meeting.starts_at, ends_at: null, target: { kind: meeting.owner_kind, id: meeting.owner_id } })),
        ...state.events.filter(event => event.starts_at && (!mine || readsEvent(event.event_id))).map(event => ({ id: `calendar-${event.event_id}`, season_id: event.season_id, kind: "event" as const, title: event.title, starts_at: event.starts_at!, ends_at: event.ends_at, all_day: event.all_day ?? false, event_id: event.event_id, target: { kind: "event", id: event.event_id } })),
        ...state.subevents.filter(sub => sub.starts_at && (!mine || readsSubevent(sub.subevent_id))).map(sub => ({ id: `calendar-${sub.subevent_id}`, season_id: state.events.find(event => event.event_id === sub.event_id)!.season_id, kind: "event" as const, title: sub.title, starts_at: sub.starts_at!, ends_at: sub.ends_at ?? null, all_day: sub.all_day ?? false, event_id: sub.event_id, target: { kind: "subevent", id: sub.subevent_id } })),
      ];
      const filtered = (from: string, to: string) => rows.filter(item => {
        const first = Date.parse(item.starts_at), last = Date.parse(item.ends_at ?? item.starts_at) + (item.all_day ? 86400000 : 0);
        if (!(first < Date.parse(to) && (last > first ? last > Date.parse(from) : first >= Date.parse(from)))) return false;
        if (url.searchParams.get("kind") && item.kind !== url.searchParams.get("kind")) return false;
        if (url.searchParams.get("season_id") && item.season_id !== url.searchParams.get("season_id")) return false;
        if (url.searchParams.get("block_id") && (item.scope?.kind !== "block" || item.scope.id !== url.searchParams.get("block_id"))) return false;
        if (url.searchParams.get("queue_id") && item.queue?.queue_id !== url.searchParams.get("queue_id")) return false;
        if (url.searchParams.get("event_id") && item.event_id !== url.searchParams.get("event_id")) return false;
        if (item.kind === "task_deadline" && (url.searchParams.get("status") ? item.status !== url.searchParams.get("status") : !active.has(item.status ?? "assigned"))) return false;
        return `${item.title} ${item.task_key ?? ""}`.toLocaleLowerCase().includes((url.searchParams.get("q") ?? "").toLocaleLowerCase());
      });
      if (path === "/calendar") return list(filtered(url.searchParams.get("from") ?? "1970-01-01", url.searchParams.get("to") ?? "2099-12-31"));
      const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10), first = `${today}T00:00:00+03:00`, last = new Date(Date.parse(first) + 86400000).toISOString();
      const tasks = state.tasks.filter(task => readsTask(task) && personal(task) && active.has(publicState(task)));
      const overdue = tasks.filter(task => task.deadline_at && Date.parse(task.deadline_at) < Date.now()).sort((a, b) => a.deadline_at!.localeCompare(b.deadline_at!));
      return [200, { today, agenda: filtered(first, last), tasks: clone(tasks.filter(task => task.deadline_at && Date.parse(task.deadline_at) >= Date.now()).sort((a, b) => a.deadline_at!.localeCompare(b.deadline_at!)).slice(0, 5)), overdue_tasks: clone(overdue.slice(0, 5)), overdue_count: overdue.length, undated_count: tasks.filter(task => !task.deadline_at).length,
        approvals: state.requests.some(request => requestCapabilities(request).some(cap => cap.endsWith("review_request"))) ? [{ kind: "block_requests", title: "Заявки в блоки", count: state.requests.length, to: "/blocks/requests" }] : [],
        merit_entries: state.blocks.filter(block => block.capabilities.includes("create_volunteer_merit")).map(block => ({ title: block.name, to: `/merits?source_kind=block_volunteer&scope_id=${block.block_id}` })) }];
    }
    if (path === "/notifications") return list(clone(state.notifications));
    if (parts[0] === "notifications") {
      state.notifications
        .filter((n) => parts[1] === "read-all" || n.id === parts[1])
        .forEach((n) => {
          n.read_at = mockNow;
        });
      return [200, {}];
    }
    if (path === "/assessments")
      return kkrGlobal()
        ? list(
            state.tasks
              .filter(
                (t) =>
                  !url.searchParams.get("season_id") ||
                  t.season_id === url.searchParams.get("season_id"),
              )
              .flatMap((t) =>
                t.assignments.map((a) => ({
                  contribution_id: `contribution-${a.assignment_id}`,
                  season_id: t.season_id,
                  participant_id: `participant-${a.assignee.user_id}`,
                  user: a.assignee,
                  source_kind:
                    t.scope.kind === "block" ? "block_task" : "subevent_task",
                  source_id: t.scope.id,
                  source_title: t.title,
                  score: a.status === "accepted" ? 12.5 : null,
                  calculation_version: "synthetic_fixture",
                  assignment_inputs: clone(
                    state.assessments.find(
                      (i) => i.assignment_id === a.assignment_id,
                    ),
                  ),
                  capabilities: [],
                })),
              ),
          )
        : denied();
    if (path === "/merits" || parts[0] === "merits") {
      if (!state.manager)
        return method === "get" && parts[1] ? fail(404, "not_found", "Запись недоступна") : denied();
      if (method === "get") {
        if (parts[1]) {
          const merit = state.merits.find((m) => m.merit_id === parts[1]);
          return merit
            ? [200, clone(merit)]
            : fail(404, "not_found", "Запись недоступна");
        }
        return list(clone(filter(state.merits, url)));
      }
      if (method === "patch") {
        const merit = state.merits.find((m) => m.merit_id === parts[1]);
        const extra = extraInputs(data, ["reason", "title", "description", "assigned_at", "deadline_at", "criteria", "recipients"]);
        if (extra) return extra;
        if (!merit || mismatch(data, merit)) return conflict();
        Object.assign(merit, data);
        return changed(merit);
      }
      if (data.reason !== undefined && (typeof data.reason !== "string" || !data.reason.trim())) return fail(422, "invalid_input", "Причина не может быть пустой");
      const merit: Merit = {
        ...(data as unknown as Merit),
        reason: data.reason === undefined ? "Создание записи учёта работы" : String(data.reason),
        merit_id: parts[1] ?? id("merit"),
        created_by: state.user,
        created_at: mockNow,
        revision: 1,
        capabilities: ["edit_assessment_inputs"],
      };
      state.merits.push(merit);
      return [201, clone(merit)];
    }
    if (parts[0] === "guides") return fail(404, "not_found", "Такого API больше нет");
    if (path === "/pgas") return [200, []];
    return fail(
      501,
      "mock_not_implemented",
      `Для ${method.toUpperCase()} ${path} ещё нет сценария мока`,
    );
  });
  return {
    state,
    legacyMaterialIds,
    adapter,
    restore: () => {
      adapter.restore();
      uploads.restore();
    },
  };
}
