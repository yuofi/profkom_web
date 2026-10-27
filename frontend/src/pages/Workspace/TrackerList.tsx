import { TrackerHomeLink } from "../../components/Workspace/TrackerHomeLink";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
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
import { getTaskRoute, getTaskQueuesRoute, getTaskCreateRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { canRetainData } from "../../utils/api/request";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { TrackerFavoriteButton } from "./TrackerFavoriteButton";
import { TrackerCalendar } from "./TrackerCalendar";
import { TrackerGantt } from "./TrackerGantt";
import { loadPlanningTasks, planningMonth, planningRange, taskTypeNames, taskPriorityNames } from "./trackerPlanning";
import { UserChip } from "../../components/Workspace/UserChip";
import { statusNames } from "./trackerStatus";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerList.module.css";

const rowAction = "a,button,input,select,textarea,label,summary,dialog,[role='dialog'],[data-row-action]";
function interactive(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(rowAction);
}
const optionLabels: Record<string, string> = {
  mine: "Назначение", status: "Статус", season_id: "Сезон", scope: "Команда",
  assignee_user_id: "Исполнитель", unfinished: "Незавершённые", overdue: "Просроченные", q: "Поиск", queue_id: "Очередь", task_type: "Тип", priority: "Приоритет", favorite: "Избранное",
};

export function TrackerListPage({ queue, header }: { queue?: TaskQueue; header?: ReactNode }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const previous = useRef(new Map<string, string>());
  const filterMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !filterMenu.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest("[data-entity-picker-popup]"))) filterMenu.current?.removeAttribute("open"); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && filterMenu.current?.open) { filterMenu.current.open = false; filterMenu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  const view = params.get("view") === "calendar" ? "calendar" : params.get("view") === "gantt" ? "gantt" : "list";
  const month = planningMonth(params.get("month")), zoom = params.get("zoom") === "month" ? "month" : "week";
  const range = planningRange(month, view === "calendar" ? "calendar" : "gantt", zoom);
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
    task_type: params.get("task_type") ?? "",
    priority: params.get("priority") ?? "",
    favorite: params.get("favorite") ?? "",
    unfinished: params.get("unfinished") ?? "false",
    overdue: params.get("overdue") ?? "false",
    sort: params.get("sort") ?? "deadline",
    order: params.get("order") ?? "asc",
    limit: 20,
    ...(cursor ? { cursor } : {}),
  };
  const requestFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ""));
  const query = useQuery({ queryKey: ["tasks", "page", requestFilters], queryFn: () => tasksApi.listPage(requestFilters) });
  const timeline = useQuery({ queryKey: ["tasks", "planning", requestFilters, range.first, range.last], queryFn: ({ signal }) => loadPlanningTasks(requestFilters, range, signal), enabled: view !== "list" });
  const queues = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog, enabled: !queue });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const people = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts });
  const errors = [query.error, view !== "list" ? timeline.error : null].filter(error => !!error);
  // A transient companion request cannot mask a current access refusal on the plan.
  const error = errors.find(error => !canRetainData(error)) ?? errors[0] ?? null;
  const tasks = view === "list" ? query.data?.items ?? [] : timeline.data ?? [];
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
  if (filters.task_type) active.push({ key: "task_type", label: `Тип: ${taskTypeNames[filters.task_type] ?? filters.task_type}` });
  if (filters.priority) active.push({ key: "priority", label: `Приоритет: ${taskPriorityNames[filters.priority] ?? filters.priority}` });
  if (filters.favorite) active.push({ key: "favorite", label: filters.favorite === "true" ? "Избранные задачи" : "Неизбранные задачи" });
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
    {header ?? <BrandedHeader className={s.header}>
      <div><TrackerHomeLink /><h1 className={w.title}>Задачи</h1><p className={w.description}>Одна совместная работа — одна задача и общий статус.</p></div>
      <div className={s.headerLinks}><RouteLink to={getTaskQueuesRoute()}>Очереди</RouteLink>{can(session, "view_unresolved_assignments") && <RouteLink to="/tasks/unresolved">Оставшаяся работа</RouteLink>}</div>
    </BrandedHeader>}
    <div className={s.topbar}>
      <label className={s.search}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Поиск задач" placeholder="Название или ключ задачи" value={filters.q} onChange={(event) => update("q", event.target.value, true)} /></label>
      {(queue ? can(queue, "create_task") : queues.data?.items.some(item => can(item, "create_task"))) && <RouteLink to={getTaskCreateRoute({ queueId: queue?.queue_id, ...(scope ? { scope } : {}) })}>Создать задачу</RouteLink>}
      <div className={s.views} aria-label="Представление задач">
        {([["list", "Список"], ["calendar", "Календарь"], ["gantt", "Гантт"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => update("view", key === "list" ? "" : key)}>{label}</button>)}
      </div>
      <details ref={filterMenu} className={s.filters}>
        <summary><Glyph name="filter_list" />Добавить фильтр</summary>
        <div className={s.filterPanel}>
          <label className={w.field}>Назначение<select aria-label="Назначение" value={params.get("mine") ?? ""} onChange={(event) => update("mine", event.target.value)}><option value="">Без фильтра</option><option value="true">Мои задачи</option><option value="false">Все доступные</option></select></label>
          <label className={w.field}>Статус<select aria-label="Статус" value={filters.status} onChange={(event) => update("status", event.target.value)}><option value="">Любой статус</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={w.field}>Тип<select aria-label="Тип задачи" value={filters.task_type} onChange={event => update("task_type", event.target.value)}><option value="">Все типы</option>{Object.entries(taskTypeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={w.field}>Приоритет<select aria-label="Приоритет" value={filters.priority} onChange={event => update("priority", event.target.value)}><option value="">Все приоритеты</option>{Object.entries(taskPriorityNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={w.field}>Сезон<select aria-label="Сезон" value={filters.season_id} onChange={(event) => update("season_id", event.target.value)}><option value="">Все сезоны</option>{seasons.data?.items.map((item) => <option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>
          {!queue && <label className={w.field}>Очередь<select aria-label="Очередь" value={filters.queue_id} onChange={event => update("queue_id", event.target.value)}><option value="">Все доступные очереди</option>{queues.data?.items.filter(item => item.access === "granted").map(item => <option key={item.queue_id} value={item.queue_id}>{item.key} · {item.name}</option>)}</select></label>}
          {!queue && <EntityPicker label="Команда" value={scopeValue} onChange={value => update("scope", value)} placeholder="Все команды" options={[{ value: "", label: "Все команды" }, ...(scope && !selectedScope ? [{ value: scopeValue, label: "Текущая команда", scope: { kind: scope.kind, name: "Текущая команда" } }] : []), ...scopes.map(item => ({ value: JSON.stringify([item.kind, item.id]), label: item.title, scope: { kind: item.kind, name: item.title } }))]} />}
          <EntityPicker label="Исполнитель" value={filters.assignee_user_id} onChange={value => update("assignee_user_id", value)} placeholder="Все исполнители" options={[{ value: "", label: "Все исполнители" }, ...(people.data?.filter(item => item.in_profcom).map(item => ({ value: String(item.user_id), label: [item.surname, item.name, item.patronymic].filter(Boolean).join(" "), user: { user_id: item.user_id, display_name: [item.surname, item.name, item.patronymic].filter(Boolean).join(" "), avatar_url: item.photo_url ?? null } })) ?? [])]} />
          <label className={w.field}>Сортировать<select aria-label="Сортировать" value={filters.sort} onChange={(event) => update("sort", event.target.value)}><option value="deadline">По дедлайну</option><option value="updated">По обновлению</option><option value="created">По созданию</option><option value="priority">По приоритету</option><option value="starts">По плановому началу</option></select></label>
          <label className={w.field}>Порядок<select aria-label="Порядок" value={filters.order} onChange={(event) => update("order", event.target.value)}><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></label>
          <label className={w.check}><input type="checkbox" checked={filters.favorite === "true"} onChange={event => update("favorite", event.target.checked ? "true" : "")} />Только избранные</label>
          <label className={w.check}><input type="checkbox" checked={filters.unfinished === "true"} onChange={(event) => update("unfinished", event.target.checked ? "true" : "")} />Незавершённые</label>
          <label className={w.check}><input type="checkbox" checked={filters.overdue === "true"} onChange={(event) => update("overdue", event.target.checked ? "true" : "")} />Просроченные</label>
        </div>
      </details>
    </div>
    <div className={s.activeFilters} aria-label="Активные фильтры">
      {active.map((filter) => <span className={s.filterChip} key={filter.key}>{filter.label}<button type="button" aria-label={`Убрать фильтр: ${optionLabels[filter.key]}`} onClick={() => update(filter.key, "")}><Glyph name="close" /></button></span>)}
      {!active.length && <span className={s.filterHint}>Показаны все доступные вам задачи</span>}
      {active.length > 1 && <button type="button" className={s.clear} onClick={() => { previous.current.clear(); const next = new URLSearchParams();["view", "month", "zoom"].forEach(key => { const value = params.get(key);if (value) next.set(key, value); });setParams(next); }}>Сбросить все</button>}
    </div>
    <QueryState loading={query.isLoading || view !== "list" && timeline.isLoading} error={error} keepDataOnError={view === "list" ? !!query.data : !!timeline.data} retry={() => { void query.refetch();if (view !== "list") void timeline.refetch(); }}>
      {view === "calendar" ? <TrackerCalendar tasks={tasks} range={range} month={month} onMonth={value => update("month", value)} /> : view === "gantt" ? <TrackerGantt tasks={tasks} range={range} month={month} onMonth={value => update("month", value)} zoom={zoom} onZoom={value => update("zoom", value)} /> : tasks.length ? <div className={s.tableWrap}>
        <table className={s.table} aria-label="Список задач">
          <thead><tr><th scope="col">Ключ</th><th scope="col">Задача</th><th scope="col">Исполнители</th><th scope="col">Статус</th><th scope="col" aria-sort={filters.sort === "deadline" ? filters.order === "desc" ? "descending" : "ascending" : "none"}><button onClick={() => changeSort("deadline")}>Дедлайн {filters.sort === "deadline" && (filters.order === "asc" ? "↑" : "↓")}</button></th><th scope="col">Команда</th><th scope="col" aria-sort={filters.sort === "updated" ? filters.order === "desc" ? "descending" : "ascending" : "none"}><button onClick={() => changeSort("updated")}>Обновлено {filters.sort === "updated" && (filters.order === "asc" ? "↑" : "↓")}</button></th></tr></thead>
          <tbody>{tasks.map((task) => <tr key={task.task_id} tabIndex={0} aria-label={`Открыть задачу ${task.task_key ?? task.title}`} onClick={(event) => open(event, task)} onAuxClick={(event) => open(event, task)} onKeyDown={(event) => openKeyboard(event, task)}>
            <td className={s.key} data-label="Ключ"><div className={s.keyRow}><span>{task.task_key ?? "Задача"}</span><TrackerFavoriteButton task={task} compact /></div></td>
            <td className={s.taskTitle}><Link to={getTaskRoute(task.task_id)}>{task.title}</Link><div className={s.taskTags}><span>{taskTypeNames[task.task_type ?? "task"]}</span><span data-priority={task.priority ?? "normal"}>{taskPriorityNames[task.priority ?? "normal"]}</span></div></td>
            <td className={s.assignees} data-label="Исполнители"><div>{(task.assignees ?? task.assignments.map((assignment) => assignment.assignee)).map((person, index) => <UserChip user={person} key={`${person.user_id ?? "historical"}-${index}`} />)}</div></td>
            <td className={s.status} data-label="Статус"><TaskStatusMenu task={task} variant="chip" /></td>
            <td className={s.deadline} data-label="Дедлайн"><time dateTime={task.deadline_at}>{displayDate(task.deadline_at)}</time></td>
            <td className={s.scope} data-label="Команда">{task.scope_title ?? (task.scope.kind === "block" ? "Блок" : task.scope.kind === "subevent" ? "Подмероприятие" : "Очередь")}</td>
            <td className={s.updated} data-label="Обновлено">{task.updated_at ? <time dateTime={task.updated_at}>{displayDate(task.updated_at)}</time> : "Нет данных"}</td>
          </tr>)}</tbody>
        </table>
      </div> : <Empty>Подходящих задач нет. Измените фильтры или создайте задачу на странице своей команды.</Empty>}
      {view === "list" && <footer className={s.pagination}>
        <span aria-live="polite">На странице: {tasks.length}{query.data?.total != null && ` · Всего: ${query.data.total}`}</span>
        <div><button className={w.button} disabled={!cursor} onClick={goBack}>Назад</button><span>Страница {pageNumber}</span><button className={w.button} disabled={!query.data?.next_cursor} onClick={() => query.data?.next_cursor && turnPage(query.data.next_cursor)}>Далее</button></div>
      </footer>}
    </QueryState>

  </section>;
}
