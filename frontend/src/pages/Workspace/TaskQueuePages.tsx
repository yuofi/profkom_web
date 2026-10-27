import { useState, type MouseEvent, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useNavigate } from "react-router-dom";
import { UserChip } from "../../components/Workspace/UserChip";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { directoryApi } from "../../utils/api/directory.api";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { text, number } from "../../components/Workspace/formValues";
import { Empty, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import type { ScopeRef, TaskQueue, TaskQueueAccessRequest, TaskQueueCatalog, UserRef } from "../../utils/api/contract";
import { normalizeApiError } from "../../utils/api/request";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { can, useSession } from "../../utils/session";
import { getTaskQueueRoute, getTaskQueuesRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { TrackerListPage } from "./TrackerList";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TaskQueuePages.module.css";

export function TaskQueuesPage() {
  const catalog = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog });
  const [search, setSearch] = useState(""), [access, setAccess] = useState("");
  const [creating, setCreating] = useState(false);const navigate = useNavigate();const { session } = useSession();
  const open = (event: MouseEvent<HTMLTableRowElement>, queue: TaskQueue) => {
    if (event.target instanceof Element && event.target.closest("a,button,input,select,[data-row-action]")) return;
    if (window.getSelection()?.toString()) return;
    const path = getTaskQueueRoute(queue.queue_id);
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) window.open(path, "_blank", "noopener,noreferrer");else if (event.button === 0) navigate(path);
  };
  const keyboard = (event: KeyboardEvent<HTMLTableRowElement>, queue: TaskQueue) => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault();navigate(getTaskQueueRoute(queue.queue_id)); } };
  const items = (catalog.data?.items ?? []).filter(queue => (!access || queue.access === access) && `${queue.name} ${queue.key}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  return <section className={s.page}>
    <header className={s.header}><div><p className={s.eyebrow}>Профком ВМК · Трекер</p><h1>Очереди</h1><p>Общие и закрытые очереди задач.</p></div><div className={s.headerActions}><RouteLink to="/tasks">Все задачи</RouteLink>{session?.account_state === "active" && <button className={`${w.button} ${w.primary}`} onClick={() => setCreating(true)}>Создать очередь</button>}</div></header>
    <div className={s.filters}><label className={w.field}>Поиск очередей<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Название или ключ" /></label><label className={w.field}>Доступ<select value={access} onChange={e => setAccess(e.target.value)}><option value="">Все очереди</option><option value="granted">Доступные мне</option><option value="locked">Закрытые для меня</option></select></label></div>
    <QueryState loading={catalog.isLoading} error={catalog.error} keepDataOnError={!!catalog.data} retry={() => void catalog.refetch()}>
      <div className={s.tableWrap}><table className={s.table} aria-label="Список очередей"><thead><tr><th scope="col">Имя очереди</th><th scope="col">Ключ очереди</th><th scope="col">Владелец очереди</th></tr></thead><tbody>{items.map(queue => <tr key={queue.queue_id} tabIndex={0} onClick={event => open(event, queue)} onAuxClick={event => open(event, queue)} onKeyDown={event => keyboard(event, queue)} aria-label={`Открыть очередь ${queue.name}`}>
        <td><Link to={getTaskQueueRoute(queue.queue_id)} className={s.queueName}>{queue.name}</Link>{queue.access === "locked" && <span className={s.tableBadge}><LockIcon />Нет доступа</span>}{queue.access === "granted" && queue.is_private && <span className={s.tableBadge}>Закрытая очередь</span>}</td>
        <td className={s.key}>{queue.key}</td><td>{queue.access === "granted" && queue.owner ? <UserChip user={queue.owner} /> : <span className={w.muted}>{queue.access === "locked" ? "Скрыт" : "Не назначен"}</span>}</td>
      </tr>)}</tbody></table></div>
      {!items.length && <Empty>Очереди не найдены.</Empty>}
      {creating && catalog.data && <UnsavedChangesScope><TrackerTaskDialog title="Создать очередь" onClose={() => setCreating(false)}><QueueCreateForm catalog={catalog.data} /></TrackerTaskDialog></UnsavedChangesScope>}
    </QueryState>
  </section>;
}
export function TaskQueuePage() {
  const { id = "" } = useParams();
  const query = useQuery({ queryKey: ["tasks", "queues", id], queryFn: () => taskQueuesApi.get(id), enabled: !!id });
  const error = query.error ? normalizeApiError(query.error) : null;
  if (error?.status === 403 && error.code === "queue_access_required") return <QueueAccessScreen id={id} error={error} refresh={() => query.refetch()} />;
  return <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => void query.refetch()}>{query.data?.access === "granted" && <TrackerListPage key={id} queue={query.data} header={<QueueHeader queue={query.data} />} />}</QueryState>;
}
function LockIcon() { return <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4" /><path d="M12 14v3" /></svg>; }
function QueueHeader({ queue }: { queue: TaskQueue }) {
  return <><header className={s.header}><div><nav className={s.breadcrumbs} aria-label="Навигация очереди"><Link to={getTaskQueuesRoute()}>Очереди</Link><span aria-hidden="true">›</span><span>{queue.name}</span></nav><h1>{queue.name}</h1><p><span className={s.key}>{queue.key}</span> · {queue.is_private ? "Закрытая очередь" : queue.scope ? "Для участников команды" : "Для всех активных пользователей"}</p>{queue.owner && <Owner user={queue.owner} />}</div><RouteLink to="/tasks">Все задачи</RouteLink></header>{can(queue, "manage_queue") && <details className={s.manage}><summary>Настройки очереди и доступ</summary><div className={s.manageBody}><QueueEditor queue={queue} /><QueueRequests queue={queue} /></div></details>}</>;
}
function Owner({ user }: { user: UserRef }) {
  return <div className={s.owner}><small>Владелец очереди</small><UserChip user={user} /></div>;
}
function QueueCreateForm({ catalog }: { catalog: TaskQueueCatalog }) {
  const { perform } = useWorkspaceActions();const [created, setCreated] = useState<TaskQueue | null>(null);const [scopeChoice, setScopeChoice] = useState("none");
  const scopes = catalog.create_scopes ?? [];
  return <><p className={w.muted}>Вы станете владельцем очереди. Команду можно не выбирать.</p><ActionForm fields={[
    { name: "name", label: "Название очереди", required: true },
    { name: "key", label: "Ключ очереди", required: true, hint: "От1 до32 заглавных английских букв A–Z. Ключ после создания не меняется." },
    { name: "scope", label: "Команда очереди", type: "select", value: "none", onSelectionChange: values => setScopeChoice(values[0] ?? "none"), options: [{ value: "none", label: "Без команды" }, ...scopes.map(scope => ({ value: JSON.stringify([scope.kind, scope.id]), label: scope.title }))] },
    { name: "visibility", label: "Доступ к очереди", type: "select", required: true, value: "public", options: [{ value: "public", label: scopeChoice === "none" ? "Все активные пользователи" : "Участники команды" }, { value: "private", label: "По одобрению владельца" }] },
  ]} submitLabel="Создать очередь" resetOnSuccess allowExitSave={false} onSubmit={async values => {
    const key = text(values, "key");if (!/^[A-Z]{1,32}$/.test(key)) throw Error("Ключ должен содержать только заглавные английские буквы A–Z, не более32");
    const chosen = text(values, "scope");const scope = scopes.find(item => JSON.stringify([item.kind, item.id]) === chosen);
    if (chosen !== "none" && !scope) throw Error("Выберите доступную команду либо создайте очередь без команды");
    const result = await perform(() => taskQueuesApi.create({ name: text(values, "name").trim(), key, scope: scope ?? null, is_private: text(values, "visibility") === "private" }));setCreated(result);setScopeChoice("none");
  }} />{created && <p role="status">Очередь создана. <Link to={getTaskQueueRoute(created.queue_id)}>Открыть {created.key}</Link></p>}</>;
}
function QueueEditor({ queue }: { queue: TaskQueue }) {
  return queue.scope ? <ScopedQueueEditor queue={queue} scope={queue.scope} /> : <IndependentQueueEditor queue={queue} />;
}
function ScopedQueueEditor({ queue, scope }: { queue: TaskQueue; scope: ScopeRef }) {
  const members = useScopeMembers(scope);return <QueryState loading={members.loading} error={members.error}><QueueEditForm queue={queue} people={members.options} /></QueryState>;
}
function IndependentQueueEditor({ queue }: { queue: TaskQueue }) {
  const people = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts });
  return <QueryState loading={people.isLoading} error={people.error}><QueueEditForm queue={queue} people={people.data?.map(person => ({ value: String(person.user_id), label: [person.surname, person.name].join(" ") })) ?? []} /></QueryState>;
}
function QueueEditForm({ queue, people }: { queue: TaskQueue; people: { value: string; label: string }[] }) {
  const { perform, refresh } = useWorkspaceActions();
  const options = [...people];
  if (queue.owner?.user_id !== null && queue.owner?.user_id !== undefined && !options.some(p => p.value === String(queue.owner!.user_id))) options.unshift({ value: String(queue.owner.user_id), label: queue.owner.display_name });
  return <ActionForm title="Параметры очереди" fields={[
    { name: "name", label: "Название очереди", value: queue.name, required: true },
    { name: "owner", label: "Владелец очереди", type: "select", value: String(queue.owner?.user_id ?? ""), required: true, options },
    { name: "visibility", label: "Доступ к очереди", type: "select", required: true, value: queue.is_private ? "private" : "scope", options: [{ value: "scope", label: queue.scope ? "Участники команды" : "Все активные пользователи" }, { value: "private", label: "По одобрению владельца" }] },
  ]} revision={queue.revision!} record={`task-queue:${queue.queue_id}`} onConflict={refresh} submitLabel="Сохранить очередь" onSubmit={async (values, expectedRevision) => {
    const saved = await perform(() => taskQueuesApi.update(queue.queue_id, { expected_revision: expectedRevision!, name: text(values, "name").trim(), owner_user_id: number(values, "owner"), is_private: text(values, "visibility") === "private" }));
    return { revision: saved.revision! };
  }} />;
}
function QueueRequests({ queue }: { queue: TaskQueue }) {
  const query = useQuery({ queryKey: ["tasks", "queues", queue.queue_id, "access-requests"], queryFn: () => taskQueuesApi.requests(queue.queue_id), enabled: can(queue, "view_queue_requests") });
  if (!can(queue, "view_queue_requests")) return null;
  return <section className={s.requests}><h2>Запросы доступа</h2><QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data}>{query.data?.items.map(item => <QueueRequest key={item.request_id} queue={queue} item={item} />)}{!query.data?.items.length && <Empty>Запросов пока нет.</Empty>}</QueryState></section>;
}
function QueueRequest({ queue, item }: { queue: TaskQueue; item: TaskQueueAccessRequest }) {
  const { perform, refresh } = useWorkspaceActions();
  const states = { pending: "Ожидает решения", approved: "Доступ одобрен", rejected: "Отклонён", revoked: "Доступ отозван" };
  return <article className={s.request}><div><UserChip user={item.user} /><span>{item.status === "approved" && item.access_granted === false ? "Доступ отозван" : states[item.status]}</span><time dateTime={item.created_at}>{displayDate(item.created_at)}</time>{item.message && <p>{item.message}</p>}</div><div className={s.requestActions}>
    {can(item, "approve_queue_access") && <ActionForm fields={[]} revision={item.revision} onConflict={refresh} submitLabel="Одобрить доступ" allowExitSave={false} onSubmit={async (_, revision) => { const saved = await perform(() => taskQueuesApi.decide(queue.queue_id, item.request_id, "approve", revision!));return saved; }} />}
    {can(item, "reject_queue_access") && <ActionForm fields={[]} revision={item.revision} onConflict={refresh} submitLabel="Отклонить запрос" variant="quiet" allowExitSave={false} onSubmit={async (_, revision) => { const saved = await perform(() => taskQueuesApi.decide(queue.queue_id, item.request_id, "reject", revision!));return saved; }} />}
    {item.user.user_id !== null && can(item, "revoke_queue_access") && <ActionForm fields={[]} revision={item.revision} onConflict={refresh} submitLabel="Отозвать доступ" variant="danger" allowExitSave={false} onSubmit={async (_, revision) => { const saved = await perform(() => taskQueuesApi.revoke(queue.queue_id, item.user.user_id!, revision!));return saved; }} />}
  </div></article>;
}
function QueueAccessScreen({ id, error, refresh }: { id: string; error: ReturnType<typeof normalizeApiError>; refresh: () => unknown }) {
  const { perform } = useWorkspaceActions();
  const details = error.fields.queue;
  const queue = details && typeof details === "object" ? details as Record<string, unknown> : {};
  const pending = error.fields.access_request_status === "pending";
  const name = typeof queue.name === "string" ? queue.name : "Очередь недоступна";
  return <section className={s.page}><nav className={s.breadcrumbs} aria-label="Навигация очереди"><Link to={getTaskQueuesRoute()}>Очереди</Link><span aria-hidden="true">›</span><span>{name}</span></nav><div className={s.warning}><LockIcon /><h1>Нет доступа к очереди</h1><p>{name}{typeof queue.key === "string" ? ` · ${queue.key}` : ""}</p><p>Задачи этой очереди скрыты. Доступ подтверждает её владелец.</p>{pending ? <p role="status">Ваш запрос ожидает решения владельца.</p> : error.fields.can_request_access === true ? <ActionForm fields={[{ name: "message", label: "Сообщение владельцу", type: "textarea" }]} submitLabel="Запросить доступ" allowExitSave={false} successMessage="Запрос отправлен владельцу очереди" onSubmit={async values => { await perform(() => taskQueuesApi.requestAccess(id, text(values, "message")));await refresh(); }} /> : <p>Чтобы получить доступ, нужно также состоять в команде этой очереди.</p>}<button type="button" className={w.button} onClick={() => void refresh()}>Проверить доступ</button></div></section>;
}
