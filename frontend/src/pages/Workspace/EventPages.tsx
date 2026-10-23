import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  Markdown,
  RouteLink,
  Badge,
  Empty,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text, ids } from "../../components/Workspace/formValues";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { richText, type Event, type Leader } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { getEventRoute, getSubeventRoute } from "../../utils/routes";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import { displayDate, moscowInput, toUtc } from "../../utils/dates";
import s from "../../components/Workspace/Workspace.module.css";

export function Leaders({ leaders }: { leaders: Leader[] }) {
  const people = usePeopleOptions();
  const { perform, refresh } = useWorkspaceActions();
  return (
    <div className={s.stack}>
      {leaders.length === 0 && (
        <p className={s.muted}>Руководители пока не назначены</p>
      )}
      {leaders.map((leader) => (
        <div key={leader.role_assignment_id}>
          <h3>{leader.user.display_name}</h3>
          <p className={s.muted}>
            Заместители:{" "}
            {leader.deputy_user_ids
              .map(
                (id) =>
                  people.options.find((p) => p.value === String(id))?.label ??
                  "Участник",
              )
              .join(", ") || "не назначены"}
          </p>
          {can(leader, "manage_deputies") && (
            <details className={s.details}>
              <summary>Изменить заместителей</summary>
              <ActionForm
                key={leader.role_assignment_id}
                revision={leader.revision}
                fields={[
                  {
                    name: "users",
                    label: "До двух заместителей",
                    type: "multi",
                    value: leader.deputy_user_ids.map(String),
                    options: people.options.filter(
                      (p) => p.value !== String(leader.user.user_id),
                    ),
                  },
                ]}
                onSubmit={async (v, expectedRevision) => {
                  const users = ids(v, "users");
                  if (users.length > 2)
                    throw Error(
                      "У руководителя может быть не более двух заместителей",
                    );
                  return perform(() =>
                    eventsApi.deputies(leader.role_assignment_id, users, {
                      expected_revision: expectedRevision!,
                    }),
                  );
                }}
                onConflict={refresh}
              />
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
const NEW_SERIES = "new";
/**
 * The report series a new instance may continue (FIX_PLAN 2.21): event series for a new
 * event, the parent's child series not yet used by its subevents for a new subevent.
 * Each option names the latest instance and its season to tell similar series apart.
 */
function useSeriesField(enabled: boolean, parent?: Event, used: string[] = []) {
  const series = useQuery({ queryKey: ["reports", "series"], queryFn: eventsApi.series, enabled });
  const events = useQuery({ queryKey: ["events"], queryFn: () => eventsApi.list(), enabled });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled });
  const earlier = useQuery({
    queryKey: ["events", "series-instances", parent?.event_id],
    enabled: enabled && !!parent && !!events.data,
    queryFn: async () => (await Promise.all(events.data!.items
      .filter((e) => e.report_series_id === parent!.report_series_id && e.event_id !== parent!.event_id)
      .map(async (e) => (await eventsApi.subevents(e.event_id)).items.map((sub) => ({ ...sub, season_id: e.season_id }))))).flat(),
  });
  const order = (seasonId: string) => seasons.data?.items.find((x) => x.season_id === seasonId)?.sequence_number ?? 0;
  const instances = parent ? earlier.data ?? [] : events.data?.items ?? [];
  const options = (series.data?.items ?? [])
    .filter((x) => (parent
      ? x.owner_kind === "subevent" && x.parent_series_id === parent.report_series_id
      : x.owner_kind === "event") && !used.includes(x.series_id))
    .map((x) => {
      const latest = instances.filter((i) => i.report_series_id === x.series_id)
        .sort((a, b) => order(b.season_id) - order(a.season_id))[0];
      const season = latest && seasons.data?.items.find((y) => y.season_id === latest.season_id)?.title;
      return { value: x.series_id, label: latest ? `${x.title} — ${latest.title}, ${season ?? "сезон недоступен"}` : x.title };
    });
  return {
    name: "series",
    label: "Серия отчётов",
    type: "select" as const,
    required: true,
    value: NEW_SERIES,
    hint: "Продолжение серии открывает её прошлые отчёты в истории.",
    options: [{ value: NEW_SERIES, label: "Новая серия" }, ...options],
  };
}
const chosenSeries = (value: string) => (value && value !== NEW_SERIES ? { report_series_id: value } : {});
export function EventsListPage() {
  const { session } = useSession();
  const navigate = useNavigate();
  const { perform } = useWorkspaceActions();
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => eventsApi.list(),
  });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const seriesField = useSeriesField(can(session, "create_event"));
  return (
    <Page
      title="Мероприятия"
      description="Все мероприятия профкома по сезонам. Задачи и созвоны — у команды подмероприятия."
    >
      <div className={s.stack}>
        <QueryState
          loading={events.isLoading}
          error={events.error}
          retry={() => {
            void events.refetch();
          }}
        >
          <div className={s.grid}>
            {events.data?.items.map((event) => (
              <Card key={event.event_id} title={event.title}>
                <Badge>
                  {seasons.data?.items.find(
                    (season) => season.season_id === event.season_id,
                  )?.title ?? "Сезон"}
                </Badge>
                <Markdown content={event.description} />
                <RouteLink to={getEventRoute(event.event_id)}>
                  Открыть мероприятие
                </RouteLink>
              </Card>
            ))}
          </div>
          {events.data?.items.length === 0 && (
            <Empty>Мероприятий пока нет.</Empty>
          )}
        </QueryState>
        {can(session, "create_event") && (
          <Card title="Новое мероприятие">
            <ActionForm
              fields={[
                { name: "title", label: "Название", required: true },
                { name: "description", label: "Описание", type: "textarea" },
                {
                  name: "starts",
                  label: "Начало, МСК — необязательно",
                  type: "datetime-local",
                },
                {
                  name: "ends",
                  label: "Окончание, МСК — необязательно",
                  type: "datetime-local",
                },
                {
                  name: "season",
                  label: "Сезон",
                  type: "select",
                  required: true,
                  options: seasons.data?.items
                    .filter((season) =>
                      ["planned", "open"].includes(season.state),
                    )
                    .map((season) => ({
                      value: season.season_id,
                      label: season.title,
                    })),
                },
                seriesField,
              ]}
              onSubmit={async (v) => {
                if (
                  text(v, "starts") &&
                  text(v, "ends") &&
                  text(v, "starts") > text(v, "ends")
                )
                  throw Error("Окончание раньше начала");
                let target = "";
                await perform(async () => {
                  const created = await eventsApi.create({
                    title: text(v, "title"),
                    description: richText(text(v, "description")),
                    season_id: text(v, "season"),
                    ...(text(v, "starts")
                      ? { starts_at: toUtc(text(v, "starts")) }
                      : {}),
                    ...(text(v, "ends")
                      ? { ends_at: toUtc(text(v, "ends")) }
                      : {}),
                    ...chosenSeries(text(v, "series")),
                  });
                  target = created.event_id;
                });
                navigate(getEventRoute(target));
              }}
              submitLabel="Создать мероприятие"
            />
          </Card>
        )}
      </div>
    </Page>
  );
}
export function EventPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const navigate = useNavigate();
  const { perform, refresh } = useWorkspaceActions();
  const people = usePeopleOptions();
  const query = useQuery({
    queryKey: ["events", id],
    queryFn: () => eventsApi.get(id),
  });
  const subs = useQuery({
    queryKey: ["events", id, "subevents"],
    queryFn: () => eventsApi.subevents(id),
    enabled: !!query.data,
  });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const event = query.data;
  const seriesField = useSeriesField(can(event, "create_subevent"), event, subs.data?.items.map((x) => x.report_series_id));
  return (
    <Page
      title={event?.title ?? "Мероприятие"}
      actions={<RouteLink to="/events">Все мероприятия</RouteLink>}
    >
      <QueryState
        keepDataOnError={!!query.data}
        loading={query.isLoading}
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      >
        {event && (
          <div className={s.stack}>
            <Card>
              <Badge>
                {seasons.data?.items.find(
                  (x) => x.season_id === event.season_id,
                )?.title ?? "Сезон"}
              </Badge>
              <Markdown content={event.description} />
              {(event.starts_at || event.ends_at) && (
                <p>
                  {displayDate(event.starts_at)} — {displayDate(event.ends_at)}
                </p>
              )}
              <div className={s.row}>
                {can(event, "create_head_merit") && <RouteLink to={`/seasons/${encodeURIComponent(event.season_id)}/merits?source_kind=head_merit&scope_id=${encodeURIComponent(id)}`}>Учесть особую заслугу</RouteLink>}
                <RouteLink
                  to={`/reports?owner_kind=event&owner_id=${encodeURIComponent(id)}`}
                >
                  Отчёты
                </RouteLink>
                {can(event, "view_meeting") && (
                  <RouteLink to={`/meetings/event/${encodeURIComponent(id)}`}>
                    Созвон руководителей
                  </RouteLink>
                )}
              </div>
            </Card>
            <div className={s.grid}>
              <Card title="Главорги">
                <Leaders leaders={event.leaders} />
                {can(event, "manage_leaders") && (
                  <details className={s.details}>
                    <summary>Изменить главоргов</summary>
                    <ActionForm
                      key={event.event_id}
                      revision={event.revision}
                      fields={[
                        {
                          name: "users",
                          label: "Равноправные руководители",
                          type: "multi",
                          value: event.leaders.map((l) =>
                            String(l.user.user_id),
                          ),
                          options: people.options,
                        },
                      ]}
                      onSubmit={async (v, expectedRevision) => {
                        return perform(() =>
                          eventsApi.leaders("events", id, ids(v, "users"), {
                            expected_revision: expectedRevision!,
                          }),
                        );
                      }}
                      onConflict={refresh}
                    />
                  </details>
                )}
              </Card>
              <Card title="Подмероприятия">
                <QueryState loading={subs.isLoading} error={subs.error}>
                  <ul className={s.list}>
                    {subs.data?.items.map((sub) => (
                      <li key={sub.subevent_id}>
                        <RouteLink to={getSubeventRoute(sub.subevent_id)}>
                          {sub.title}
                        </RouteLink>
                      </li>
                    ))}
                  </ul>
                </QueryState>
                {can(event, "create_subevent") && (
                  <details className={s.details}>
                    <summary>Добавить подмероприятие</summary>
                    <ActionForm
                      fields={[
                        { name: "title", label: "Название", required: true },
                        {
                          name: "description",
                          label: "Описание",
                          type: "textarea",
                        },
                        seriesField,
                      ]}
                      onSubmit={async (v) => {
                        await perform(() =>
                          eventsApi.createSubevent(id, {
                            title: text(v, "title"),
                            description: richText(text(v, "description")),
                            ...chosenSeries(text(v, "series")),
                          }),
                        );
                      }}
                    />
                  </details>
                )}
              </Card>
            </div>
            {can(event, "edit_event") && (
              <Card title="Описание мероприятия">
                <ActionForm
                  key={event.event_id}
                  revision={event.revision}
                  fields={[
                    {
                      name: "title",
                      label: "Название",
                      required: true,
                      value: event.title,
                    },
                    {
                      name: "description",
                      label: "Описание",
                      type: "textarea",
                      value: event.description.body,
                    },
                    {
                      name: "starts",
                      label: "Начало, МСК",
                      type: "datetime-local",
                      value: event.starts_at
                        ? moscowInput(event.starts_at)
                        : "",
                    },
                    {
                      name: "ends",
                      label: "Окончание, МСК",
                      type: "datetime-local",
                      value: event.ends_at ? moscowInput(event.ends_at) : "",
                    },
                  ]}
                  onSubmit={async (v, expectedRevision) => {
                    return perform(() =>
                      eventsApi.update(id, {
                        title: text(v, "title"),
                        description: richText(text(v, "description")),
                        expected_revision: expectedRevision!,
                        starts_at: text(v, "starts")
                          ? toUtc(text(v, "starts"))
                          : null,
                        ends_at: text(v, "ends")
                          ? toUtc(text(v, "ends"))
                          : null,
                      }),
                    );
                  }}
                  onConflict={refresh}
                />
              </Card>
            )}
            {can(session, "create_event") && (
              <Card title="Создать новый ежегодный экземпляр">
                <p>
                  Будут скопированы названия и описания подмероприятий.
                  Руководителей и организаторов нужно назначить заново; задачи и
                  начисления не копируются.
                </p>
                <ActionForm
                  fields={[
                    {
                      name: "title",
                      label: "Название нового экземпляра",
                      value: event.title,
                      required: true,
                    },
                    {
                      name: "season",
                      label: "Сезон",
                      type: "select",
                      required: true,
                      options: seasons.data?.items
                        .filter((x) => ["planned", "open"].includes(x.state))
                        .map((x) => ({ value: x.season_id, label: x.title })),
                    },
                  ]}
                  onSubmit={async (v) => {
                    const result = await eventsApi.copy(id, {
                      title: text(v, "title"),
                      season_id: text(v, "season"),
                    });
                    await refresh();
                    navigate(getEventRoute(result.event.event_id));
                  }}
                  submitLabel="Создать из структуры"
                />
              </Card>
            )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
export function SubeventPage() {
  const { id = "" } = useParams();
  const { perform, refresh } = useWorkspaceActions();
  const people = usePeopleOptions();
  const query = useQuery({
    queryKey: ["events", "subevent", id],
    queryFn: () => eventsApi.subevent(id),
  });
  const sub = query.data;
  return (
    <Page title={sub?.title ?? "Подмероприятие"}>
      <QueryState
        keepDataOnError={!!query.data}
        loading={query.isLoading}
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      >
        {sub && (
          <div className={s.stack}>
            <Card>
              <Markdown content={sub.description} />
              <div className={s.row}>
                <RouteLink to={getEventRoute(sub.event_id)}>
                  Главное мероприятие
                </RouteLink>
                {can(sub, "create_volunteer_merit") && <RouteLink to={`/merits?source_kind=subevent_volunteer&scope_id=${encodeURIComponent(id)}`}>Учесть волонтёрскую работу</RouteLink>}
                <RouteLink
                  to={`/tasks?scope_kind=subevent&scope_id=${encodeURIComponent(id)}`}
                >
                  Задачи команды
                </RouteLink>
                <RouteLink
                  to={`/reports?owner_kind=subevent&owner_id=${encodeURIComponent(id)}`}
                >
                  Отчёты
                </RouteLink>
                {can(sub, "view_meeting") && (
                  <RouteLink to={`/meetings/subevent/${encodeURIComponent(id)}`}>
                    Созвон
                  </RouteLink>
                )}
              </div>
            </Card>
            <div className={s.grid}>
              <Card title="Ответственные">
                <Leaders leaders={sub.leaders} />
                {can(sub, "manage_leaders") && (
                  <details className={s.details}>
                    <summary>Изменить ответственных</summary>
                    <ActionForm
                      key={sub.subevent_id}
                      revision={sub.revision}
                      fields={[
                        {
                          name: "users",
                          label: "Равноправные ответственные",
                          type: "multi",
                          value: sub.leaders.map((l) => String(l.user.user_id)),
                          options: people.options,
                        },
                      ]}
                      onSubmit={async (v, expectedRevision) => {
                        return perform(() =>
                          eventsApi.leaders("subevents", id, ids(v, "users"), {
                            expected_revision: expectedRevision!,
                          }),
                        );
                      }}
                      onConflict={refresh}
                    />
                  </details>
                )}
              </Card>
              <Card title="Организаторы">
                <ul className={s.list}>
                  {sub.organizer_user_ids.map((userId) => (
                    <li key={userId}>
                      {people.options.find((p) => p.value === String(userId))
                        ?.label ?? "Участник"}
                    </li>
                  ))}
                </ul>
                {can(sub, "manage_organizers") && (
                  <details className={s.details}>
                    <summary>Изменить состав</summary>
                    <ActionForm
                      key={sub.subevent_id}
                      revision={sub.revision}
                      fields={[
                        {
                          name: "users",
                          label: "Организаторы",
                          type: "multi",
                          value: sub.organizer_user_ids.map(String),
                          options: people.options,
                        },
                      ]}
                      onSubmit={async (v, expectedRevision) => {
                        return perform(() =>
                          eventsApi.organizers(id, ids(v, "users"), {
                            expected_revision: expectedRevision!,
                          }),
                        );
                      }}
                      onConflict={refresh}
                    />
                  </details>
                )}
              </Card>
            </div>
            {can(sub, "edit_subevent") && (
              <Card title="Описание">
                <ActionForm
                  key={sub.subevent_id}
                  revision={sub.revision}
                  fields={[
                    {
                      name: "title",
                      label: "Название",
                      required: true,
                      value: sub.title,
                    },
                    {
                      name: "description",
                      label: "Описание",
                      type: "textarea",
                      value: sub.description.body,
                    },
                  ]}
                  onSubmit={async (v, expectedRevision) => {
                    return perform(() =>
                      eventsApi.updateSubevent(id, {
                        expected_revision: expectedRevision!,
                        title: text(v, "title"),
                        description: richText(text(v, "description")),
                      }),
                    );
                  }}
                  onConflict={refresh}
                />
              </Card>
            )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
