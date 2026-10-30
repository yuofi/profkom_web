import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  Badge,
  Empty,
  Glyph,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { workspaceApi } from "../../utils/api/workspace.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import {
  targetRoute,
  getEventRoute,
  getBlockRoute,
} from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { moscowDay, normalizeMonth } from "../../utils/calendar";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import type { ParticipationRole } from "../../utils/api/contract";
import s from "../../components/Workspace/Workspace.module.css";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { WorkdayTasks } from "./WorkdayTasks";
import { statusNames } from "./trackerStatus";
import c from "./calendar.module.css";
import { CalendarMonth, CalendarTimeGrid } from "./CalendarViews";
import { calendarTitle, calendarView, calendarWindow, shiftCalendarDate, validDay, type CalendarView } from "./calendarLayout";
import d from "./Dashboard.module.css";
import { ChipAvatar } from "../../components/Workspace/ChipFace";
import { blockLogo, eventLogo } from "../../utils/teamLogos";
import { can, useSession } from "../../utils/session";
import { canRetainData } from "../../utils/api/request";
import { useDebouncedValue } from "../../utils/hooks/useDebouncedValue";
import { useConfirmedNavigation } from "../../components/Workspace/unsavedChangesHooks";
function useSeasons() {
  return useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
}
const ROLE_LABELS: Record<ParticipationRole, string> = {
  member: "Участник блока",
  master: "Мастер",
  deputy_master: "Заместитель мастера",
  event_leader: "Главорг",
  event_deputy: "Заместитель главорга",
  subevent_leader: "Ответственный за подмероприятие",
  subevent_deputy: "Заместитель ответственного",
  organizer: "Организатор",
  subevent_hr: "HR подмероприятия",
};
const TEAM_PAGE_SIZE = 8;
interface PersonalTeam {
  id: string;
  title: string;
  to: string;
  roles: ParticipationRole[];
  detail?: string;
  logo?: string;
  kind: "block" | "event";
}
function PersonalTeams({ title, teams, empty }: { title: string; teams: PersonalTeam[]; empty: string }) {
  const [selectedPage, setSelectedPage] = useState(0);
  const pages = Math.ceil(teams.length / TEAM_PAGE_SIZE);
  const page = Math.min(selectedPage, Math.max(0, pages - 1));
  return (
    <section className={`${s.card} ${d.panel}`} aria-label={title}>
      <DashboardHeading title={title} count={teams.length} />
      <ul className={d.teams}>
        {teams.slice(page * TEAM_PAGE_SIZE, (page + 1) * TEAM_PAGE_SIZE).map((team) => (
          <li key={team.id}>
            <div className={d.teamRow}>
              <Link to={team.to} className={d.teamLink}><ChipAvatar src={team.logo} presentation="logo" className={d.teamAvatar} fallback={<Glyph name={team.kind === "block" ? "groups" : "celebration"} />} /><span>{team.title}</span><DashboardArrow small className={d.teamArrow} /></Link>
              <span className={d.roleSummary}>{team.roles.map(role => ROLE_LABELS[role]).join(" · ")}</span>
            </div>
            {team.detail && <small className={d.teamDetail}>{team.detail}</small>}
          </li>
        ))}
      </ul>
      {!teams.length && <Empty>{empty}</Empty>}
      {pages > 1 && <nav className={d.paging} aria-label={`${title}: страницы`}>
        <button className={s.button} disabled={page === 0} onClick={() => setSelectedPage(page - 1)}>Назад</button>
        <span role="status">{page + 1} из {pages}</span>
        <button className={s.button} disabled={page + 1 >= pages} onClick={() => setSelectedPage(page + 1)}>Далее</button>
      </nav>}
    </section>
  );
}
function DashboardArrow({ small = false, className = "" }: { small?: boolean; className?: string }) {
  return <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={small ? "m9 6 6 6-6 6" : "M4 12h16m-6-6 6 6-6 6"} /></svg>;
}
function DashboardHeading({ title, count, to, linkLabel }: { title: string; count?: number; to?: string; linkLabel?: string }) {
  return <div className={d.sectionHeading}><h2>{title}{count !== undefined && <span className={d.count}>{count}</span>}</h2>{to && <Link className={d.sectionLink} to={to}>{linkLabel ?? "Все"}<DashboardArrow /></Link>}</div>;
}
export function DashboardPage() {
  const { session } = useSession();
  const query = useQuery({ queryKey: ["participation"], queryFn: workspaceApi.participation });
  const seasons = useSeasons();
  const [watching, setWatching] = useState(false);
  const day = useQuery({ queryKey: ["dashboard", "home", watching], queryFn: () => workspaceApi.home(watching), refetchInterval: 60_000 });
  const blocks = query.data?.blocks ?? [];
  const events = query.data?.events ?? [];
  const hasApprovals = !day.error && !day.isLoading && !!day.data?.approvals.length;
  const workEntry = ["create_volunteer_merit", "create_head_merit", "create_chair_merit"].some(capability => can(session, capability) || !!session?.assignments?.some(assignment => can(assignment, capability)));
  const seasonTitle = (id: string | null) => seasons.data?.items.find(season => season.season_id === id)?.title ?? "Сезон";
  return <Page className={d.page} headerClassName={d.header} title="Рабочее пространство" description="Сегодня, ближайшие задачи и решения, которые ждут вас." actions={workEntry && <Link className={s.button} to="/merits"><Glyph name="fact_check" />Учёт работы</Link>}>
    <div className={d.utility}><label className={d.watching}><input type="checkbox" checked={watching} onChange={event => setWatching(event.target.checked)} />Также задачи, за которыми я наблюдаю</label></div>
    <QueryState loading={day.isLoading} error={day.error} retry={() => void day.refetch()}>{day.data && <div className={d.primary}>
      <Card className={`${d.panel} ${d.todayPanel}`}><DashboardHeading title="Сегодня" to={`/calendar?view=day&date=${day.data.today}`} linkLabel="Весь календарь" /><div className={d.calendar} role="region" aria-label="Сегодняшний день"><CalendarTimeGrid days={[day.data.today]} items={day.data.agenda} seasonTitle={seasonTitle} today={day.data.today} compact /></div></Card>
      <div className={d.taskPanels} role="region" aria-label="Задачи по срокам">
        <Card className={`${d.panel} ${d.overdue}`}><DashboardHeading title="Просроченные" count={day.data.overdue_count} to={day.data.overdue_count ? "/tasks?mine=true&unfinished=true&overdue=true" : undefined} linkLabel="Все просроченные задачи" /><WorkdayTasks tasks={day.data.overdue_tasks} overdue />{!day.data.overdue_count && <p className={d.note}>Просроченных задач нет.</p>}</Card>
        <Card className={d.panel}><DashboardHeading title="Ближайшие задачи" to="/tasks?mine=true&unfinished=true&sort=deadline" linkLabel="Все мои задачи" /><WorkdayTasks tasks={day.data.tasks} />{!day.data.tasks.length && <p className={d.note}>Нет задач с будущим дедлайном.</p>}{!!day.data.undated_count && <p className={d.undated}>Без срока: {day.data.undated_count}</p>}</Card>
      </div>
    </div>}</QueryState>
    <div className={d.lowerGrid} data-has-approvals={hasApprovals || undefined} role="region" aria-label="Работа и команды"><section className={d.myTeams}><h2 className={s.visuallyHidden}>Мои команды</h2>
      <QueryState loading={query.isLoading || seasons.isLoading} error={query.error ?? seasons.error} retry={() => { void query.refetch();void seasons.refetch(); }}>{query.data && <div className={d.teamColumns}><PersonalTeams title="Мои блоки" teams={blocks.map(block => ({ id: block.block_id, title: block.name, to: getBlockRoute(block.block_id), roles: block.roles, kind: "block", logo: blockLogo(block.name) }))} empty="Вы пока не участвуете в блоках." /><PersonalTeams title="Мои мероприятия" teams={events.map(event => ({ id: event.event_id, title: event.title, to: getEventRoute(event.event_id), roles: event.roles, detail: seasonTitle(event.season_id), kind: "event", logo: eventLogo(event.title) }))} empty="Вы пока не участвуете в мероприятиях незакрытых сезонов." /></div>}</QueryState>
    </section>{day.data && !day.error && hasApprovals && <Card className={`${d.panel} ${d.decisions}`}><DashboardHeading title="Требует решения" /><ul className={d.approvals}>{day.data.approvals.map(item => <li key={`${item.kind}-${item.to}`}><Link to={item.to}><span>{item.title}</span><span className={d.count}>{item.count}</span><DashboardArrow small /></Link></li>)}</ul></Card>}</div>
  </Page>;
}
export function CalendarPage() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [today, setToday] = useState(() => moscowDay(new Date().toISOString()));
  useEffect(() => { const update = () => setToday(moscowDay(new Date().toISOString()));const timer = window.setInterval(update, 60_000);window.addEventListener("focus", update);return () => { window.clearInterval(timer);window.removeEventListener("focus", update); }; }, []);
  const [params, setParams] = useSearchParams();
  const view = calendarView(params.get("view"));
  const requestedDate = params.get("date");
  const month = normalizeMonth(params.get("month") ?? (validDay(requestedDate) ? requestedDate.slice(0, 7) : today.slice(0, 7)));
  const date = validDay(requestedDate) && requestedDate.startsWith(month) ? requestedDate : month === today.slice(0, 7) ? today : `${month}-01`;
  const filters = { mine: params.get("mine") !== "false", kind: params.get("kind") ?? "", season_id: params.get("season_id") ?? "", block_id: params.get("block_id") ?? "", event_id: params.get("event_id") ?? "", queue_id: params.get("queue_id") ?? "", status: params.get("status") ?? "", q: params.get("q") ?? "" };
  const settledSearch = useDebouncedValue(filters.q), searchPending = settledSearch !== filters.q;
  const requestFilters = { ...filters, q: settledSearch };
  const seasons = useSeasons();
  const blocks = useQuery({ queryKey: ["workspaceBlocks"], queryFn: membershipApi.blocks, enabled: filtersOpen || !!filters.block_id });
  const events = useQuery({ queryKey: ["events"], queryFn: () => eventsApi.list(), enabled: filtersOpen || !!filters.event_id });
  const queues = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog, enabled: filtersOpen || !!filters.queue_id });
  // Closed filters expose no cached directory metadata; opening waits for current reads.
  const blockOptions = filtersOpen && !blocks.isFetching && (!blocks.error || canRetainData(blocks.error)) ? blocks.data : undefined;
  const eventOptions = filtersOpen && !events.isFetching && (!events.error || canRetainData(events.error)) ? events.data : undefined;
  const queueOptions = filtersOpen && !queues.isFetching && (!queues.error || canRetainData(queues.error)) ? queues.data : undefined;
  const range = calendarWindow(view, date);
  const query = useQuery({ queryKey: ["calendar", view, range.from, range.to, requestFilters], queryFn: ({ signal }) => workspaceApi.calendar(range.from, range.to, Object.fromEntries(Object.entries(requestFilters).filter(([, value]) => value !== "")), signal), enabled: !searchPending });
  const update = (key: string, value: string) => { const next = new URLSearchParams(params);next.set("month", month);next.set("date", date);if (value) next.set(key, value);else next.delete(key);setParams(next); };
  const navigatePeriod = (target: string, mode: CalendarView = view) => { const next = new URLSearchParams(params);next.set("date", target);next.set("month", target.slice(0, 7));next.set("view", mode);setParams(next); };
  const periodName = view === "month" ? "месяц" : view === "week" ? "неделя" : "день";
  const label = (id: string | null) => seasons.data?.items.find(season => season.season_id === id)?.title ?? "Сезон";
  const items = query.data?.items.filter(item => !filters.season_id || item.season_id === filters.season_id) ?? [];
  const names: Record<string, string> = { kind: "Вид записи", season_id: "Сезон", block_id: "Блок", event_id: "Мероприятие", queue_id: "Очередь", status: "Статус", q: "Поиск" };
  return <Page title="Календарь" description="Дедлайны, мероприятия и доступные созвоны. Время указано по МСК.">
    <div className={c.calendarToolbar}>
      <div className={c.monthNav} role="group" aria-label="Выбор периода"><button className={s.button} aria-label={view === "week" ? "Предыдущая неделя" : `Предыдущий ${periodName}`} onClick={() => navigatePeriod(shiftCalendarDate(date, view, -1))}>←</button><strong className={c.monthTitle} aria-live="polite">{calendarTitle(view, date)}</strong><button className={s.button} aria-label={view === "week" ? "Следующая неделя" : `Следующий ${periodName}`} onClick={() => navigatePeriod(shiftCalendarDate(date, view, 1))}>→</button><button className={s.button} onClick={() => navigatePeriod(today)}>Сегодня</button></div>
      <div className={c.viewSwitch} role="group" aria-label="Представление календаря">{([["day", "День"], ["week", "Неделя"], ["month", "Месяц"]] as const).map(([mode, title]) => <button type="button" className={s.button} key={mode} aria-pressed={view === mode} onClick={() => navigatePeriod(date, mode)}>{title}</button>)}</div>
    </div>
    <div className={c.topFilters}><label className={s.field}>Показывать<select value={filters.mine ? "mine" : "all"} onChange={event => update("mine", event.target.value === "all" ? "false" : "")}><option value="mine">Мои записи</option><option value="all">Все доступные</option></select></label><label className={s.field}>Поиск<input value={filters.q} placeholder="Название или ключ задачи" onChange={event => update("q", event.target.value)} /></label></div>
    <details className={c.filterPanel} onToggle={event => setFiltersOpen(event.currentTarget.open)}><summary>Фильтры календаря</summary><div className={c.filterGrid}>
      <label className={s.field}>Вид записи<select value={filters.kind} onChange={event => update("kind", event.target.value)}><option value="">Все виды</option><option value="event">Мероприятия</option><option value="meeting">Созвоны</option><option value="task_deadline">Дедлайны</option></select></label>
      <label className={s.field}>Сезон<select value={filters.season_id} onChange={event => update("season_id", event.target.value)}><option value="">Все незакрытые</option>{seasons.data?.items.map(season => <option value={season.season_id} key={season.season_id}>{season.title}</option>)}</select></label>
      <EntityPicker label="Блок" entity="block" value={filters.block_id} onChange={value => update("block_id", value)} placeholder="Все блоки" options={blockOptions?.map(block => ({ value: block.block_id, label: block.name, block: { block_id: block.block_id, name: block.name, avatar_url: block.avatar_url } })) ?? []} />
      <EntityPicker label="Мероприятие" value={filters.event_id} onChange={value => update("event_id", value)} placeholder="Все мероприятия" options={eventOptions?.items.map(event => ({ value: event.event_id, label: event.title })) ?? []} />
      <EntityPicker label="Очередь" value={filters.queue_id} onChange={value => update("queue_id", value)} placeholder="Все очереди" options={queueOptions?.items.filter(queue => queue.access === "granted").map(queue => ({ value: queue.queue_id, label: queue.name })) ?? []} />
      <label className={s.field}>Статус задач<select value={filters.status} onChange={event => update("status", event.target.value)}><option value="">Незавершённые</option>{Object.entries(statusNames).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
    </div></details>
    <div className={c.activeFilters} aria-label="Активные фильтры">{Object.entries(names).filter(([key]) => filters[key as keyof typeof filters]).map(([key, title]) => <button type="button" key={key} className={s.button} aria-label={`Убрать фильтр: ${title}`} onClick={() => update(key, "")}>{title} ×</button>)}<button className={s.button} onClick={() => setParams({ month, date, view })}>Сбросить фильтры</button></div>
    <QueryState loading={searchPending || query.isLoading || seasons.isLoading} error={query.error ?? seasons.error} retry={() => { void query.refetch();void seasons.refetch(); }}>
      {view === "month" ? <CalendarMonth days={range.days} offset={range.offset} items={items} today={today} seasonTitle={label} openDay={day => navigatePeriod(day, "day")} /> : <CalendarTimeGrid days={range.days} items={items} today={today} seasonTitle={label} />}
      {!items.length && <p className={s.muted}>На этот период нет доступных событий по выбранным условиям.</p>}
    </QueryState>
  </Page>;
}
export function NotificationsPage() {
  const navigate = useConfirmedNavigation();
  const { perform } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: workspaceApi.notifications,
  });
  return (
    <Page
      title="Уведомления"
      actions={query.data?.items.some((n) => !n.read_at) && (
        <ActionForm
          fields={[]}
          submitLabel="Прочитать все"
          onSubmit={async () => {
            await perform(workspaceApi.readAll);
          }}
        />
      )}
    >
      <div className={s.stack}>
        <QueryState
          loading={query.isLoading}
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        >
          {query.data?.items.map((n) => {
            const route = targetRoute(n.target);
            return (
              <Card key={n.id}>
                <div className={s.person}>
                  <div className={s.notice}>
                    <p className={n.read_at ? undefined : s.unread}>{n.text}</p>
                    <small className={s.muted}>{displayDate(n.created_at)}</small>
                  </div>
                  {!n.read_at && <Badge tone="yellow">Новое</Badge>}
                </div>
                <div className={s.row}>
                  {route ? (
                    <Link className={s.linkButton} to={route}
                      onClick={(event) => {
                        const read = () => n.read_at ? Promise.resolve() : perform(() => workspaceApi.read(n.id)).then(() => undefined).catch(() => undefined);
                        if (event.altKey) return;
                        if (event.metaKey || event.ctrlKey || event.shiftKey) { void read(); return; }
                        event.preventDefault();
                        navigate(route, read);
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1 && !n.read_at) void perform(() => workspaceApi.read(n.id)).catch(() => undefined);
                      }}
                    >Перейти к источнику</Link>
                  ) : (
                    <span className={s.muted}>Источник больше недоступен</span>
                  )}
                  {!n.read_at && (
                    <ActionForm
                      fields={[]}
                      submitLabel="Отметить прочитанным"
                      variant="quiet"
                      onSubmit={async () => {
                        await perform(() => workspaceApi.read(n.id));
                      }}
                    />
                  )}
                </div>
              </Card>
            );
          })}
          {query.data?.items.length === 0 && (
            <Empty>Уведомлений пока нет.</Empty>
          )}
        </QueryState>
      </div>
    </Page>
  );
}
