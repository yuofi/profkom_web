import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Page, Card, QueryState, Markdown, RouteLink, Badge, Empty, Glyph, Loading } from "../../components/Workspace/WorkspaceUI";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text, ids } from "../../components/Workspace/formValues";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { reportsApi } from "../../utils/api/reports.api";
import { workspaceApi } from "../../utils/api/workspace.api";
import type { Event, Subevent } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { getEventRoute, getEventCreateRoute, getEventEditRoute, getSubeventRoute } from "../../utils/routes";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import s from "../../components/Workspace/Workspace.module.css";
import e from "./EventEditor.module.css";
import { Leaders } from "./EventLeaders";

const EventEditor = lazy(() => import("./EventEditor").then(module => ({ default: module.EventEditor })));
const SubeventEditor = lazy(() => import("./EventEditor").then(module => ({ default: module.SubeventEditor })));
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { UserChip } from "../../components/Workspace/UserChip";
import { SeasonPlacementEditor } from "../../components/Workspace/SeasonPlacementEditor";
import { eventPeriod, eventPhase } from "./eventDates";
import { HistoryDisclosure } from "../../components/Workspace/HistoryPanel";

function useReportsLink(owner_kind: "event" | "subevent", owner_id: string, canCreate: boolean, enabled = true) {
  const readable = useQuery({ queryKey: ["reports", "owner", owner_kind, owner_id], queryFn: () => reportsApi.list({ owner_kind, owner_id }), enabled: enabled && !!owner_id && !canCreate });
  return enabled && (canCreate || !readable.error && !!readable.data?.items.length);
}
function EventListWidget({ title, events, empty }: { title: string; events: Event[]; empty: string }) {
  const phaseNames = { current: "Сейчас идёт", upcoming: "Впереди", past: "Завершено", undated: "Даты уточняются" };
  return <Card title={title}><div className={e.widgetMeta}>{events.length ? `Мероприятий: ${events.length}` : ""}</div><ul className={e.eventRows} aria-label={title}>
    {events.map(event => <li key={event.event_id}><Link to={getEventRoute(event.event_id)} className={e.eventRow}>
      <span className={e.eventName}>{event.title}{eventPhase(event) !== "undated" && <small>{phaseNames[eventPhase(event)]}</small>}</span><span className={e.eventDate}>{eventPeriod(event)}</span><span aria-hidden="true">›</span>
    </Link></li>)}
  </ul>{!events.length && <p className={e.listEmpty}>{empty}</p>}</Card>;
}
export function EventsListPage() {
  const { session } = useSession(), [params, setParams] = useSearchParams();
  const events = useQuery({ queryKey: ["events"], queryFn: () => eventsApi.list() });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const participation = useQuery({ queryKey: ["participation"], queryFn: workspaceApi.participation });
  const mine = params.get("mine") === "true", archive = params.get("archive") === "true", search = params.get("q") ?? "";
  const update = (key: string, value: string) => { const next = new URLSearchParams(params);if (value) next.set(key, value);else next.delete(key);setParams(next); };
  const own = new Set(participation.data?.events.map(event => event.event_id));
  const visible = events.data?.items.filter(event => (!mine || own.has(event.event_id)) && event.title.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru")) && (seasons.data?.items.find(season => season.season_id === event.season_id)?.state === "closed") === archive) ?? [];
  const sorted = [...visible].sort((left, right) => (left.starts_at ?? "9999").localeCompare(right.starts_at ?? "9999") || left.title.localeCompare(right.title, "ru"));
  const current = sorted.filter(event => eventPhase(event) === "current"), upcoming = sorted.filter(event => eventPhase(event) === "upcoming").slice(0, 6);
  return <Page title="Мероприятия" description="Что происходит сейчас и к чему готовится Профком." actions={can(session, "create_event") && <RouteLink to={getEventCreateRoute()}>Создать мероприятие</RouteLink>}>
    <div className={s.filters}><label className={s.field}>Поиск мероприятий<input value={search} onChange={event => update("q", event.target.value)} /></label><label className={s.field}>Участие<select value={mine ? "mine" : "all"} onChange={event => update("mine", event.target.value === "mine" ? "true" : "")}><option value="all">Все мероприятия</option><option value="mine">С моим участием</option></select></label><label className={s.field}>Период<select value={archive ? "archive" : "current"} onChange={event => update("archive", event.target.value === "archive" ? "true" : "")}><option value="current">Текущие сезоны</option><option value="archive">Архив</option></select></label></div>
    <QueryState loading={events.isLoading || seasons.isLoading || mine && participation.isLoading} error={events.error ?? seasons.error ?? (mine ? participation.error : null)} retry={() => { void events.refetch();void seasons.refetch();void participation.refetch(); }}>
      {!archive && <div className={e.eventOverview}><EventListWidget title="Сейчас идут" events={current} empty="Сейчас нет мероприятий с указанными датами." /><EventListWidget title="Ближайшие" events={upcoming} empty="Ближайших мероприятий с известными датами пока нет." /></div>}
      <section className={e.catalog}><EventListWidget title={archive ? "Архив мероприятий" : "Все мероприятия"} events={sorted} empty="Мероприятия по выбранным условиям не найдены." /></section>
    </QueryState>
  </Page>;
}
export function EventCreatePage() { const { session } = useSession();return can(session, "create_event") ? <Suspense fallback={<Loading />}><EventEditor /></Suspense> : <Empty>Создавать мероприятия могут председатель и его заместители.</Empty>; }
export function EventEditPage() {
  const { id = "" } = useParams();const query = useQuery({ queryKey: ["events", id], queryFn: () => eventsApi.get(id), enabled: !!id });
  return <QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{query.data && (can(query.data, "edit_event") ? <Suspense fallback={<Loading />}><EventEditor event={query.data} /></Suspense> : <Empty>Изменение мероприятия вам недоступно.</Empty>)}</QueryState>;
}
function LeadersEditor({ owner, kind, onSaved }: { owner: Event | Subevent; kind: "events" | "subevents"; onSaved: () => void }) {
  const people = usePeopleOptions({ includeNonMembers: true }), { perform, refresh } = useWorkspaceActions();
  const id = "event_id" in owner && !("subevent_id" in owner) ? owner.event_id : (owner as Subevent).subevent_id;
  return <ActionForm revision={owner.revision} record={`${kind === "events" ? "event" : "subevent"}:${id}`} fields={[{ name: "users", label: kind === "events" ? "Равноправные руководители" : "Равноправные ответственные", type: "multi", value: owner.leaders.map(leader => String(leader.user.user_id)), options: people.options }]} onConflict={refresh} onSubmit={async (values, revision) => { const saved = await perform(() => eventsApi.leaders(kind, id, ids(values, "users"), { expected_revision: revision! }));onSaved();return saved; }} />;
}
function SubeventList({ items, label, announcement = false }: { items: Subevent[]; label: string; announcement?: boolean }) {
  return <ul className={e.children} aria-label={label}>{items.map(sub => <li key={sub.subevent_id} className={e.childCard}>
    <div className={e.childMeta}><span className={e.childLabel}>Подмероприятие</span><small>{eventPeriod(sub)}</small></div>
    <h3><Link to={getSubeventRoute(sub.subevent_id)}>{sub.title}</Link></h3>
    {announcement && sub.announcement?.body && <Markdown content={sub.announcement} preview />}
  </li>)}</ul>;
}
export function EventPage() {
  const { id = "" } = useParams(), { session } = useSession();
  const query = useQuery({ queryKey: ["events", id], queryFn: () => eventsApi.get(id) });
  const subs = useQuery({ queryKey: ["events", id, "subevents"], queryFn: () => eventsApi.subevents(id), enabled: !!query.data });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const [editor, setEditor] = useState<"leaders" | "season" | "child" | null>(null);
  const event = query.data, reportsLink = useReportsLink("event", event ? id : "", can(event, "create_report"));
  const childRows = subs.data?.items ?? [], nearest = childRows.filter(item => ["current", "upcoming"].includes(eventPhase(item))).sort((left, right) => (left.starts_at ?? "").localeCompare(right.starts_at ?? "")).slice(0, 5);
  if (editor === "child" && event && can(event, "create_subevent")) return <UnsavedChangesScope><Suspense fallback={<Loading />}><SubeventEditor parent={event} onClose={() => setEditor(null)} /></Suspense></UnsavedChangesScope>;
  return <section className={s.page}><QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{event && <>
    <BrandedHeader className={e.eventHeader}><div><SectionHomeLink to="/events" label="Мероприятия" /><h1 className={s.title}>{event.title}</h1><p className={e.period}>{eventPeriod(event)}</p><div className={e.headerLeaders}><div className={e.sectionHeading}><h2>Главорги</h2>{can(event, "manage_leaders") && <button type="button" className={e.iconButton} aria-label="Изменить главоргов" onClick={() => setEditor("leaders")}><Glyph name="edit" /></button>}</div><Leaders leaders={event.leaders} /></div></div><div className={`${s.row} ${e.headerActions}`} role="group" aria-label="Действия мероприятия">{can(event, "edit_event") && <RouteLink to={getEventEditRoute(id)}><Glyph name="edit" />Изменить мероприятие</RouteLink>}<RouteLink to="/events">Все мероприятия</RouteLink></div></BrandedHeader>
    <Card><div className={e.seasonLabel}><Badge>{seasons.data?.items.find(season => season.season_id === event.season_id)?.title ?? "Сезон"}</Badge>{can(session, "correct_season") && <button type="button" className={e.iconButton} aria-label="Изменить сезон мероприятия" onClick={() => setEditor("season")}><Glyph name="edit" /></button>}</div><Markdown content={event.description} /><div className={s.row}>{can(event, "create_head_merit") && <RouteLink to={`/merits?source_kind=head_merit&scope_id=${encodeURIComponent(id)}`}>Учесть особую заслугу</RouteLink>}{reportsLink && <RouteLink to={`/reports?owner_kind=event&owner_id=${encodeURIComponent(id)}`}>Отчёты</RouteLink>}{can(event, "view_meeting") && <RouteLink to={`/meetings/event/${encodeURIComponent(id)}`}>Созвон руководителей</RouteLink>}</div></Card>
    <QueryState loading={subs.isLoading} error={subs.error} retry={() => void subs.refetch()}>{nearest.length > 0 && <Card title="Ближайшие подмероприятия"><SubeventList items={nearest} label="Ближайшие подмероприятия" /></Card>}
      <Card title="Подмероприятия"><div className={e.sectionHeading}><span>Анонсы и команда доступны всем активистам.</span>{can(event, "create_subevent") && <button type="button" className={s.button} onClick={() => setEditor("child")}>Добавить подмероприятие</button>}</div><SubeventList items={childRows} label="Все подмероприятия" announcement />{!childRows.length && <Empty>Подмероприятий пока нет.</Empty>}</Card>
    </QueryState>
    <HistoryDisclosure kind="event" id={id} />
    {editor === "leaders" && <UnsavedChangesScope><TrackerTaskDialog title="Главорги мероприятия" onClose={() => setEditor(null)}><LeadersEditor owner={event} kind="events" onSaved={() => setEditor(null)} /></TrackerTaskDialog></UnsavedChangesScope>}
    {editor === "season" && <UnsavedChangesScope><TrackerTaskDialog title="Сезон мероприятия" onClose={() => setEditor(null)}><SeasonPlacementEditor objectKind="event" objectId={event.event_id} currentSeasonId={event.season_id} revision={event.revision} onSaved={() => setEditor(null)} /></TrackerTaskDialog></UnsavedChangesScope>}
  </>}</QueryState></section>;
}
export function SubeventPage() {
  const { id = "" } = useParams(), { perform, refresh } = useWorkspaceActions();
  const query = useQuery({ queryKey: ["events", "subevent", id], queryFn: () => eventsApi.subevent(id) });
  const sub = query.data;
  const parent = useQuery({ queryKey: ["events", sub?.event_id], queryFn: () => eventsApi.get(sub!.event_id), enabled: !!sub });
  const people = usePeopleOptions({ includeNonMembers: true });
  const working = sub?.working_access ?? !!sub?.capabilities.length;
  const reportsLink = useReportsLink("subevent", sub ? id : "", can(sub, "create_report"), working);
  const [editor, setEditor] = useState<"leaders" | "organizers" | "description" | "hr" | null>(null);
  if (editor === "description" && sub && parent.data && can(sub, "edit_subevent")) return <UnsavedChangesScope><Suspense fallback={<Loading />}><SubeventEditor subevent={sub} parent={parent.data} onClose={() => setEditor(null)} /></Suspense></UnsavedChangesScope>;
  const organizers = sub?.organizers ?? sub?.organizer_user_ids.flatMap(uid => { const user = people.options.find(item => item.value === String(uid))?.user;return user ? [user] : []; }) ?? [];
  return <section className={s.page}><QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{sub && <>
    <BrandedHeader className={e.eventHeader}><div><SectionHomeLink to="/events" label="Мероприятия" /><nav className={e.breadcrumbs}><Link to={getEventRoute(sub.event_id)}>{parent.data?.title ?? "Главное мероприятие"}</Link><span>›</span><span>Подмероприятие</span></nav><h1 className={s.title}>{sub.title}</h1><p className={e.period}>{eventPeriod(sub)}</p><div className={e.headerLeaders}><div className={e.sectionHeading}><h2>Ответственные</h2>{can(sub, "manage_leaders") && <button type="button" className={e.iconButton} aria-label="Изменить ответственных" onClick={() => setEditor("leaders")}><Glyph name="edit" /></button>}</div><Leaders leaders={sub.leaders} /></div></div>{can(sub, "edit_subevent") && <div className={`${s.row} ${e.headerActions}`} role="group" aria-label="Действия подмероприятия"><button type="button" className={s.button} onClick={() => setEditor("description")}><Glyph name="edit" />Редактировать подмероприятие</button></div>}</BrandedHeader>
    {sub.outside_parent_dates && <p className={e.warning}>Даты выходят за период главного мероприятия.</p>}
    <Card title="О мероприятии">{sub.announcement?.body ? <Markdown content={sub.announcement} /> : <Empty>Анонс пока не опубликован.</Empty>}</Card>
    {working && <Card title="Рабочая информация"><Markdown content={sub.description} /><div className={s.row}>{can(sub, "create_volunteer_merit") && <RouteLink to={`/merits?source_kind=subevent_volunteer&scope_id=${encodeURIComponent(id)}`}>Учесть волонтёрскую работу</RouteLink>}{can(sub, "view_tasks") || can(sub, "create_task") ? <RouteLink to={`/tasks?scope_kind=subevent&scope_id=${encodeURIComponent(id)}`}>Задачи команды</RouteLink> : null}{reportsLink && <RouteLink to={`/reports?owner_kind=subevent&owner_id=${encodeURIComponent(id)}`}>Отчёты</RouteLink>}{can(sub, "view_meeting") && <RouteLink to={`/meetings/subevent/${encodeURIComponent(id)}`}>Созвон</RouteLink>}</div></Card>}
    <Card title="Команда"><div className={e.sectionHeading}><h3>Организаторы</h3>{can(sub, "manage_organizers") && <button type="button" className={e.iconButton} aria-label="Изменить состав организаторов" onClick={() => setEditor("organizers")}><Glyph name="edit" /></button>}</div><div className={e.leaders}>{organizers.map(user => <UserChip key={user.user_id} user={user} />)}{!organizers.length && <Empty>Организаторы пока не назначены.</Empty>}</div><div className={e.hr}><h3>HR подмероприятия</h3><div className={s.row}>{sub.hr ? <UserChip user={sub.hr} /> : <span className={s.muted}>HR не назначен</span>}{can(sub, "assign_subevent_hr") && <button type="button" className={e.iconButton} aria-label="Изменить HR подмероприятия" onClick={() => setEditor("hr")}><Glyph name="edit" /></button>}</div></div></Card>
    {working && <HistoryDisclosure kind="subevent" id={id} />}
    {editor && editor !== "description" && <UnsavedChangesScope><TrackerTaskDialog title={editor === "leaders" ? "Ответственные" : editor === "hr" ? "HR подмероприятия" : "Организаторы"} onClose={() => setEditor(null)}>{editor === "leaders" ? <LeadersEditor owner={sub} kind="subevents" onSaved={() => setEditor(null)} /> : <ActionForm revision={sub.revision} record={`subevent:${id}`} fields={[editor === "hr" ? { name: "user", label: "HR подмероприятия", type: "select", entity: "person", options: people.options, value: sub.hr?.user_id == null ? "" : String(sub.hr.user_id) } : { name: "users", label: "Организаторы", type: "multi", options: people.options, value: sub.organizer_user_ids.map(String) }]} onConflict={refresh} onSubmit={async (values, revision) => { const saved = await perform(() => editor === "hr" ? eventsApi.assignSubeventHr(id, { expected_revision: revision!, user_id: text(values, "user") ? Number(text(values, "user")) : null }) : eventsApi.organizers(id, ids(values, "users"), { expected_revision: revision! }));setEditor(null);return saved; }} />}</TrackerTaskDialog></UnsavedChangesScope>}
  </>}</QueryState></section>;
}
