import { TaskClassificationMenu } from "./TaskClassificationMenu";
import { TrackerHomeLink } from "../../components/Workspace/TrackerHomeLink";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { useEffect, useRef, useState, type MouseEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "../../utils/hooks/useDebouncedValue";
import { Empty, Glyph, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { directoryApi } from "../../utils/api/directory.api";
import type { ScopeRef, Task, TaskQueue, UserRef } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { getTaskRoute, getTaskQueuesRoute, getTaskCreateRoute } from "../../utils/routes";
import { useTaskPrefetch } from "../../utils/routePrefetch";
import { displayDate, shortDate } from "../../utils/dates";
import { canRetainData } from "../../utils/api/request";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { TrackerFavoriteButton } from "./TrackerFavoriteButton";
import { TrackerCalendar } from "./TrackerCalendar";
import { TrackerGantt } from "./TrackerGantt";
import { taskTypeNames, taskPriorityNames } from "./trackerPlanning";
import { trackerTaskRead } from "./trackerTaskRead";
import { UserChip } from "../../components/Workspace/UserChip";
import { publicStatusNames as statusNames } from "./trackerStatus";
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
// Any of these makes the selection explicit; a bare main list opens on the current season's unfinished work.
const selectionKeys = ["queue_id", "mine", "status", "season_id", "scope_kind", "scope_id", "assignee_user_id", "q", "task_type", "priority", "favorite", "unfinished", "overdue", "cursor"];
const defaultKeys = ["season_id", "unfinished"];
const scopeKindNames: Record<string, string> = { block: "блок", subevent: "подмероприятие", event: "мероприятие", chair: "Работа председателя" };

export function TrackerListPage({ queue, header }: { queue?: TaskQueue; header?: ReactNode }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const [params, setParams] = useSearchParams(), location = useLocation();
  const filterMenu = useRef<HTMLDetailsElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const search = params.get("q") ?? "", settledSearch = useDebouncedValue(search);
  const searchPending = search !== settledSearch;
  useEffect(() => {
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !filterMenu.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest("[data-entity-picker-popup]"))) filterMenu.current?.removeAttribute("open"); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && filterMenu.current?.open) { filterMenu.current.open = false; filterMenu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  // The same read a queue page starts with the queue (PF-14): one definition, one key.
  const read = trackerTaskRead(params, queue?.queue_id, settledSearch);
  const { view, month, zoom, range, cursor, filters } = read;
  const needsDefaults = !queue && !selectionKeys.some(key => params.has(key));
  const pageNumber = Math.max(1, Number(params.get("page")) || 1);
  // Cursors of earlier pages live in this history entry (they survive a reload); the URL
  // keeps the immediately previous cursor so an opened link can still step back once.
  const previousCursor = params.get("prev_cursor") ?? "";
  const savedCursors = (location.state as { trackerCursors?: unknown } | null)?.trackerCursors;
  const cursorStack = Array.isArray(savedCursors) && savedCursors.every(item => typeof item === "string") && savedCursors.length === pageNumber - 1 && (savedCursors.at(-1) ?? "") === previousCursor
    ? savedCursors as string[] : pageNumber === 1 ? [] : null;
  // The previous page stays on screen while the next selection loads; a refused read still has no data.
  const query = useQuery({ ...read.list, enabled: !searchPending && !needsDefaults && view === "list", placeholderData: keepPreviousData });
  const listBusy = searchPending || query.isPlaceholderData;
  const timeline = useQuery({ ...read.planning, enabled: view !== "list" && !searchPending && !needsDefaults });
  const selection = Object.fromEntries(Object.entries({ queue_id: filters.queue_id, season_id: filters.season_id, scope_kind: filters.scope_kind, scope_id: filters.scope_id }).filter(([, value]) => value !== ""));
  const scopeFiltered = !queue && !!filters.scope_kind && !!filters.scope_id;
  const facets = useQuery({ queryKey: ["tasks", "facets", selection], queryFn: ({ signal }) => tasksApi.facets(selection, signal), enabled: !needsDefaults && (filtersOpen || scopeFiltered) });
  const queues = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog, enabled: !queue && (filtersOpen || !!filters.queue_id) });
  const createAccess = useQuery({ queryKey: ["tasks", "queues", "create-access"], queryFn: taskQueuesApi.createAccess, enabled: !queue });
  const currentSeason = useQuery({ queryKey: ["seasons", "current"], queryFn: seasonsApi.current, enabled: !queue && (needsDefaults || !!filters.season_id) });
  const currentSeasonFilter = !!filters.season_id && filters.season_id === currentSeason.data?.season_id;
  useEffect(() => {
    if (!needsDefaults || currentSeason.isPending) return;
    const next = new URLSearchParams(params);
    if (currentSeason.data) next.set("season_id", currentSeason.data.season_id);
    next.set("unfinished", "true");
    // The bare list with only its defaults is still the section's own page: the stamp stays current (GL-36).
    setParams(next, { replace: true, state: params.toString() ? null : { sectionDefaults: true } });
  }, [needsDefaults, currentSeason.isPending, currentSeason.data, params, setParams]);
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled: filtersOpen || !!filters.season_id && !currentSeasonFilter && (!!queue || !currentSeason.isPending) });
  const people = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts, enabled: filtersOpen || !!filters.assignee_user_id });
  const peopleOptions = filtersOpen && !people.isFetching && (!people.error || canRetainData(people.error)) ? people.data : undefined;
  const seasonOptions = filtersOpen && !seasons.isFetching && (!seasons.error || canRetainData(seasons.error)) ? seasons.data : undefined;
  const errors = [view === "list" ? query.error : null, view !== "list" ? timeline.error : null].filter(error => !!error);
  // A transient companion request cannot mask a current access refusal on the plan.
  const error = errors.find(error => !canRetainData(error)) ?? errors[0] ?? null;
  const tasks = view === "list" ? query.data?.items ?? [] : timeline.data ?? [];
  const scopes = facets.data?.scopes ?? [];
  const selectedScope = scopes.find((scope) => scope.kind === filters.scope_kind && scope.id === filters.scope_id);
  const scope: ScopeRef | null = queue?.scope ?? (["block", "subevent"].includes(filters.scope_kind) && filters.scope_id
    ? { kind: filters.scope_kind as ScopeRef["kind"], id: filters.scope_id } : null);
  const scopedCreation = useQuery({ queryKey: ["tasks", "list-create-capability", scope?.kind, scope?.id], enabled: !!scope && !queue,
    queryFn: async () => scope ? can(await (scope.kind === "block" ? membershipApi.block(scope.id) : eventsApi.subevent(scope.id)), "create_task") : false });
  const canCreateInScope = (!scopedCreation.error || canRetainData(scopedCreation.error)) && scopedCreation.data === true;
  // The filter chip names every team kind the server filters by; creation stays limited to block and subevent.
  const filterScope: ScopeRef | null = !queue && Object.hasOwn(scopeKindNames, filters.scope_kind) && filters.scope_id
    ? { kind: filters.scope_kind as ScopeRef["kind"], id: filters.scope_id } : null;
  const scopeValue = filterScope ? JSON.stringify([filterScope.kind, filterScope.id]) : "";
  // Inside a team queue every row has that team; shared queues and the main list keep the column.
  const showScope = !queue?.scope;
  const update = (key: string, value: string, replace = false) => {
    const next = new URLSearchParams(params);
    if (key === "scope") {
      next.delete("scope_kind"); next.delete("scope_id");
      if (value) {
        const [kind, id] = JSON.parse(value) as [string, string];
        next.set("scope_kind", kind); next.set("scope_id", id);
      }
    } else if (value) next.set(key, value);
    // Clearing a default keeps an explicit empty key, so the list does not snap back to the default.
    else if (!queue && defaultKeys.includes(key)) next.set(key, "");
    else next.delete(key);
    next.delete("cursor"); next.delete("page"); next.delete("prev_cursor");
    setParams(next, { replace });
  };
  const turnPage = (nextCursor: string) => {
    const next = new URLSearchParams(params);
    next.set("cursor", nextCursor); next.set("page", String(pageNumber + 1));
    if (cursor) next.set("prev_cursor", cursor); else next.delete("prev_cursor");
    setParams(next, { state: cursorStack ? { trackerCursors: [...cursorStack, cursor] } : null });
  };
  const goBack = () => {
    const next = new URLSearchParams(params), before = cursorStack ? cursorStack.at(-1) ?? "" : previousCursor;
    const earlier = cursorStack?.slice(0, -1) ?? null;
    if (before) {
      next.set("cursor", before); next.set("page", String(Math.max(2, pageNumber - 1)));
      if (earlier?.at(-1)) next.set("prev_cursor", earlier.at(-1)!); else next.delete("prev_cursor");
    } else { next.delete("cursor"); next.delete("page"); next.delete("prev_cursor"); }
    setParams(next, { state: earlier && before ? { trackerCursors: earlier } : null });
  };
  const changeSort = (sort: string) => {
    const next = new URLSearchParams(params);
    next.set("sort", sort); next.set("order", filters.sort === sort && filters.order === "asc" ? "desc" : "asc");
    next.delete("cursor"); next.delete("page"); next.delete("prev_cursor"); setParams(next);
  };
  // Resting on the task's own link counts; on another control of the row (a person's chip,
  // the star, the status menu) it is meant for that control and starts nothing.
  const prefetchTask = useTaskPrefetch(target => interactive(target) && !(target instanceof Element && target.closest('a[href^="/tasks/"]')));
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
  if (filters.season_id) active.push({ key: "season_id", label: `Сезон: ${seasons.data?.items.find((item) => item.season_id === filters.season_id)?.title ?? (currentSeasonFilter ? currentSeason.data?.title : null) ?? (currentSeason.isLoading || seasons.isLoading ? "…" : "выбран")}` });
  if (filterScope) active.push({ key: "scope", label: `Команда: ${filterScope.kind === "chair" ? scopeKindNames.chair : selectedScope?.title ?? scopeKindNames[filterScope.kind]}` });
  if (filters.assignee_user_id) {
    const person = people.data?.find((item) => String(item.user_id) === filters.assignee_user_id);
    active.push({ key: "assignee_user_id", label: `Исполнитель: ${person ? `${person.surname} ${person.name}` : "выбран"}` });
  }
  if (filters.unfinished === "true") active.push({ key: "unfinished", label: "Незавершённые" });
  if (filters.overdue === "true") active.push({ key: "overdue", label: "Просроченные" });
  const atDefaults = !queue && [...params.keys()].every(key => !selectionKeys.includes(key) || defaultKeys.includes(key)) && filters.unfinished === "true" && (currentSeasonFilter || !currentSeason.data && !filters.season_id);
  return <section className={s.page}>
    {header ?? <BrandedHeader className={s.header}>
      <div><TrackerHomeLink /><h1 className={w.title}>Задачи</h1><p className={w.description}>Одна совместная работа — одна задача и общий статус.</p></div>
      <div className={s.headerLinks}><RouteLink to={getTaskQueuesRoute()}>Очереди</RouteLink>{can(session, "view_unresolved_assignments") && <RouteLink to="/tasks/unresolved">Оставшаяся работа</RouteLink>}</div>
    </BrandedHeader>}
    <div className={s.topbar}>
      <label className={s.search}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Поиск задач" placeholder="Название или ключ" value={filters.q} onChange={(event) => update("q", event.target.value, true)} /></label>
      {(queue ? can(queue, "create_task") : canCreateInScope || ((!createAccess.error || canRetainData(createAccess.error)) && createAccess.data?.can_create_task === true)) && <Link className={w.linkButton} to={getTaskCreateRoute({ queueId: queue?.queue_id, ...(scope ? { scope } : {}) })} title="Создать задачу"><Glyph name="add" /><span className={s.toolLabel}>Создать задачу</span></Link>}
      <div className={s.views} aria-label="Представление задач">
        {([["list", "Список"], ["calendar", "Календарь"], ["gantt", "Гантт"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => update("view", key === "list" ? "" : key)}>{label}</button>)}
      </div>
      <details ref={filterMenu} className={s.filters} onToggle={event => setFiltersOpen(event.currentTarget.open)}>
        <summary title="Добавить фильтр"><Glyph name="filter_list" /><span className={s.toolLabel}>Добавить фильтр</span></summary>
        <div className={s.filterPanel}>
          <label className={w.field}>Назначение<select aria-label="Назначение" value={params.get("mine") ?? ""} onChange={(event) => update("mine", event.target.value)}><option value="">Без фильтра</option><option value="true">Мои задачи</option><option value="false">Все доступные</option></select></label>
          <label className={w.field}>Статус<select aria-label="Статус" value={filters.status} onChange={(event) => update("status", event.target.value)}><option value="">Любой статус</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={w.field}>Тип<select aria-label="Тип задачи" value={filters.task_type} onChange={event => update("task_type", event.target.value)}><option value="">Все типы</option>{Object.entries(taskTypeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={w.field}>Приоритет<select aria-label="Приоритет" value={filters.priority} onChange={event => update("priority", event.target.value)}><option value="">Все приоритеты</option>{Object.entries(taskPriorityNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={w.field}>Сезон<select aria-label="Сезон" value={filters.season_id} onChange={(event) => update("season_id", event.target.value)}><option value="">Все сезоны</option>{seasonOptions?.items.map((item) => <option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>
          {!queue && <label className={w.field}>Очередь<select aria-label="Очередь" value={filters.queue_id} onChange={event => update("queue_id", event.target.value)}><option value="">Все доступные очереди</option>{queues.data?.items.filter(item => item.access === "granted").map(item => <option key={item.queue_id} value={item.queue_id}>{item.key} · {item.name}</option>)}</select></label>}
          {!queue && <EntityPicker label="Команда" value={scopeValue} onChange={value => update("scope", value)} placeholder="Все команды" options={[{ value: "", label: "Все команды" }, ...(filterScope && !selectedScope ? [{ value: scopeValue, label: filterScope.kind === "chair" ? scopeKindNames.chair : "Текущая команда", scope: { kind: filterScope.kind, name: filterScope.kind === "chair" ? scopeKindNames.chair : "Текущая команда" } }] : []), ...scopes.map(item => ({ value: JSON.stringify([item.kind, item.id]), label: item.title, scope: { kind: item.kind, name: item.title } }))]} />}
          <EntityPicker label="Исполнитель" value={filters.assignee_user_id} onChange={value => update("assignee_user_id", value)} placeholder="Все исполнители" options={[{ value: "", label: "Все исполнители" }, ...(peopleOptions?.filter(item => item.in_profcom).map(item => ({ value: String(item.user_id), label: [item.surname, item.name, item.patronymic].filter(Boolean).join(" "), user: { user_id: item.user_id, display_name: [item.surname, item.name, item.patronymic].filter(Boolean).join(" "), avatar_url: item.photo_url ?? null } })) ?? [])]} />
          <label className={w.field}>Сортировать<select aria-label="Сортировать" value={filters.sort} onChange={(event) => update("sort", event.target.value)}><option value="deadline">По дедлайну</option><option value="updated">По обновлению</option><option value="created">По созданию</option><option value="priority">По приоритету</option><option value="starts">По плановому началу</option></select></label>
          <label className={w.field}>Порядок<select aria-label="Порядок" value={filters.order} onChange={(event) => update("order", event.target.value)}><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></label>
          <label className={w.check}><input type="checkbox" checked={filters.favorite === "true"} onChange={event => update("favorite", event.target.checked ? "true" : "")} />Только избранные</label>
          <label className={w.check}><input type="checkbox" checked={filters.unfinished === "true"} onChange={(event) => update("unfinished", event.target.checked ? "true" : "")} />Незавершённые</label>
          <label className={w.check}><input type="checkbox" checked={filters.overdue === "true"} onChange={(event) => update("overdue", event.target.checked ? "true" : "")} />Просроченные</label>
          <div className={s.sheetActions}><button type="button" className={w.button} onClick={() => { if (filterMenu.current) filterMenu.current.open = false;filterMenu.current?.querySelector("summary")?.focus(); }}>Готово</button></div>
        </div>
      </details>
    </div>
    <div className={s.activeFilters} aria-label="Активные фильтры">
      {active.map((filter) => <span className={s.filterChip} key={filter.key}>{filter.label}<button type="button" aria-label={`Убрать фильтр: ${optionLabels[filter.key]}`} onClick={() => update(filter.key, "")}><Glyph name="close" /></button></span>)}
      {!active.length && !needsDefaults && <span className={s.filterHint}>Показаны все доступные вам задачи</span>}
      {active.length > 1 && !atDefaults && !(filters.season_id && currentSeason.isLoading) && <button type="button" className={s.clear} onClick={() => { const next = new URLSearchParams();["view", "month", "zoom"].forEach(key => { const value = params.get(key);if (value) next.set(key, value); });setParams(next); }}>Сбросить все</button>}
    </div>
    <QueryState loading={needsDefaults || (view === "list" ? query.isLoading : timeline.isLoading)} error={error} keepDataOnError={view === "list" ? !!query.data : !!timeline.data} retry={() => { if (view === "list") void query.refetch();else void timeline.refetch(); }}>
      {view === "calendar" ? <TrackerCalendar tasks={tasks} range={range} month={month} onMonth={value => update("month", value)} /> : view === "gantt" ? <TrackerGantt tasks={tasks} range={range} month={month} onMonth={value => update("month", value)} zoom={zoom} onZoom={value => update("zoom", value)} /> : tasks.length ? <div className={s.tableWrap} aria-busy={listBusy || undefined}>
        <table className={s.table} aria-label="Список задач">
          <thead><tr><th scope="col" className={s.colKey}>Ключ</th><th scope="col">Задача</th><th scope="col" className={s.colAssignees}>Исполнители</th><th scope="col" className={s.colStatus}>Статус</th><th scope="col" className={s.colDeadline} aria-sort={filters.sort === "deadline" ? filters.order === "desc" ? "descending" : "ascending" : "none"}><button onClick={() => changeSort("deadline")}>Дедлайн {filters.sort === "deadline" && (filters.order === "asc" ? "↑" : "↓")}</button></th>{showScope && <th scope="col" className={s.colScope}>Команда</th>}<th scope="col" className={s.colUpdated} aria-sort={filters.sort === "updated" ? filters.order === "desc" ? "descending" : "ascending" : "none"}><button onClick={() => changeSort("updated")}>Обновлено {filters.sort === "updated" && (filters.order === "asc" ? "↑" : "↓")}</button></th></tr></thead>
          <tbody>{tasks.map((task) => <tr key={task.task_id} tabIndex={0} aria-label={`Открыть задачу ${task.task_key ?? task.title}`} {...prefetchTask(task.task_id)} onClick={(event) => open(event, task)} onAuxClick={(event) => open(event, task)} onKeyDown={(event) => openKeyboard(event, task)}>
            <td className={s.key} data-label="Ключ"><div className={s.keyRow}><div className={s.classificationControls}><TaskClassificationMenu task={task} field="task_type" iconOnly /><TaskClassificationMenu task={task} field="priority" iconOnly /></div><span className={s.keyName}><span className={s.keyText}>{task.task_key ?? "Задача"}</span><TrackerFavoriteButton task={task} compact /></span></div></td>
            <td className={s.taskTitle}><Link to={getTaskRoute(task.task_id)}>{task.title}</Link></td>
            <td className={s.assignees} data-label="Исполнители"><Assignees people={task.assignees ?? task.assignments.map((assignment) => assignment.assignee)} /></td>
            <td className={s.status} data-label="Статус"><TaskStatusMenu task={task} onClosed={saved => { if (can(saved, "view_assessment_inputs")) navigate(`${getTaskRoute(saved.task_id)}?kkr=1`); }} /></td>
            <td className={s.deadline} data-label="Дедлайн">{task.deadline_at ? <><span className={s.cellLabel}>Дедлайн: </span><ListDate value={task.deadline_at} label="Дедлайн" /></> : <span>Без дедлайна</span>}</td>
            {showScope && <td className={s.scope} data-label="Команда"><span title={task.scope_title ?? undefined}>{task.scope_title ?? (task.scope.kind === "block" ? "Блок" : task.scope.kind === "subevent" ? "Подмероприятие" : "Очередь")}</span></td>}
            <td className={s.updated} data-label="Обновлено">{task.updated_at ? <ListDate value={task.updated_at} label="Обновлено" /> : "Нет данных"}</td>
          </tr>)}</tbody>
        </table>
      </div> : <Empty>Подходящих задач нет. Измените фильтры или создайте задачу на странице своей команды.</Empty>}
    </QueryState>
    {view === "list" && query.data && (!error || canRetainData(error)) && <footer className={s.pagination}>
      <span aria-live="polite">На странице: {tasks.length}{query.data.total != null && ` · Всего: ${query.data.total}`}</span>
      {(cursor || query.data.next_cursor) && <div><button className={w.button} disabled={!cursor || listBusy} onClick={goBack}>Назад</button><span>Страница {pageNumber}</span><button className={w.button} disabled={!query.data.next_cursor || listBusy} onClick={() => query.data?.next_cursor && turnPage(query.data.next_cursor)}>Далее</button></div>}
    </footer>}

  </section>;
}
/** One line per row (D-02): the first person stays visible, the rest are named in one accessible counter beside them;
 *  the task page lists everyone, and a tap on the counter opens it as the rest of the row does. */
function Assignees({ people }: { people: UserRef[] }) {
  const [first] = people, rest = people.slice(1), names = rest.map(person => person.display_name).join(", ");
  return <div>{first && <UserChip user={first} />}{rest.length > 0 && <span className={s.morePeople} title={`Ещё: ${names}`}>+{rest.length}<span className={w.visuallyHidden}> — ещё исполнители: {names}</span></span>}</div>;
}
/** A list date without the current year (D-02); the tooltip keeps the full date and what it is. */
function ListDate({ value, label }: { value: string; label: string }) {
  const full = displayDate(value), text = shortDate(value);
  return <time dateTime={value} title={`${label}: ${full}`} data-full={text === full || undefined}>{text}</time>;
}
