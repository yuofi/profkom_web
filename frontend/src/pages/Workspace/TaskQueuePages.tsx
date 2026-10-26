import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Avatar } from "../../components/Avatar/Avatar";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { text, number } from "../../components/Workspace/formValues";
import { Empty, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import type { ScopeRef, TaskQueue, TaskQueueAccessRequest, TaskQueueCatalog, UserRef } from "../../utils/api/contract";
import { normalizeApiError } from "../../utils/api/request";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { can, useSession } from "../../utils/session";
import { getContactRoute, getTaskQueueRoute, getTaskQueuesRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { TrackerListPage } from "./TrackerList";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TaskQueuePages.module.css";

export function TaskQueuesPage() {
  const catalog = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog });
  const [search, setSearch] = useState(""), [access, setAccess] = useState("");
  const items = (catalog.data?.items ?? []).filter(queue => (!access || queue.access === access) && `${queue.name} ${queue.key}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  return <section className={s.page}>
    <header className={s.header}><div><p className={s.eyebrow}>Профком ВМК · Трекер</p><h1>Очереди</h1><p>Отдельные направления работы внутри команд.</p></div><RouteLink to="/tasks">Все задачи</RouteLink></header>
    <div className={s.filters}><label className={w.field}>Поиск очередей<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Название или ключ" /></label><label className={w.field}>Доступ<select value={access} onChange={e => setAccess(e.target.value)}><option value="">Все очереди</option><option value="granted">Доступные мне</option><option value="locked">Закрытые для меня</option></select></label></div>
    <QueryState loading={catalog.isLoading} error={catalog.error} keepDataOnError={!!catalog.data} retry={() => void catalog.refetch()}>
      <div className={s.grid}>{items.map(queue => <Link className={s.card} key={queue.queue_id} to={getTaskQueueRoute(queue.queue_id)}><div className={s.cardTop}><span className={s.key}>{queue.key}</span><span className={s.badge}>{queue.access === "locked" ? <><LockIcon />Нет доступа</> : queue.is_private ? "Закрытая очередь" : "Для команды"}</span></div><h2>{queue.name}</h2>{queue.access === "granted" && queue.owner && <Owner user={queue.owner} linked={false} />}{queue.access === "locked" && <p>Открыть сведения о доступе</p>}</Link>)}</div>
      {!items.length && <Empty>Очереди не найдены.</Empty>}
      {catalog.data && <QueueCreation catalog={catalog.data} />}
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
  return <><header className={s.header}><div><nav className={s.breadcrumbs} aria-label="Навигация очереди"><Link to={getTaskQueuesRoute()}>Очереди</Link><span aria-hidden="true">›</span><span>{queue.name}</span></nav><h1>{queue.name}</h1><p><span className={s.key}>{queue.key}</span> · {queue.is_private ? "Закрытая очередь" : "Для участников команды"}</p>{queue.owner && <Owner user={queue.owner} />}</div><RouteLink to="/tasks">Все задачи</RouteLink></header>{can(queue, "manage_queue") && <details className={s.manage}><summary>Настройки очереди и доступ</summary><div className={s.manageBody}><QueueEditor queue={queue} /><QueueRequests queue={queue} /></div></details>}</>;
}
function Owner({ user, linked = true }: { user: UserRef; linked?: boolean }) {
  const content = <><Avatar src={user.avatar_url ?? undefined} size={36} mode="disable" /><span><small>Владелец очереди</small><strong>{user.display_name}</strong></span></>;
  return linked && user.user_id !== null ? <Link className={s.owner} to={getContactRoute(user.user_id)}>{content}</Link> : <span className={s.owner}>{content}</span>;
}
function QueueCreation({ catalog }: { catalog: TaskQueueCatalog }) {
  const unique = new Map<string, ScopeRef & { title: string }>();
  for (const scope of catalog.create_scopes ?? []) unique.set(JSON.stringify([scope.kind, scope.id]), scope);
  for (const queue of catalog.items) if (queue.scope && can(queue, "create_task")) {
    const id = JSON.stringify([queue.scope.kind, queue.scope.id]);
    if (!unique.has(id)) unique.set(id, { ...queue.scope, title: queue.name });
  }
  const scopes = [...unique.entries()];
  const [selected, setSelected] = useState("");
  const value = scopes.some(([key]) => key === selected) ? selected : scopes[0]?.[0] ?? "";
  const scope = unique.get(value);
  if (!scopes.length) return null;
  return <details className={s.manage}><summary>Создать очередь</summary><div className={s.manageBody}><label className={w.field}>Команда очереди<select value={value} onChange={e => setSelected(e.target.value)}>{scopes.map(([key, item]) => <option value={key} key={key}>{item.title}</option>)}</select></label>{scope && <QueueCreateForm key={value} scope={scope} />}</div></details>;
}
function QueueCreateForm({ scope }: { scope: ScopeRef }) {
  const members = useScopeMembers(scope), { session } = useSession(), { perform } = useWorkspaceActions();
  const [created, setCreated] = useState<TaskQueue | null>(null);
  return <QueryState loading={members.loading} error={members.error}><ActionForm fields={[
    { name: "name", label: "Название очереди", required: true },
    { name: "key", label: "Ключ очереди", required: true, hint: "Заглавные английские буквы A–Z, без пробелов и других символов. После создания ключ не меняется." },
    { name: "owner", label: "Владелец очереди", type: "select", required: true, value: members.options.some(p => p.value === String(session?.user_id)) ? String(session?.user_id) : members.options[0]?.value, options: members.options },
    { name: "visibility", label: "Доступ к очереди", type: "select", required: true, value: "scope", options: [{ value: "scope", label: "Участники команды" }, { value: "private", label: "По одобрению владельца" }] },
  ]} submitLabel="Создать очередь" resetOnSuccess allowExitSave={false} onSubmit={async values => {
    const key = text(values, "key");
    if (!/^[A-Z]+$/.test(key)) throw Error("Ключ должен содержать только заглавные английские буквы A–Z");
    const result = await perform(() => taskQueuesApi.create({ name: text(values, "name").trim(), key, scope, owner_user_id: number(values, "owner"), is_private: text(values, "visibility") === "private" }));
    setCreated(result);
  }} />{created && <p role="status">Очередь создана. <Link to={getTaskQueueRoute(created.queue_id)}>Открыть {created.key}</Link></p>}</QueryState>;
}
function QueueEditor({ queue }: { queue: TaskQueue }) {
  const members = useScopeMembers(queue.scope!), { perform, refresh } = useWorkspaceActions();
  const options = [...members.options];
  if (queue.owner?.user_id !== null && queue.owner?.user_id !== undefined && !options.some(p => p.value === String(queue.owner!.user_id))) options.unshift({ value: String(queue.owner.user_id), label: queue.owner.display_name });
  return <QueryState loading={members.loading} error={members.error}><ActionForm title="Параметры очереди" fields={[
    { name: "name", label: "Название очереди", value: queue.name, required: true },
    { name: "owner", label: "Владелец очереди", type: "select", value: String(queue.owner?.user_id ?? ""), required: true, options },
    { name: "visibility", label: "Доступ к очереди", type: "select", required: true, value: queue.is_private ? "private" : "scope", options: [{ value: "scope", label: "Участники команды" }, { value: "private", label: "По одобрению владельца" }] },
  ]} revision={queue.revision!} record={`task-queue:${queue.queue_id}`} onConflict={refresh} submitLabel="Сохранить очередь" onSubmit={async (values, expectedRevision) => {
    const saved = await perform(() => taskQueuesApi.update(queue.queue_id, { expected_revision: expectedRevision!, name: text(values, "name").trim(), owner_user_id: number(values, "owner"), is_private: text(values, "visibility") === "private" }));
    return { revision: saved.revision! };
  }} /></QueryState>;
}
function QueueRequests({ queue }: { queue: TaskQueue }) {
  const query = useQuery({ queryKey: ["tasks", "queues", queue.queue_id, "access-requests"], queryFn: () => taskQueuesApi.requests(queue.queue_id), enabled: can(queue, "view_queue_requests") });
  if (!can(queue, "view_queue_requests")) return null;
  return <section className={s.requests}><h2>Запросы доступа</h2><QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data}>{query.data?.items.map(item => <QueueRequest key={item.request_id} queue={queue} item={item} />)}{!query.data?.items.length && <Empty>Запросов пока нет.</Empty>}</QueryState></section>;
}
function QueueRequest({ queue, item }: { queue: TaskQueue; item: TaskQueueAccessRequest }) {
  const { perform, refresh } = useWorkspaceActions();
  const states = { pending: "Ожидает решения", approved: "Доступ одобрен", rejected: "Отклонён", revoked: "Доступ отозван" };
  return <article className={s.request}><div><strong>{item.user.display_name}</strong><span>{item.status === "approved" && item.access_granted === false ? "Доступ отозван" : states[item.status]}</span><time dateTime={item.created_at}>{displayDate(item.created_at)}</time>{item.message && <p>{item.message}</p>}</div><div className={s.requestActions}>
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
