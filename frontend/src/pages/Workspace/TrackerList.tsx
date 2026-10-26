import { useEffect, useRef, type MouseEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Empty, Glyph, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { directoryApi } from "../../utils/api/directory.api";
import type { ScopeRef, Task, TaskQueue } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { getContactRoute, getTaskRoute, getTaskQueuesRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { TaskCreateForm } from "./TaskCreateForm";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { statusNames } from "./trackerStatus";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerList.module.css";

const rowAction = "a,button,input,select,textarea,label,summary,dialog,[role='dialog'],[data-row-action]";
function interactive(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(rowAction);
}
const optionLabels: Record<string, string> = {
  mine: "Назначение", status: "Статус", season_id: "Сезон", scope: "Команда",
  assignee_user_id: "Исполнитель", unfinished: "Незавершённые", overdue: "Просроченные", q: "Поиск", queue_id: "Очередь",
};

export function TrackerListPage({ queue, header }: { queue?: TaskQueue; header?: ReactNode }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const previous = useRef(new Map<string, string>());
  const filterMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !filterMenu.current?.contains(event.target)) filterMenu.current?.removeAttribute("open"); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && filterMenu.current?.open) { filterMenu.current.open = false; filterMenu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  const cursor = params.get("cursor") ?? "";
  const pageNumber = Math.max(1, Number(params.get("page")) || 1);
  const filters = {
    queue_id: queue?.queue_id ?? params.get("queue_id") ?? "",
    mine: params.get("mine") ?? "false",
    status: params.get("status") ?? "",
    season_id: params.get("season_id") ?? "",
    scope_kind: params.get("scope_kind") ?? "",
    scope_id: params.get("scope_id") ?? "",
    assignee_user_id: params.get("assignee_user_id") ?? "",
    q: params.get("q") ?? "",
    unfinished: params.get("unfinished") ?? "false",
    overdue: params.get("overdue") ?? "false",
    sort: params.get("sort") ?? "deadline",
    order: params.get("order") ?? "asc",
    limit: 20,
    ...(cursor ? { cursor } : {}),
  };
  const requestFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ""));
  const query = useQuery({ queryKey: ["tasks", "page", requestFilters], queryFn: () => tasksApi.listPage(requestFilters) });
  const queues = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog, enabled: !queue });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const people = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts });
  const tasks = query.data?.items ?? [];
  const scopes = query.data?.scopes ?? [];
  const selectedScope = scopes.find((scope) => scope.kind === filters.scope_kind && scope.id === filters.scope_id);
  const scope: ScopeRef | null = queue?.scope ?? (["block", "subevent"].includes(filters.scope_kind) && filters.scope_id
    ? { kind: filters.scope_kind as ScopeRef["kind"], id: filters.scope_id } : null);
  const scopeValue = scope ? JSON.stringify([scope.kind, scope.id]) : "";
  const update = (key: string, value: string, replace = false) => {
    const next = new URLSearchParams(params);
    if (key === "scope") {
      next.delete("scope_kind"); next.delete("scope_id");
      if (value) {
        const [kind, id] = JSON.parse(value) as [string, string];
        next.set("scope_kind", kind); next.set("scope_id", id);
      }
    } else if (value) next.set(key, value);
    else next.delete(key);
    next.delete("cursor"); next.delete("page");
    previous.current.clear();
    setParams(next, { replace });
  };
  const turnPage = (nextCursor: string) => {
    const next = new URLSearchParams(params);
    if (nextCursor) {
      previous.current.set(nextCursor, cursor); next.set("cursor", nextCursor); next.set("page", String(pageNumber + 1));
    } else { next.delete("cursor"); next.delete("page"); }
    setParams(next);
  };
  const goBack = () => {
    const next = new URLSearchParams(params), before = previous.current.get(cursor) ?? "";
    if (before) { next.set("cursor", before); next.set("page", String(Math.max(1, pageNumber - 1))); }
    else { next.delete("cursor"); next.delete("page"); }
    setParams(next);
  };
  const changeSort = (sort: string) => {
    const next = new URLSearchParams(params);
    next.set("sort", sort); next.set("order", filters.sort === sort && filters.order === "asc" ? "desc" : "asc");
    next.delete("cursor"); next.delete("page"); previous.current.clear(); setParams(next);
  };
  const open = (event: MouseEvent<HTMLTableRowElement>, task: Task) => {
    if (interactive(event.target) || window.getSelection()?.toString()) return;
    const route = getTaskRoute(task.task_id);
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) window.open(route, "_blank", "noopener,noreferrer");
    else if (event.button === 0) navigate(route);
  };
  const openKeyboard = (event: KeyboardEvent<HTMLTableRowElement>, task: Task) => {
    if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); navigate(getTaskRoute(task.task_id)); }
  };
  const active: { key: string; label: string }[] = [];
  if (!queue && filters.queue_id) active.push({ key: "queue_id", label: `Очередь: ${queues.data?.items.find(item => item.queue_id === filters.queue_id)?.name ?? "выбрана"}` });
  if (params.has("mine")) active.push({ key: "mine", label: filters.mine === "true" ? "Мои задачи" : "Все доступные" });
  if (filters.status) active.push({ key: "status", label: `Статус: ${statusNames[filters.status as keyof typeof statusNames] ?? filters.status}` });
  if (filters.q) active.push({ key: "q", label: `Поиск: ${filters.q}` });
  if (filters.season_id) active.push({ key: "season_id", label: `Сезон: ${seasons.data?.items.find((item) => item.season_id === filters.season_id)?.title ?? "выбран"}` });
  if (scope && !queue) active.push({ key: "scope", label: `Команда: ${selectedScope?.title ?? (scope.kind === "block" ? "блок" : "подмероприятие")}` });
  if (filters.assignee_user_id) {
    const person = people.data?.find((item) => String(item.user_id) === filters.assignee_user_id);
    active.push({ key: "assignee_user_id", label: `Исполнитель: ${person ? `${person.surname} ${person.name}` : "выбран"}` });
  }
  if (filters.unfinished === "true") active.push({ key: "unfinished", label: "Незавершённые" });
  if (filters.overdue === "true") active.push({ key: "overdue", label: "Просроченные" });
  return <section className={s.page}>
    {header ?? <header className={s.header}>
      <div><p className={s.eyebrow}>Профком ВМК · Трекер</p><h1>Задачи</h1><p className={s.subtitle}>Одна совместная работа — одна задача и общий статус.</p></div>
      <div className={s.headerLinks}><RouteLink to={getTaskQueuesRoute()}>Очереди</RouteLink>{can(session, "view_unresolved_assignments") && <RouteLink to="/tasks/unresolved">Оставшаяся работа</RouteLink>}</div>
    </header>}
    <div className={s.topbar}>
      <label className={s.search}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Поиск задач" placeholder="Название или ключ задачи" value={filters.q} onChange={(event) => update("q", event.target.value, true)} /></label>
      <div className={s.views} aria-label="Представление задач">
        <span aria-current="page">Список</span>
        <button type="button" disabled title="Календарное представление — следующий этап">Календарь <small>позже</small></button>
        <button type="button" disabled title="Диаграмма Гантта — следующий этап">Гантт <small>позже</small></button>
      </div>
      <details ref={filterMenu} className={s.filters}>
        <summary><Glyph name="filter_list" />Добавить фильтр</summary>
        <div className={s.filterPanel}>
          <label className={w.field}>Назначение<select aria-label="Назначение" value={params.get("mine") ?? ""} onChange={(event) => update("mine", event.target.value)}><option value="">Без фильтра</option><option value="true">Мои задачи</option><option value="false">Все доступные</option></select></label>
          <label className={w.field}>Статус<select aria-label="Статус" value={filters.status} onChange={(event) => update("status", event.target.value)}><option value="">Любой статус</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={w.field}>Сезон<select aria-label="Сезон" value={filters.season_id} onChange={(event) => update("season_id", event.target.value)}><option value="">Все сезоны</option>{seasons.data?.items.map((item) => <option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>
          {!queue && <label className={w.field}>Очередь<select aria-label="Очередь" value={filters.queue_id} onChange={event => update("queue_id", event.target.value)}><option value="">Все доступные очереди</option>{queues.data?.items.filter(item => item.access === "granted").map(item => <option key={item.queue_id} value={item.queue_id}>{item.key} · {item.name}</option>)}</select></label>}
          {!queue && <label className={w.field}>Команда<select aria-label="Команда" value={scopeValue} onChange={(event) => update("scope", event.target.value)}><option value="">Все команды</option>{scope && !selectedScope && <option value={scopeValue}>Текущая команда</option>}{scopes.map((item) => <option key={`${item.kind}/${item.id}`} value={JSON.stringify([item.kind, item.id])}>{item.title}</option>)}</select></label>}
          <label className={w.field}>Исполнитель<select aria-label="Исполнитель" value={filters.assignee_user_id} onChange={(event) => update("assignee_user_id", event.target.value)}><option value="">Все исполнители</option>{people.data?.filter((item) => item.in_profcom).map((item) => <option key={item.user_id} value={item.user_id}>{item.surname} {item.name}</option>)}</select></label>
          <label className={w.field}>Сортировать<select aria-label="Сортировать" value={filters.sort} onChange={(event) => update("sort", event.target.value)}><option value="deadline">По дедлайну</option><option value="updated">По обновлению</option><option value="created">По созданию</option></select></label>
          <label className={w.field}>Порядок<select aria-label="Порядок" value={filters.order} onChange={(event) => update("order", event.target.value)}><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></label>
          <label className={w.check}><input type="checkbox" checked={filters.unfinished === "true"} onChange={(event) => update("unfinished", event.target.checked ? "true" : "")} />Незавершённые</label>
          <label className={w.check}><input type="checkbox" checked={filters.overdue === "true"} onChange={(event) => update("overdue", event.target.checked ? "true" : "")} />Просроченные</label>
        </div>
      </details>
    </div>
    <div className={s.activeFilters} aria-label="Активные фильтры">
      {active.map((filter) => <span className={s.filterChip} key={filter.key}>{filter.label}<button type="button" aria-label={`Убрать фильтр: ${optionLabels[filter.key]}`} onClick={() => update(filter.key, "")}><Glyph name="close" /></button></span>)}
      {!active.length && <span className={s.filterHint}>Показаны все доступные вам задачи</span>}
      {active.length > 1 && <button type="button" className={s.clear} onClick={() => { previous.current.clear(); setParams({}); }}>Сбросить все</button>}
    </div>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => void query.refetch()}>
      {tasks.length ? <div className={s.tableWrap}>
        <table className={s.table} aria-label="Список задач">
          <thead><tr><th scope="col">Ключ</th><th scope="col">Задача</th><th scope="col">Исполнители</th><th scope="col">Статус</th><th scope="col" aria-sort={filters.sort === "deadline" ? filters.order === "desc" ? "descending" : "ascending" : "none"}><button onClick={() => changeSort("deadline")}>Дедлайн {filters.sort === "deadline" && (filters.order === "asc" ? "↑" : "↓")}</button></th><th scope="col">Команда</th><th scope="col" aria-sort={filters.sort === "updated" ? filters.order === "desc" ? "descending" : "ascending" : "none"}><button onClick={() => changeSort("updated")}>Обновлено {filters.sort === "updated" && (filters.order === "asc" ? "↑" : "↓")}</button></th></tr></thead>
          <tbody>{tasks.map((task) => <tr key={task.task_id} tabIndex={0} aria-label={`Открыть задачу ${task.task_key ?? task.title}`} onClick={(event) => open(event, task)} onAuxClick={(event) => open(event, task)} onKeyDown={(event) => openKeyboard(event, task)}>
            <td className={s.key} data-label="Ключ">{task.task_key ?? "Задача"}</td>
            <td className={s.taskTitle}><Link to={getTaskRoute(task.task_id)}>{task.title}</Link></td>
            <td className={s.assignees} data-label="Исполнители"><div>{(task.assignees ?? task.assignments.map((assignment) => assignment.assignee)).map((person, index) => person.user_id == null ? <span className={s.person} data-row-action key={`historical-${index}`}>{person.display_name}</span> : <Link className={s.person} key={`${person.user_id}-${index}`} to={getContactRoute(person.user_id)}>{person.display_name}</Link>)}</div></td>
            <td className={s.status} data-label="Статус"><TaskStatusMenu task={task} variant="chip" /></td>
            <td className={s.deadline} data-label="Дедлайн"><time dateTime={task.deadline_at}>{displayDate(task.deadline_at)}</time></td>
            <td className={s.scope} data-label="Команда">{task.scope_title ?? (task.scope.kind === "block" ? "Блок" : "Подмероприятие")}</td>
            <td className={s.updated} data-label="Обновлено">{task.updated_at ? <time dateTime={task.updated_at}>{displayDate(task.updated_at)}</time> : "Нет данных"}</td>
          </tr>)}</tbody>
        </table>
      </div> : <Empty>Подходящих задач нет. Измените фильтры или создайте задачу на странице своей команды.</Empty>}
      <footer className={s.pagination}>
        <span aria-live="polite">На странице: {tasks.length}{query.data?.total != null && ` · Всего: ${query.data.total}`}</span>
        <div><button className={w.button} disabled={!cursor} onClick={goBack}>Назад</button><span>Страница {pageNumber}</span><button className={w.button} disabled={!query.data?.next_cursor} onClick={() => query.data?.next_cursor && turnPage(query.data.next_cursor)}>Далее</button></div>
      </footer>
    </QueryState>
    {scope && (!queue || can(queue, "create_task")) && <TaskCreateForm key={`${scope.kind}/${scope.id}/${queue?.queue_id ?? ""}`} scope={scope} queueId={queue?.queue_id} />}
  </section>;
}
