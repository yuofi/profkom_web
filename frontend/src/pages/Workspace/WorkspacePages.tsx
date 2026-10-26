import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
  Badge,
  Empty,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { workspaceApi } from "../../utils/api/workspace.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import {
  targetRoute,
  getEventRoute,
  getBlockRoute,
  getMeetingRoute,
} from "../../utils/routes";
import { displayDate, displayTime } from "../../utils/dates";
import { monthDays, moscowDay, shiftMonth, monthTitle } from "../../utils/calendar";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { can, useSession } from "../../utils/session";
import type { CalendarItem, ParticipationRole } from "../../utils/api/contract";
import s from "../../components/Workspace/Workspace.module.css";
import { toneStyle, type Tone } from "../../components/Workspace/sections";
import c from "./calendar.module.css";
import p from "./participation.module.css";
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
};
const TEAM_PAGE_SIZE = 8;
interface PersonalTeam {
  id: string;
  title: string;
  to: string;
  roles: ParticipationRole[];
  detail?: string;
}
function PersonalTeams({ title, teams, empty }: { title: string; teams: PersonalTeam[]; empty: string }) {
  const [selectedPage, setSelectedPage] = useState(0);
  const pages = Math.ceil(teams.length / TEAM_PAGE_SIZE);
  const page = Math.min(selectedPage, Math.max(0, pages - 1));
  return (
    <Card title={`${title} · ${teams.length}`}>
      <ul className={p.teams}>
        {teams.slice(page * TEAM_PAGE_SIZE, (page + 1) * TEAM_PAGE_SIZE).map((team) => (
          <li key={team.id}>
            <Link to={team.to}>{team.title}</Link>
            <div className={s.badges}>
              {team.roles.map((role) => <Badge key={role}>{ROLE_LABELS[role]}</Badge>)}
            </div>
            {team.detail && <small className={s.muted}>{team.detail}</small>}
          </li>
        ))}
      </ul>
      {!teams.length && <Empty>{empty}</Empty>}
      {pages > 1 && <nav className={p.paging} aria-label={`${title}: страницы`}>
        <button className={s.button} disabled={page === 0} onClick={() => setSelectedPage(page - 1)}>Назад</button>
        <span role="status">{page + 1} из {pages}</span>
        <button className={s.button} disabled={page + 1 >= pages} onClick={() => setSelectedPage(page + 1)}>Далее</button>
      </nav>}
    </Card>
  );
}
export function DashboardPage() {
  const { session } = useSession();
  const query = useQuery({ queryKey: ["participation"], queryFn: workspaceApi.participation });
  const seasons = useSeasons();
  const [seasonId, setSeasonId] = useState("");
  const [search, setSearch] = useState("");
  const needle = search.trim().toLocaleLowerCase("ru");
  const blocks = (query.data?.blocks ?? []).filter((b) => b.name.toLocaleLowerCase("ru").includes(needle));
  const events = (query.data?.events ?? []).filter((event) =>
    (!seasonId || event.season_id === seasonId) && event.title.toLocaleLowerCase("ru").includes(needle),
  );
  const seasonTitle = (id: string) => seasons.data?.items.find((season) => season.season_id === id)?.title ?? "Сезон";
  return (
    <Page title="Мои блоки и мероприятия" description="Ваше участие и роли в командах. Блоки не зависят от сезона.">
      <nav className={p.quickLinks} aria-label="Рабочие разделы">
        <RouteLink to="/tasks?mine=true">Мои задачи</RouteLink>
        <RouteLink to="/calendar">Календарь</RouteLink>
        <RouteLink to="/blocks/requests">Мои заявки и решения</RouteLink>
        {can(session, "view_unresolved_assignments") && <RouteLink to="/tasks/unresolved">Назначения к решению</RouteLink>}
        {can(session, "review_registrations") && <RouteLink to="/admin/registrations">Регистрации</RouteLink>}
      </nav>
      <div className={s.filters}>
        <label className={s.field}>Поиск по моим командам
          <input value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label className={s.field}>Сезон мероприятий
          <select value={seasonId} onChange={(event) => setSeasonId(event.target.value)}>
            <option value="">Все незакрытые сезоны</option>
            {seasons.data?.items.filter((season) => season.state !== "closed").map((season) =>
              <option key={season.season_id} value={season.season_id}>{season.title}{season.is_current ? " · текущий" : ""}</option>,
            )}
          </select>
        </label>
      </div>
      <QueryState loading={query.isLoading || seasons.isLoading} error={query.error ?? seasons.error} retry={() => { void query.refetch(); void seasons.refetch(); }}>
        {query.data && <div className={p.columns}>
          <PersonalTeams key={`blocks-${search}`} title="Мои блоки" teams={blocks.map((block) => ({ id: block.block_id, title: block.name, to: getBlockRoute(block.block_id), roles: block.roles }))}
            empty={needle ? "Блоков по этому запросу нет." : "Вы пока не участвуете в блоках. Посмотрите раздел «Блоки», чтобы выбрать команду."} />
          <PersonalTeams key={`events-${search}-${seasonId}`} title="Мои мероприятия" teams={events.map((event) => ({ id: event.event_id, title: event.title, to: getEventRoute(event.event_id), roles: event.roles, detail: seasonTitle(event.season_id) }))}
            empty={needle ? "Мероприятий по этому запросу нет." : "В выбранных сезонах вы пока не участвуете в мероприятиях."} />
        </div>}
      </QueryState>
    </Page>
  );
}
/** What an entry is, by the colour of its section. */
const KINDS: Record<CalendarItem["kind"], { label: string; tone: Tone }> = {
  task_deadline: { label: "Дедлайн", tone: "lilac" },
  event: { label: "Мероприятие", tone: "mint" },
  meeting: { label: "Созвон", tone: "yellow" },
};
function CalendarEntry({ item, title, inDay = false }: { item: CalendarItem; title: string; inDay?: boolean }) {
  const route = item.kind === "meeting" && (item.target.kind === "event" || item.target.kind === "subevent")
    ? getMeetingRoute(item.target.kind, item.target.id)
    : targetRoute(item.target);
  const kind = KINDS[item.kind];
  return (
    <div className={c.entry} style={toneStyle(kind?.tone)}>
      {/* In a day of the month the day is already said: the time is enough. */}
      <small>{inDay ? displayTime(item.starts_at) : displayDate(item.starts_at)} · {kind?.label}</small>
      {route ? (
        <Link to={route}>{item.title}</Link>
      ) : (
        <span>{item.title}</span>
      )}
      <Badge>{title}</Badge>
    </div>
  );
}
export function CalendarPage() {
  const [month, setMonth] = useState(
    moscowDay(new Date().toISOString()).slice(0, 7),
  );
  const [seasonId, setSeasonId] = useState("");
  const seasons = useSeasons();
  const range = monthDays(month);
  const query = useQuery({
    queryKey: ["calendar", month],
    queryFn: () => workspaceApi.calendar(range.from, range.to),
  });
  const items =
    query.data?.items
      .filter(
        (i) =>
          (!seasonId || i.season_id === seasonId) &&
          seasons.data?.items.some(
            (s) => s.season_id === i.season_id && s.state !== "closed",
          ),
      )
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)) ?? [];
  const label = (id: string) =>
    seasons.data?.items.find((s) => s.season_id === id)?.title ?? "Сезон";
  return (
    <Page
      title="Календарь"
      description="Дедлайны, мероприятия и доступные созвоны. Время указано по МСК."
    >
      <div className={s.filters}>
        <div className={c.monthNav} role="group" aria-label="Выбор месяца">
          <button className={s.button} aria-label="Предыдущий месяц" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
          <strong className={c.monthTitle} aria-live="polite">{monthTitle(month)}</strong>
          <button className={s.button} aria-label="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
          <button className={s.button} onClick={() => setMonth(moscowDay(new Date().toISOString()).slice(0, 7))}>Сегодня</button>
        </div>
        <label className={s.field}>
          Сезон
          <select
            value={seasonId}
            onChange={(e) => setSeasonId(e.target.value)}
          >
            <option value="">Все незакрытые</option>
            {seasons.data?.items
              .filter((s) => s.state !== "closed")
              .map((s) => (
                <option key={s.season_id} value={s.season_id}>
                  {s.title}
                </option>
              ))}
          </select>
        </label>
      </div>
      <QueryState
        loading={query.isLoading || seasons.isLoading}
        error={query.error ?? seasons.error}
        retry={() => {
          void query.refetch();
        }}
      >
        <div className={c.calendar} role="table" aria-label="Календарь месяца">
          <div className={c.week} role="row">
            {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
              <strong role="columnheader" key={d}>
                {d}
              </strong>
            ))}
          </div>
          <div className={c.days}>
            {Array.from({ length: range.offset }, (_, i) => (
              <div key={`empty-${i}`} className={c.empty} />
            ))}
            {range.days.map((day) => (
              <div key={day} className={c.day} role="cell" aria-label={day}>
                <span className={c.dayNumber}>{Number(day.slice(-2))}</span>
                {items
                  .filter((i) => moscowDay(i.starts_at) === day)
                  .map((i) => (
                    <CalendarEntry
                      key={i.id}
                      item={i}
                      title={label(i.season_id)}
                      inDay
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
        <div className={c.mobileList}>
          {items.map((i) => (
            <CalendarEntry key={i.id} item={i} title={label(i.season_id)} />
          ))}
        </div>
        {!items.length && <Empty>На этот месяц нет доступных событий.</Empty>}
      </QueryState>
    </Page>
  );
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
