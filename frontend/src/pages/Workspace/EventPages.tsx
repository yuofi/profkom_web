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
import { reportsApi } from "../../utils/api/reports.api";
import { richText, type Leader } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { getEventRoute, getEventCreateRoute, getEventEditRoute, getSubeventRoute } from "../../utils/routes";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import { displayDate } from "../../utils/dates";
import s from "../../components/Workspace/Workspace.module.css";
import e from "./EventEditor.module.css";
import { EventEditor } from "./EventEditor";
import { useSeriesField, chosenSeries } from "./useReportSeries";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { UserChip } from "../../components/Workspace/UserChip";
import { SeasonPlacementEditor } from "../../components/Workspace/SeasonPlacementEditor";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import { useState } from "react";

export function Leaders({ leaders }: { leaders: Leader[] }) {
  const people = usePeopleOptions();
  const { perform, refresh } = useWorkspaceActions();
  return (
    <div className={s.stack}>
      {leaders.length === 0 && (
        <p className={s.muted}>Руководители пока не назначены</p>
      )}
      {leaders.map((leader) => (
        <div key={leader.role_assignment_id} className={s.leader}>
          <UserChip user={leader.user} />
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
                  // The server checks the limit and names it: 422 deputy_limit (2.13).
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
/** The reports link shows to who may write a report or read one: the server lists only
 *  readable reports, so an activist outside the team sees no link to nothing. */
function useReportsLink(owner_kind: "event" | "subevent", owner_id: string, canCreate: boolean) {
  const readable = useQuery({
    queryKey: ["reports", "owner", owner_kind, owner_id],
    queryFn: () => reportsApi.list({ owner_kind, owner_id }),
    enabled: !!owner_id && !canCreate,
  });
  return canCreate || !!readable.data?.items.length;
}
export function EventsListPage() {
  const { session } = useSession();
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => eventsApi.list(),
  });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  return (
    <Page
      title="Мероприятия"
      description="Мероприятия, их команды и результаты работы."
      actions={can(session, "create_event") && <RouteLink to={getEventCreateRoute()}>Создать мероприятие</RouteLink>}
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
                <Markdown content={event.description} preview />
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

      </div>
    </Page>
  );
}
export function EventCreatePage() {
  const { session } = useSession();
  return can(session, "create_event") ? <EventEditor /> : <Empty>Создавать мероприятия могут председатель и его заместители.</Empty>;
}
export function EventEditPage() {
  const { id = "" } = useParams();
  const query = useQuery({ queryKey: ["events", id], queryFn: () => eventsApi.get(id), enabled: !!id });
  return <QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{query.data && (can(query.data, "edit_event") ? <EventEditor event={query.data} /> : <Empty>Изменение мероприятия вам недоступно.</Empty>)}</QueryState>;
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
  const [editor, setEditor] = useState<"leaders" | "season" | "clone" | null>(null);
  const reportsLink = useReportsLink("event", event ? id : "", can(event, "create_report"));
  const seriesField = useSeriesField(can(event, "create_subevent"), event, subs.data?.items.map((x) => x.report_series_id));
  return (
    <Page
      title={event?.title ?? "Мероприятие"}
      actions={<div className={s.row}>{can(event, "edit_event") && <RouteLink to={getEventEditRoute(id)}><Glyph name="edit" />Изменить мероприятие</RouteLink>}<RouteLink to="/events">Все мероприятия</RouteLink></div>}
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
              <div className={e.seasonLabel}><Badge>{seasons.data?.items.find(x => x.season_id === event.season_id)?.title ?? "Сезон"}</Badge>{can(session, "correct_season") && <button type="button" className={e.iconButton} aria-label="Изменить сезон мероприятия" title="Изменить сезон" onClick={() => setEditor("season")}><Glyph name="edit" /></button>}</div>
              {(event.starts_at || event.ends_at) && (
                <p>
                  {displayDate(event.starts_at)} — {displayDate(event.ends_at)}
                </p>
              )}
              {/* The ways further come before a long description, not after it. */}
              <div className={s.row}>
                {can(event, "create_head_merit") && <RouteLink to={`/seasons/${encodeURIComponent(event.season_id)}/merits?source_kind=head_merit&scope_id=${encodeURIComponent(id)}`}>Учесть особую заслугу</RouteLink>}
                {reportsLink && (
                  <RouteLink
                    to={`/reports?owner_kind=event&owner_id=${encodeURIComponent(id)}`}
                  >
                    Отчёты
                  </RouteLink>
                )}
                {can(event, "view_meeting") && (
                  <RouteLink to={`/meetings/event/${encodeURIComponent(id)}`}>
                    Созвон руководителей
                  </RouteLink>
                )}
              </div>
              <Markdown content={event.description} />
            </Card>
            <div className={s.grid}>
              <Card>
                <div className={e.sectionHeading}><h2>Главорги</h2>{can(event, "manage_leaders") && <button type="button" className={e.iconButton} aria-label="Изменить главоргов" title="Изменить главоргов" onClick={() => setEditor("leaders")}><Glyph name="edit" /></button>}</div>
                <Leaders leaders={event.leaders} />
                {editor === "leaders" && <UnsavedChangesScope><TrackerTaskDialog title="Главорги мероприятия" onClose={() => setEditor(null)}>
                    <ActionForm
                      key={event.event_id}
                      revision={event.revision}
                      record={`event:${event.event_id}`}
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
                        const saved = await perform(() => eventsApi.leaders("events", id, ids(v, "users"), { expected_revision: expectedRevision! }));
                        setEditor(null);return saved;
                      }}
                      onConflict={refresh}
                    />
                </TrackerTaskDialog></UnsavedChangesScope>}
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
                      resetOnSuccess
                    />
                  </details>
                )}
              </Card>
            </div>
            {editor === "season" && <UnsavedChangesScope><TrackerTaskDialog title="Сезон мероприятия" onClose={() => setEditor(null)}><SeasonPlacementEditor objectKind="event" objectId={event.event_id} currentSeasonId={event.season_id} revision={event.revision} onSaved={() => setEditor(null)} /></TrackerTaskDialog></UnsavedChangesScope>}
            {can(session, "create_event") && <button type="button" className={s.button} onClick={() => setEditor("clone")}>Создать новый ежегодный экземпляр</button>}
            {can(session, "create_event") && editor === "clone" && <UnsavedChangesScope><TrackerTaskDialog title="Новый ежегодный экземпляр" onClose={() => setEditor(null)}>
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
              </TrackerTaskDialog></UnsavedChangesScope>}
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
  const reportsLink = useReportsLink("subevent", sub ? id : "", can(sub, "create_report"));
  return (
    <Page
      title={sub?.title ?? "Подмероприятие"}
      actions={sub && <RouteLink to={getEventRoute(sub.event_id)}>Главное мероприятие</RouteLink>}
    >
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
              <div className={s.row}>
                {can(sub, "create_volunteer_merit") && <RouteLink to={`/merits?source_kind=subevent_volunteer&scope_id=${encodeURIComponent(id)}`}>Учесть волонтёрскую работу</RouteLink>}
                <RouteLink
                  to={`/tasks?scope_kind=subevent&scope_id=${encodeURIComponent(id)}`}
                >
                  Задачи команды
                </RouteLink>
                {reportsLink && (
                  <RouteLink
                    to={`/reports?owner_kind=subevent&owner_id=${encodeURIComponent(id)}`}
                  >
                    Отчёты
                  </RouteLink>
                )}
                {can(sub, "view_meeting") && (
                  <RouteLink to={`/meetings/subevent/${encodeURIComponent(id)}`}>
                    Созвон
                  </RouteLink>
                )}
              </div>
              <Markdown content={sub.description} />
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
                      record={`subevent:${sub.subevent_id}`}
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
                      record={`subevent:${sub.subevent_id}`}
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
                  record={`subevent:${sub.subevent_id}`}
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
