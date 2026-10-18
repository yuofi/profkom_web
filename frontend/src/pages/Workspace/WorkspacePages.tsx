import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
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
import { eventsApi } from "../../utils/api/events.api";
import {
  targetRoute,
  getTaskRoute,
  getEventRoute,
  getBlockRoute,
} from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { monthDays, moscowDay } from "../../utils/calendar";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import type { CalendarItem } from "../../utils/api/contract";
import s from "../../components/Workspace/Workspace.module.css";
import c from "./calendar.module.css";
function useSeasons() {
  return useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
}
export function DashboardPage() {
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: workspaceApi.dashboard,
  });
  const seasons = useSeasons();
  const [seasonId, setSeasonId] = useState("");
  const data = query.data;
  const meetings = data?.upcoming_meetings ?? [];
  const meetingSeasons = useQueries({
    queries: meetings.map((m) => ({
      queryKey: ["dashboard", "meeting-season", m.owner_kind, m.owner_id],
      queryFn: async () => {
        const eventId =
          m.owner_kind === "event"
            ? m.owner_id
            : (await eventsApi.subevent(m.owner_id)).event_id;
        return (await eventsApi.get(eventId)).season_id;
      },
      initialData:
        m.owner_kind === "event"
          ? data?.my_events.find((e) => e.event_id === m.owner_id)?.season_id
          : undefined,
      retry: false,
    })),
  });
  const inSeason = (id: string) =>
    (!seasonId || id === seasonId) &&
    !!seasons.data?.items.some(
      (s) => s.season_id === id && s.state !== "closed",
    );
  const tasks = data?.my_tasks.filter((t) => inSeason(t.season_id)) ?? [];
  const events = data?.my_events.filter((e) => inSeason(e.season_id)) ?? [];
  const unresolved =
    data?.unresolved_assignments.filter((a) => inSeason(a.season_id)) ?? [];
  const filteredMeetings = meetings
    .map((meeting, index) => ({ meeting, season: meetingSeasons[index] }))
    .filter(({ season }) => (season.data ? inSeason(season.data) : !seasonId));
  const unknownMeetings = meetingSeasons.filter((q) => !q.data).length;
  const seasonTitle = (id: string) =>
    seasons.data?.items.find((s) => s.season_id === id)?.title ?? "Сезон";
  return (
    <Page
      title="Рабочий экран"
      description="Ваша работа и ближайшие встречи во всех незакрытых сезонах."
      actions={
        <RouteLink to="/notifications">
          Уведомления{" "}
          {data?.unread_notification_count
            ? `· ${data.unread_notification_count}`
            : ""}
        </RouteLink>
      }
    >
      <label className={s.field}>
        Сезон
        <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)}>
          <option value="">Все незакрытые сезоны</option>
          {seasons.data?.items
            .filter((s) => s.state !== "closed")
            .map((s) => (
              <option key={s.season_id} value={s.season_id}>
                {s.title}
                {s.is_current ? " · текущий" : ""}
              </option>
            ))}
        </select>
      </label>
      <QueryState
        loading={query.isLoading || seasons.isLoading}
        error={query.error ?? seasons.error}
        retry={() => {
          void query.refetch();
          void seasons.refetch();
        }}
      >
        {data && (
          <div className={s.grid}>
            <Card title="Мои задачи">
              <ul className={s.list}>
                {tasks.map((t) => (
                  <li key={t.task_id}>
                    <Badge>{seasonTitle(t.season_id)}</Badge>
                    <p>
                      <RouteLink to={getTaskRoute(t.task_id)}>
                        {t.title}
                      </RouteLink>
                    </p>
                    <span className={s.muted}>
                      Дедлайн {displayDate(t.deadline_at)}
                    </span>
                  </li>
                ))}
              </ul>
              {!tasks.length && (
                <Empty>В выбранных сезонах назначенных задач нет.</Empty>
              )}
              <RouteLink to="/tasks">Открыть трекер</RouteLink>
            </Card>
            <Card title="Ближайшие созвоны">
              <ul className={s.list}>
                {filteredMeetings.map(({ meeting: m, season }) => (
                  <li key={m.meeting_id}>
                    <RouteLink
                      to={`/meetings/${m.owner_kind}/${encodeURIComponent(m.owner_id)}`}
                    >
                      {m.title}
                    </RouteLink>
                    <p>{displayDate(m.starts_at)}</p>
                    <Badge>
                      {season.data
                        ? seasonTitle(season.data)
                        : season.isError
                          ? "Сезон недоступен"
                          : "Сезон уточняется…"}
                    </Badge>
                  </li>
                ))}
              </ul>
              {!filteredMeetings.length && !unknownMeetings && (
                <Empty>В выбранных сезонах созвонов нет.</Empty>
              )}
              {unknownMeetings > 0 && (
                <p role="status">
                  Уточняем сезон для {unknownMeetings} созвонов.{" "}
                  {seasonId &&
                    "Они появятся после проверки принадлежности к сезону."}{" "}
                  <button
                    className={s.button}
                    onClick={() =>
                      meetingSeasons
                        .filter((q) => !q.data)
                        .forEach((q) => void q.refetch())
                    }
                  >
                    Обновить созвоны
                  </button>
                </p>
              )}
              <RouteLink to="/calendar">Календарь</RouteLink>
            </Card>
            <Card title="Мои команды">
              <ul className={s.list}>
                {data.my_blocks.map((b) => (
                  <li key={b.block_id}>
                    <RouteLink to={getBlockRoute(b.block_id)}>
                      {b.name}
                    </RouteLink>
                    <Badge>Между сезонами</Badge>
                  </li>
                ))}
                {events.map((e) => (
                  <li key={e.event_id}>
                    <RouteLink to={getEventRoute(e.event_id)}>
                      {e.title}
                    </RouteLink>{" "}
                    <Badge>{seasonTitle(e.season_id)}</Badge>
                  </li>
                ))}
              </ul>
              {!events.length && (
                <Empty>В выбранных сезонах мероприятий нет.</Empty>
              )}
            </Card>
            <Card title="Требуют решения">
              <p>
                Заявки в блоки (не зависят от сезона):{" "}
                {data.actionable_requests.length}
              </p>
              <RouteLink to="/blocks/requests">Рассмотреть заявки</RouteLink>
              {unresolved.length > 0 && (
                <>
                  <p>
                    Оставшаяся работа в выбранных сезонах: {unresolved.length}
                  </p>
                  <RouteLink
                    to={`/tasks/unresolved${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ""}`}
                  >
                    Разобрать назначения
                  </RouteLink>
                </>
              )}
              {!data.actionable_requests.length && !unresolved.length && (
                <Empty>В очереди нет решений.</Empty>
              )}
            </Card>
          </div>
        )}
      </QueryState>
    </Page>
  );
}
function CalendarEntry({ item, title }: { item: CalendarItem; title: string }) {
  const route = targetRoute(item.target);
  return (
    <div className={c.entry}>
      <small>{displayDate(item.starts_at)}</small>
      {route ? (
        <RouteLink to={route}>{item.title}</RouteLink>
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
      description="Дедлайны, мероприятия и доступные созвоны. Время московское (МСК)."
    >
      <div className={s.filters}>
        <label className={s.field}>
          Месяц
          <input
            type="month"
            value={month}
            onChange={(e) => {
              if (/^\d{4}-\d{2}$/.test(e.target.value))
                setMonth(e.target.value);
            }}
          />
        </label>
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
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
        <div className={c.mobileList}>
          {items.map((i) => (
            <Card key={i.id}>
              <CalendarEntry item={i} title={label(i.season_id)} />
            </Card>
          ))}
        </div>
        {!items.length && <Empty>На этот месяц нет доступных событий.</Empty>}
      </QueryState>
    </Page>
  );
}
export function NotificationsPage() {
  const { perform } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: workspaceApi.notifications,
  });
  return (
    <Page title="Уведомления">
      <div className={s.stack}>
        {query.data?.items.some((n) => !n.read_at) && (
          <ActionForm
            fields={[]}
            submitLabel="Прочитать все"
            onSubmit={async () => {
              await perform(workspaceApi.readAll);
            }}
          />
        )}
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
                <div className={s.between}>
                  <p>{n.text}</p>
                  {!n.read_at && <Badge>Новое</Badge>}
                </div>
                <p className={s.muted}>{displayDate(n.created_at)}</p>
                {route ? (
                  <RouteLink to={route}>Перейти к источнику</RouteLink>
                ) : (
                  <span className={s.muted}>Источник больше недоступен</span>
                )}
                {!n.read_at && (
                  <ActionForm
                    fields={[]}
                    submitLabel="Отметить прочитанным"
                    onSubmit={async () => {
                      await perform(() => workspaceApi.read(n.id));
                    }}
                  />
                )}
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
