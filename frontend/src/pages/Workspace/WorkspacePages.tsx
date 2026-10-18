import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
        loading={query.isLoading}
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      >
        {data && (
          <div className={s.grid}>
            <Card title="Мои задачи">
              <ul className={s.list}>
                {data.my_tasks
                  .filter((t) => !seasonId || t.season_id === seasonId)
                  .map((t) => (
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
              {!data.my_tasks.length && (
                <Empty>Назначенных задач пока нет.</Empty>
              )}
              <RouteLink to="/tasks">Открыть трекер</RouteLink>
            </Card>
            <Card title="Ближайшие созвоны">
              <ul className={s.list}>
                {data.upcoming_meetings.map((m) => (
                  <li key={m.meeting_id}>
                    <RouteLink
                      to={`/meetings/${m.owner_kind}/${encodeURIComponent(m.owner_id)}`}
                    >
                      {m.title}
                    </RouteLink>
                    <p>{displayDate(m.starts_at)}</p>
                  </li>
                ))}
              </ul>
              {!data.upcoming_meetings.length && (
                <Empty>Созвоны пока не назначены.</Empty>
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
                  </li>
                ))}
                {data.my_events
                  .filter((e) => !seasonId || e.season_id === seasonId)
                  .map((e) => (
                    <li key={e.event_id}>
                      <RouteLink to={getEventRoute(e.event_id)}>
                        {e.title}
                      </RouteLink>{" "}
                      <Badge>{seasonTitle(e.season_id)}</Badge>
                    </li>
                  ))}
              </ul>
            </Card>
            <Card title="Требуют решения">
              <p>Заявки в блоки: {data.actionable_requests.length}</p>
              <RouteLink to="/blocks/requests">Рассмотреть заявки</RouteLink>
              {data.unresolved_assignments.length > 0 && (
                <>
                  <p>Оставшаяся работа: {data.unresolved_assignments.length}</p>
                  <RouteLink to="/tasks/unresolved">
                    Разобрать назначения
                  </RouteLink>
                </>
              )}
              {!data.actionable_requests.length &&
                !data.unresolved_assignments.length && (
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
