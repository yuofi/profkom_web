import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { AttachmentPicker } from "../../components/Workspace/Attachments";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { UserChip } from "../../components/Workspace/UserChip";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { authApi } from "../../utils/api/auth.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { eventsApi } from "../../utils/api/events.api";
import { richText, emptyCriteria, type FileRef, type ScopeRef, type Season, type TaskQueue, type UserRef } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { toUtc } from "../../utils/dates";
import { getTaskRoute, getTaskQueueRoute, getTaskQueuesRoute } from "../../utils/routes";
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
export function TaskCreateForm({ scope, queueId, parentTaskId }: { scope?: ScopeRef; queueId?: string; parentTaskId?: string }) {
  const catalog = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const queues = (catalog.data?.items ?? []).filter(queue => can(queue, "create_task") && (!scope || queue.scope?.kind === scope.kind && queue.scope.id === scope.id));
  const initialQueue = queues.find(queue => queue.queue_id === queueId) ?? queues[0];
  return <section className={s.page}>
    <QueryState loading={catalog.isLoading || seasons.isLoading} error={catalog.error ?? seasons.error} keepDataOnError={!!catalog.data && !!seasons.data} retry={() => { void catalog.refetch();void seasons.refetch(); }}>
      {initialQueue && seasons.data ? <TaskCreationEditor queues={queues} initialQueueId={initialQueue.queue_id} seasons={seasons.data.items} parentTaskId={parentTaskId} /> : <Empty>Нет доступной очереди для создания задачи. <Link to={getTaskQueuesRoute()}>Открыть очереди</Link></Empty>}
    </QueryState>
  </section>;
}
function TaskCreationEditor({ queues, initialQueueId, seasons, parentTaskId }: { queues: TaskQueue[]; initialQueueId: string; seasons: Season[]; parentTaskId?: string }) {
  const navigate = useNavigate(), { perform } = useWorkspaceActions(), { session } = useSession();
  const [queueId, setQueueId] = useState(initialQueueId), [title, setTitle] = useState(""), [body, setBody] = useState("");
  const [deadline, setDeadline] = useState(""), [season, setSeason] = useState(() => seasons.find(item => item.state === "open")?.season_id ?? seasons.find(item => item.state === "planned")?.season_id ?? "");
  const [assignees, setAssignees] = useState<string[]>([]), [watch, setWatch] = useState(false), [parentId, setParentId] = useState(parentTaskId ?? "");
  const [files, setFiles] = useState<FileRef[]>([]), [uploading, setUploading] = useState(false), [saving, setSaving] = useState(false), [attempted, setAttempted] = useState(false);
  const queue = queues.find(item => item.queue_id === queueId);
  const previousSeason = useRef("");
  const context = useQuery({ queryKey: ["tasks", "create-queue-season", queue?.scope?.kind, queue?.scope?.id], enabled: queue?.scope?.kind === "subevent", queryFn: async () => {
    const subevent = await eventsApi.subevent(queue!.scope!.id);return (await eventsApi.get(subevent.event_id)).season_id;
  } });
  const profile = useQuery({ queryKey: ["tasks", "create-self"], queryFn: async () => (await authApi.getMe()).data });
  const self: UserRef = { user_id: session?.user_id ?? null, display_name: profile.data ? [profile.data.surname, profile.data.name, profile.data.patronymic].filter(Boolean).join(" ") || "Вы" : "Вы", avatar_url: profile.data?.photo_url ?? null };
  const seasonId = queue?.scope?.kind === "subevent" ? context.data ?? "" : season;
  useEffect(() => { if (previousSeason.current && seasonId && previousSeason.current !== seasonId) setParentId("");if (seasonId) previousSeason.current = seasonId; }, [seasonId]);
  const selfAssigned = !!session && assignees.includes(String(session.user_id));
  const chooseAssignees = (value: string[]) => { setAssignees(value);if (session && value.includes(String(session.user_id))) setWatch(false); };
  const returnRoute = queue ? getTaskQueueRoute(queue.queue_id) : getTaskQueuesRoute();
  const external = { queueId, title, body, deadline, season, assignees, watch, parentId, files };
  const [initial] = useState(external);
  return <>
    <header className={s.header}><nav aria-label="Путь новой задачи"><Link to={returnRoute}>{queue?.name ?? "Очереди"}</Link><span>›</span><span>Новая задача</span></nav><div><h1>Новая задача</h1><Link className={w.button} to={returnRoute}>Отмена</Link></div></header>
    <ActionForm fields={[]} submitLabel="Создать задачу" externalState={external} savedExternalState={initial} externalBusy={uploading || saving || queue?.scope?.kind === "subevent" && context.isFetching}
      disabled={!queue || saving} allowExitSave={false}
      onSubmit={async () => {
        setAttempted(true);
        if (!queue) throw Error("Выберите доступную очередь");
        if (!title.trim()) throw Error("Введите название задачи");
        if (!deadline) throw Error("Укажите дедлайн");
        const deadlineAt = toUtc(deadline);
        const selectedSeason = seasons.find(item => item.season_id === seasonId);
        if (!selectedSeason || !["open", "planned"].includes(selectedSeason.state)) throw Error("Выберите открытый или запланированный сезон");
        if (!session) throw Error("Войдите в аккаунт");
        setSaving(true);
        try {
          const created = await perform(() => tasksApi.create({ queue_id: queue.queue_id, season_id: seasonId, title: title.trim(), description: richText(body), deadline_at: deadlineAt, criteria: emptyCriteria(), assignees: assignees.map(user => ({ user_id: Number(user), hours: 0 })), watcher_user_ids: watch ? [session.user_id] : [], parent_task_id: parentId || null, file_ids: files.map(file => file.file_id) }));
          navigate(getTaskRoute(created.task_id));
        } finally { setSaving(false); }
      }}>
      <div className={s.workspace}>
        <section className={s.main} aria-label="Описание новой задачи"><label className={`${w.field} ${s.title}`}>Название задачи<input name="title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Название задачи" required aria-invalid={attempted && !title.trim()} disabled={saving} /></label>
          <MarkdownEditor value={body} onChange={setBody} name="description" label="Описание задачи" rows={16} context="task" disabled={saving} draft={false} />
          <section className={s.files}><h2>Вложения</h2><fieldset className={s.pickerFields} disabled={saving}><AttachmentPicker owner_kind="task" purpose="attachment" files={files} onChange={setFiles} onBusyChange={setUploading} /></fieldset></section>
        </section>
        <aside className={s.parameters} aria-label="Параметры новой задачи"><h2>Параметры</h2>
          <label className={`${w.field} ${s.field}`}>Очередь<select name="queue" value={queueId} disabled={saving} onChange={event => { setQueueId(event.target.value);setAssignees([]); }}>{queues.map(item => <option key={item.queue_id} value={item.queue_id}>{item.key} · {item.name}</option>)}</select></label>
          {queue?.scope?.kind === "subevent" ? <div className={s.field}><span>Сезон</span><span>{context.isLoading ? "Загрузка…" : seasons.find(item => item.season_id === seasonId)?.title ?? "Не определён"}</span>{context.error && <QueryState loading={false} error={context.error}>{null}</QueryState>}</div> : <label className={`${w.field} ${s.field}`}>Сезон<select name="season" value={season} onChange={event => setSeason(event.target.value)} disabled={saving} required>{seasons.filter(item => ["open", "planned"].includes(item.state)).map(item => <option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>}
          <label className={`${w.field} ${s.field}`}>Дедлайн, МСК<input name="deadline" type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} required aria-invalid={attempted && !deadline} disabled={saving} /></label>
          <section className={s.people}><h3>Исполнители</h3>{queue?.scope && can(queue, "assign_task_others") ? <ScopedAssignees scope={queue.scope} value={assignees} onChange={chooseAssignees} disabled={saving} /> : <PeopleChoices people={[self]} value={assignees} onChange={chooseAssignees} name="users" disabled={saving} />}</section>
          <section className={s.people}><h3>Наблюдатели</h3><PeopleChoices people={[self]} value={watch && session ? [String(session.user_id)] : []} onChange={value => setWatch(value.length > 0)} name="watchers" disabled={saving || selfAssigned} />{selfAssigned && <small className={w.muted}>Исполнитель уже получает уведомления.</small>}</section>
          <TrackerParentSelector value={parentId} onChange={setParentId} seasonId={seasonId} disabled={!seasonId || saving} />
        </aside>
      </div>
    </ActionForm>
  </>;
}
function ScopedAssignees({ scope, value, onChange, disabled }: { scope: ScopeRef; value: string[]; onChange: (value: string[]) => void; disabled: boolean }) {
  const members = useScopeMembers(scope);
  return <QueryState loading={members.loading} error={members.error}><PeopleChoices people={members.options.map(person => ({ user_id: Number(person.value), display_name: person.label, avatar_url: null }))} value={value} onChange={onChange} name="users" disabled={disabled} /></QueryState>;
}
function PeopleChoices({ people, value, onChange, name, disabled }: { people: UserRef[]; value: string[]; onChange: (value: string[]) => void; name: string; disabled: boolean }) {
  const id = useId();
  return <div className={s.peopleChoices}>{people.map(person => <div key={person.user_id} className={s.personChoice}><input id={`${id}-${person.user_id}`} type="checkbox" name={name} value={String(person.user_id)} checked={value.includes(String(person.user_id))} disabled={disabled} aria-label={`${name === "users" ? "Назначить" : "Добавить наблюдателя"}: ${person.display_name}`} onChange={event => onChange(event.target.checked ? [...value, String(person.user_id)] : value.filter(item => item !== String(person.user_id)))} /><UserChip user={person} /></div>)}{!people.length && <span className={w.muted}>Нет доступных участников</span>}</div>;
}
