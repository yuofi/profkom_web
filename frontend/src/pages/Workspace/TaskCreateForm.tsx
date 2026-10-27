import { TaskPlanningFields } from "./TrackerTaskPlanning";
import { planningDraft, planningPayload, checklistPayload, type ChecklistDraft } from "./trackerStage2Drafts";
import { ChecklistDraftFields } from "./TrackerTaskChecklist";
import { TrackerHomeLink } from "../../components/Workspace/TrackerHomeLink";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { AttachmentPicker } from "../../components/Workspace/Attachments";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { authApi } from "../../utils/api/auth.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { membershipApi } from "../../utils/api/membership.api";
import { canRetainData } from "../../utils/api/request";
import { eventsApi } from "../../utils/api/events.api";
import { richText, emptyCriteria, type FileRef, type ScopeRef, type Season, type TaskQueue, type UserRef } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { toUtc } from "../../utils/dates";
import { getTaskRoute, getTaskQueueRoute, getTaskQueuesRoute, getBlockRoute, getSubeventRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { TrackerParentSelector } from "./TrackerParentSelector";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TaskCreateForm.module.css";

export function TrackerTaskCreatePage() {
  const [params] = useSearchParams();
  const kind = params.get("scope_kind"), id = params.get("scope_id");
  const scope = (kind === "block" || kind === "subevent") && id ? { kind, id } as ScopeRef : undefined;
  return <TaskCreateForm scope={scope} queueId={params.get("queue_id") ?? undefined} parentTaskId={params.get("parent_task_id") ?? undefined} />;
}
type ScopedCreation = { scope: ScopeRef; title: string; canAssignOthers: boolean; seasonId?: string };

export function TaskCreateForm({ scope, queueId, parentTaskId }: { scope?: ScopeRef; queueId?: string; parentTaskId?: string }) {
  const { session } = useSession();
  const catalog = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const queues = (catalog.data?.items ?? []).filter(queue => can(queue, "create_task") && (!scope || queue.scope?.kind === scope.kind && queue.scope.id === scope.id));
  const initialQueue = queues.find(queue => queue.queue_id === queueId) ?? queues[0];
  const fallbackEnabled = !!scope && !queueId && !initialQueue && !!catalog.data && (!catalog.error || canRetainData(catalog.error));
  const fallback = useQuery({ queryKey: ["tasks", "create-scope", scope?.kind, scope?.id], enabled: fallbackEnabled, queryFn: async (): Promise<ScopedCreation | null> => {
    if (!scope) return null;
    if (scope.kind === "block") {
      const block = await membershipApi.block(scope.id);
      return can(block, "create_task") ? { scope, title: block.name, canAssignOthers: can(block, "edit_block") || block.hr?.user_id === session?.user_id } : null;
    }
    const sub = await eventsApi.subevent(scope.id);
    if (!can(sub, "create_task")) return null;
    const event = await eventsApi.get(sub.event_id);
    return { scope, title: sub.title, canAssignOthers: can(sub, "manage_organizers"), seasonId: event.season_id };
  } });
  const errors = [catalog.error, seasons.error, fallbackEnabled ? fallback.error : null].filter(Boolean);
  const error = errors.find(item => !canRetainData(item)) ?? errors[0];
  return <section className={s.page}>
    <QueryState loading={catalog.isLoading || seasons.isLoading || fallbackEnabled && fallback.isLoading} error={error} keepDataOnError={!!catalog.data && !!seasons.data} retry={() => { void catalog.refetch();void seasons.refetch();if (fallbackEnabled) void fallback.refetch(); }}>
      {(initialQueue || fallbackEnabled && fallback.data) && seasons.data ? <TaskCreationEditor queues={queues} initialQueueId={initialQueue?.queue_id} seasons={seasons.data.items} parentTaskId={parentTaskId} fallback={initialQueue ? undefined : fallback.data ?? undefined} /> : <Empty>Нет доступной очереди для создания задачи. <Link to={getTaskQueuesRoute()}>Открыть очереди</Link></Empty>}
    </QueryState>
  </section>;
}
function TaskCreationEditor({ queues, initialQueueId, seasons, parentTaskId, fallback }: { queues: TaskQueue[]; initialQueueId?: string; seasons: Season[]; parentTaskId?: string; fallback?: ScopedCreation }) {
  const navigate = useNavigate(), { perform } = useWorkspaceActions(), { session } = useSession();
  const [queueId, setQueueId] = useState(initialQueueId ?? ""), [title, setTitle] = useState(""), [body, setBody] = useState("");
  const [deadline, setDeadline] = useState(""), [season, setSeason] = useState(() => seasons.find(item => item.state === "open")?.season_id ?? seasons.find(item => item.state === "planned")?.season_id ?? "");
  const [assignees, setAssignees] = useState<string[]>([]), [watch, setWatch] = useState(false), [parentId, setParentId] = useState(parentTaskId ?? "");
  const [planning,setPlanning] = useState(() => planningDraft()), [checklist,setChecklist] = useState<ChecklistDraft[]>([]);
  const [files, setFiles] = useState<FileRef[]>([]), [uploading, setUploading] = useState(false), [saving, setSaving] = useState(false), [attempted, setAttempted] = useState(false);
  const queue = queues.find(item => item.queue_id === (queueId || initialQueueId));
  const creationScope = queue?.scope ?? fallback?.scope;
  const previousSeason = useRef("");
  const context = useQuery({ queryKey: ["tasks", "create-queue-season", queue?.scope?.kind, queue?.scope?.id], enabled: creationScope?.kind === "subevent" && !fallback, queryFn: async () => {
    const subevent = await eventsApi.subevent(queue!.scope!.id);return (await eventsApi.get(subevent.event_id)).season_id;
  } });
  const profile = useQuery({ queryKey: ["tasks", "create-self"], queryFn: async () => (await authApi.getMe()).data });
  const self: UserRef = { user_id: session?.user_id ?? null, display_name: profile.data ? [profile.data.surname, profile.data.name, profile.data.patronymic].filter(Boolean).join(" ") || "Вы" : "Вы", avatar_url: profile.data?.photo_url ?? null };
  const seasonId = creationScope?.kind === "subevent" ? fallback?.seasonId ?? context.data ?? "" : season;
  useEffect(() => { if (previousSeason.current && seasonId && previousSeason.current !== seasonId) setParentId("");if (seasonId) previousSeason.current = seasonId; }, [seasonId]);
  const selfAssigned = !!session && assignees.includes(String(session.user_id));
  const chooseAssignees = (value: string[]) => { setAssignees(value);if (session && value.includes(String(session.user_id))) setWatch(false); };
  const returnRoute = queue ? getTaskQueueRoute(queue.queue_id) : fallback?.scope.kind === "block" ? getBlockRoute(fallback.scope.id) : fallback ? getSubeventRoute(fallback.scope.id) : getTaskQueuesRoute();
  const external = { queueId, title, body, deadline, season, assignees, watch, parentId, files, planning, checklist: checklistPayload(checklist) };
  const [initial] = useState(external);
  return <>
    <BrandedHeader className={s.header}><TrackerHomeLink className={s.brandLabel} /><nav aria-label="Путь новой задачи"><Link to={returnRoute}>{queue?.name ?? fallback?.title ?? "Очереди"}</Link><span>›</span><span>Новая задача</span></nav><div className={s.titleRow}><h1 className={w.title}>Новая задача</h1><Link className={w.button} to={returnRoute}>Отмена</Link></div></BrandedHeader>
    <ActionForm fields={[]} submitLabel="Создать задачу" externalState={external} savedExternalState={initial} externalBusy={uploading || saving || creationScope?.kind === "subevent" && !fallback && context.isFetching}
      disabled={!queue && !fallback || saving} allowExitSave={false}
      onSubmit={async () => {
        setAttempted(true);
        if (!queue && !fallback) throw Error("Выберите доступную очередь");
        if (!title.trim()) throw Error("Введите название задачи");
        if (!deadline) throw Error("Укажите дедлайн");
        const deadlineAt = toUtc(deadline), planned = planningPayload(planning);
        if (planned.starts_at && Date.parse(planned.starts_at) > Date.parse(deadlineAt)) throw Error("Плановое начало не может быть позже дедлайна");
        if (checklist.some(item => !item.text.trim())) throw Error("Заполните каждый пункт чеклиста");
        const selectedSeason = seasons.find(item => item.season_id === seasonId);
        if (!selectedSeason || !["open", "planned"].includes(selectedSeason.state)) throw Error("Выберите открытый или запланированный сезон");
        if (creationScope?.kind === "block" && selectedSeason.state !== "open") throw Error("Для задачи блока нужен открытый сезон");
        if (!session) throw Error("Войдите в аккаунт");
        setSaving(true);
        try {
          const created = await perform(() => tasksApi.create({ ...(queue ? { queue_id: queue.queue_id } : { scope: fallback!.scope }), season_id: seasonId, title: title.trim(), description: richText(body), deadline_at: deadlineAt, ...planned, checklist: checklistPayload(checklist), criteria: emptyCriteria(), assignees: assignees.map(user => ({ user_id: Number(user), hours: 0 })), watcher_user_ids: watch ? [session.user_id] : [], parent_task_id: parentId || null, file_ids: files.map(file => file.file_id) }));
          navigate(getTaskRoute(created.task_id));
        } finally { setSaving(false); }
      }}>
      <div className={s.workspace}>
        <section className={s.main} aria-label="Описание новой задачи"><label className={`${w.field} ${s.title}`}>Название задачи<input name="title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Название задачи" required aria-invalid={attempted && !title.trim()} disabled={saving} /></label>
          <MarkdownEditor value={body} onChange={setBody} name="description" label="Описание задачи" rows={16} context="task" disabled={saving} draft={false} />
          <section className={s.files}><h2>Чеклист</h2><ChecklistDraftFields items={checklist} onChange={setChecklist} disabled={saving} /></section>
          <section className={s.files}><h2>Вложения</h2><fieldset className={s.pickerFields} disabled={saving}><AttachmentPicker owner_kind="task" purpose="attachment" files={files} onChange={setFiles} onBusyChange={setUploading} /></fieldset></section>
        </section>
        <aside className={s.parameters} aria-label="Параметры новой задачи"><h2>Параметры</h2>
          <TaskPlanningFields value={planning} onChange={setPlanning} disabled={saving} deadline={deadline ? toUtc(deadline) : undefined} />
          {queue ? <label className={`${w.field} ${s.field}`}>Очередь<select name="queue" value={queue?.queue_id ?? queueId} disabled={saving} onChange={event => { setQueueId(event.target.value);setAssignees([]); }}>{queues.map(item => <option key={item.queue_id} value={item.queue_id}>{item.key} · {item.name}</option>)}</select></label> : <div className={s.field}><span>Очередь</span><strong>Очередь команды по умолчанию</strong><small className={w.muted}>Задача появится в очереди этой команды.</small></div>}
          {creationScope?.kind === "subevent" ? <div className={s.field}><span>Сезон</span><span>{!fallback && context.isLoading ? "Загрузка…" : seasons.find(item => item.season_id === seasonId)?.title ?? "Не определён"}</span>{context.error && <QueryState loading={false} error={context.error}>{null}</QueryState>}</div> : <label className={`${w.field} ${s.field}`}>Сезон<select name="season" value={season} onChange={event => setSeason(event.target.value)} disabled={saving} required>{seasons.filter(item => creationScope?.kind === "block" ? item.state === "open" : ["open", "planned"].includes(item.state)).map(item => <option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>}
          <label className={`${w.field} ${s.field}`}>Дедлайн, МСК<input name="deadline" type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} required aria-invalid={attempted && !deadline} disabled={saving} /></label>
          <section className={s.people}><h3>Исполнители</h3>{queue?.scope && can(queue, "assign_task_others") ? <ScopedAssignees queue={queue} scope={queue.scope} value={assignees} onChange={chooseAssignees} disabled={saving} /> : fallback?.canAssignOthers ? <LegacyScopedAssignees scope={fallback.scope} value={assignees} onChange={chooseAssignees} disabled={saving} /> : <PeopleChoices people={[self]} value={assignees} onChange={chooseAssignees} name="users" disabled={saving} />}</section>
          <section className={s.people}><h3>Наблюдатели</h3><PeopleChoices people={[self]} value={watch && session ? [String(session.user_id)] : []} onChange={value => setWatch(value.length > 0)} name="watchers" disabled={saving || selfAssigned} />{selfAssigned && <small className={w.muted}>Исполнитель уже получает уведомления.</small>}</section>
          <TrackerParentSelector value={parentId} onChange={setParentId} seasonId={seasonId} disabled={!seasonId || saving} />
        </aside>
      </div>
    </ActionForm>
  </>;
}
function ScopedAssignees({ queue, scope, value, onChange, disabled }: { queue: TaskQueue; scope: ScopeRef; value: string[]; onChange: (value: string[]) => void; disabled: boolean }) {
  if (queue.assignable_users) return <PeopleChoices people={queue.assignable_users} value={value} onChange={onChange} name="users" disabled={disabled} />;
  return <LegacyScopedAssignees scope={scope} value={value} onChange={onChange} disabled={disabled} />;
}
function LegacyScopedAssignees({ scope, value, onChange, disabled }: { scope: ScopeRef; value: string[]; onChange: (value: string[]) => void; disabled: boolean }) {
  const members = useScopeMembers(scope);
  return <QueryState loading={members.loading} error={members.error}><PeopleChoices people={members.options.map(person => person.user ?? ({ user_id: Number(person.value), display_name: person.label, avatar_url: null }))} value={value} onChange={onChange} name="users" disabled={disabled} /></QueryState>;
}
function PeopleChoices({ people, value, onChange, name, disabled }: { people: UserRef[]; value: string[]; onChange: (value: string[]) => void; name: string; disabled: boolean }) {
  return <div className={s.peopleChoices}><EntityPicker multiple name={name} label={name === "users" ? "Выбрать исполнителей" : "Выбрать наблюдателей"} value={value} onChange={onChange} options={people.map(person => ({ value: String(person.user_id), label: person.display_name, user: person }))} disabled={disabled} placeholder="Введите имя" emptyMessage="Нет доступных участников" /></div>;
}
