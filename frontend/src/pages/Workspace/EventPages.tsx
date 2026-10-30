import { lazy, Suspense, useEffect, useState } from "react";
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
import type { Event, Subevent, ParticipationRole } from "../../utils/api/contract";
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
import { eventLogo } from "../../utils/teamLogos";
import { moscowDay } from "../../utils/calendar";
import { canRetainData } from "../../utils/api/request";
import c from "./EventCatalogue.module.css";

function useReportsLink(owner_kind: "event" | "subevent", owner_id: string, canCreate: boolean, enabled = true) {
  const readable = useQuery({ queryKey: ["reports", "owner", owner_kind, owner_id], queryFn: () => reportsApi.list({ owner_kind, owner_id }), enabled: enabled && !!owner_id && !canCreate });
  return enabled && (canCreate || !readable.error && !!readable.data?.items.length);
}
type EventCataloguePhase = "all" | "current" | "upcoming" | "undated";
const cataloguePhases: {value:EventCataloguePhase;label:string}[]=[{value:"all",label:"Все"},{value:"current",label:"Сейчас идут"},{value:"upcoming",label:"Ближайшие"},{value:"undated",label:"Без даты"}];
const eventRoleNames:Partial<Record<ParticipationRole,string>>={event_leader:"Главорг",event_deputy:"Зам. главорга",subevent_leader:"Ответственный",subevent_deputy:"Зам. ответственного",organizer:"Организатор",subevent_hr:"HR подмероприятия"};
const monthLabel=new Intl.DateTimeFormat("ru-RU",{month:"long",year:"numeric",timeZone:"Europe/Moscow"});
const dateNumber=new Intl.DateTimeFormat("ru-RU",{day:"2-digit",timeZone:"Europe/Moscow"});
const shortMonth=new Intl.DateTimeFormat("ru-RU",{month:"short",timeZone:"Europe/Moscow"});
const validEventStart=(event:Event)=>!!event.starts_at&&Number.isFinite(Date.parse(event.starts_at));
const catalogueMonthTitle=(key:string)=>{const label=monthLabel.format(new Date(key+"-15T12:00:00Z")).replace(/\s*г\.$/,"");return label[0].toLocaleUpperCase("ru")+label.slice(1);};
const eventOrder=(left:Event,right:Event)=>(validEventStart(left)?Date.parse(left.starts_at!):Infinity)-(validEventStart(right)?Date.parse(right.starts_at!):Infinity)||left.title.localeCompare(right.title,"ru");
function EventCatalogueFace({event,current=false}:{event:Event;current?:boolean}) {
  if(current)return <span className={c.liveDot} aria-label="Сейчас идёт"/>;
  if(validEventStart(event))return <span className={c.dateTile} aria-hidden="true"><b>{dateNumber.format(new Date(event.starts_at!))}</b><small>{shortMonth.format(new Date(event.starts_at!)).replace(".","")}</small></span>;
  const logo=eventLogo(event.title);
  return <span className={c.eventFace} aria-hidden="true">{logo?<img src={logo} alt=""/>:event.title.trim().split(/\s+/).slice(0,2).map(word=>[...word][0]).join("").toLocaleUpperCase("ru")||<Glyph name="event"/>}</span>;
}
function EventCatalogueGroup({title,items,own,current=false}:{title:string;items:Event[];own:Set<string>;current?:boolean}) {
  return <section className={`${c.panel} ${current?c.currentPanel:""}`} aria-label={title}><h2 aria-label={title}>{title}<span className={c.count} aria-hidden="true">{items.length}</span></h2><ul className={c.eventList} aria-label={title}>{items.map(event=><li key={event.event_id}><Link className={c.eventRow} to={getEventRoute(event.event_id)}><EventCatalogueFace event={event} current={current}/><span className={c.eventLabel}><strong>{event.title}</strong><small>{eventPeriod(event)}</small></span>{event.is_closed&&<span className={c.rowState}>Закрыто</span>}{own.has(event.event_id)&&<span className={c.rowRole}>Я в команде</span>}<span className={c.chevron} aria-hidden="true">›</span></Link></li>)}</ul></section>;
}
export function EventsListPage() {
  const {session}=useSession(),[params,setParams]=useSearchParams();
  const [now,setNow]=useState(Date.now);useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),60000);return()=>window.clearInterval(timer);},[]);
  const events=useQuery({queryKey:["events"],queryFn:()=>eventsApi.list()});
  const seasons=useQuery({queryKey:["seasons"],queryFn:seasonsApi.list});
  const participation=useQuery({queryKey:["participation"],queryFn:workspaceApi.participation});
  const mine=params.get("mine")==="true",archive=params.get("archive")==="true",search=params.get("q")??"",seasonId=params.get("season_id")??"";
  const phase:EventCataloguePhase=cataloguePhases.some(item=>item.value===params.get("phase"))?params.get("phase") as EventCataloguePhase:"all";
  const update=(key:string,value:string)=>{const next=new URLSearchParams(params);if(value)next.set(key,value);else next.delete(key);setParams(next);};
  const updatePeriod=(value:string)=>{const next=new URLSearchParams(params);next.delete("season_id");next.delete("archive");if(value==="archive")next.set("archive","true");else if(value.startsWith("season:")){const id=value.slice(7);next.set("season_id",id);if(seasons.data?.items.find(season=>season.season_id===id)?.state==="closed")next.set("archive","true");}setParams(next);};
  const errors=[events.error,seasons.error,mine?participation.error:null].filter(error=>!!error),error=errors.find(error=>!canRetainData(error))??errors[0]??null;
  const mayRetain=errors.every(error=>canRetainData(error));
  const eventData=mayRetain?events.data:undefined,seasonData=mayRetain?seasons.data:undefined;
  const ownRows=participation.error&&!canRetainData(participation.error)?[]:participation.data?.events??[];
  const own=new Set(ownRows.map(event=>event.event_id));
  const periodEvents=(eventData?.items??[]).filter(event=>(!seasonId||event.season_id===seasonId)&&(seasonData?.items.find(season=>season.season_id===event.season_id)?.state==="closed")===archive);
  const matching=periodEvents.filter(event=>(!mine||own.has(event.event_id))&&event.title.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru").trim())).sort(eventOrder);
  const phaseOf=(event:Event)=>validEventStart(event)?eventPhase(event,now):"undated";
  const shown=matching.filter(event=>phase==="all"||phaseOf(event)===phase),current=shown.filter(event=>phaseOf(event)==="current"),undated=shown.filter(event=>phaseOf(event)==="undated");
  const months=new Map<string,Event[]>();for(const event of shown){if(["current","undated"].includes(phaseOf(event)))continue;const key=moscowDay(event.starts_at!).slice(0,7);months.set(key,[...(months.get(key)??[]),event]);}
  const mineInPeriod=periodEvents.filter(event=>own.has(event.event_id)).sort(eventOrder);
  const next=[...periodEvents].filter(event=>phaseOf(event)==="upcoming"&&!event.is_closed).sort(eventOrder)[0];
  const nextDay=next?.starts_at?Math.round((Date.parse(moscowDay(next.starts_at)+"T00:00:00Z")-Date.parse(moscowDay(new Date(now).toISOString())+"T00:00:00Z"))/86400000):null;
  const retry=()=>{void events.refetch();void seasons.refetch();void participation.refetch();};
  return <Page className={c.page} headerClassName={c.header} title="Мероприятия" description="Что происходит сейчас и к чему готовится Профком." actions={can(session,"create_event")&&<RouteLink to={getEventCreateRoute()}><Glyph name="add"/>Создать мероприятие</RouteLink>}>
    <div className={c.filters} aria-label="Фильтры мероприятий"><label className={c.search}><svg className={c.searchIcon} viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><span className={c.srOnly}>Поиск мероприятий</span><input type="search" value={search} placeholder="Найти мероприятие" onChange={event=>update("q",event.target.value)}/></label><label className={c.selectField}><span className={c.srOnly}>Участие</span><select value={mine?"mine":"all"} onChange={event=>update("mine",event.target.value==="mine"?"true":"")}><option value="all">Все мероприятия</option><option value="mine">С моим участием</option></select></label><label className={c.selectField}><span className={c.srOnly}>Период</span><select value={seasonId?"season:"+seasonId:archive?"archive":"current"} onChange={event=>updatePeriod(event.target.value)}><option value="current">Текущие сезоны</option><option value="archive">Архив</option><optgroup label="Сезоны">{seasonData?.items.map(season=><option key={season.season_id} value={"season:"+season.season_id}>{season.title}{season.state==="closed"?" · архив":""}</option>)}</optgroup></select></label></div>
    <div className={c.phaseTabs} role="group" aria-label="Показать мероприятия">{cataloguePhases.map(item=><button type="button" key={item.value} aria-label={item.label} aria-pressed={phase===item.value} onClick={()=>update("phase",item.value==="all"?"":item.value)}>{item.label}<span className={c.count} aria-hidden="true">{item.value==="all"?matching.length:matching.filter(event=>phaseOf(event)===item.value).length}</span></button>)}</div>
    <QueryState loading={events.isLoading||seasons.isLoading||mine&&participation.isLoading} error={error} keepDataOnError={!!events.data&&!!seasons.data} retry={retry}>
      <div className={c.catalogue}><section className={c.stream} aria-label="Лента мероприятий">{current.length>0&&<EventCatalogueGroup title="Сейчас идут" items={current} own={own} current/>}{[...months].map(([key,items])=><EventCatalogueGroup key={key} title={catalogueMonthTitle(key)} items={items} own={own}/>)}{undated.length>0&&<EventCatalogueGroup title="Даты уточняются" items={undated} own={own}/>} {!shown.length&&<div className={c.panel}><Empty>Мероприятия по выбранным условиям не найдены.</Empty></div>}</section>
        <aside className={c.sidebar} aria-label="Ваши мероприятия"><section className={c.panel}><h2 aria-label="С моим участием">С моим участием<span className={c.count} aria-hidden="true">{mineInPeriod.length}</span></h2><QueryState loading={participation.isLoading} error={participation.error} keepDataOnError={!!participation.data} retry={()=>void participation.refetch()}><ul className={c.ownList} aria-label="Моё участие в мероприятиях">{mineInPeriod.slice(0,5).map(event=><li key={event.event_id}><Link to={getEventRoute(event.event_id)}><EventCatalogueFace event={{...event,starts_at:null}}/><span><strong>{event.title}</strong><small>{ownRows.find(item=>item.event_id===event.event_id)?.roles.map(role=>eventRoleNames[role]??"В команде").join(" · ")||"В команде"}</small></span><span className={c.chevron} aria-hidden="true">›</span></Link></li>)}</ul>{mineInPeriod.length>5&&<button type="button" className={c.allMine} onClick={()=>update("mine","true")}>Все мои мероприятия</button>}{!mineInPeriod.length&&<p className={c.empty}>В выбранном периоде нет мероприятий с вашим участием.</p>}<p className={c.note}>Ваши роли в командах мероприятий</p></QueryState></section>
          <section className={`${c.panel} ${c.nextEvent}`} aria-label="Ближайшее мероприятие"><span className={c.kicker}>Ближайшее мероприятие</span>{next?<><h2>{next.title}</h2><p className={c.countdown}>{nextDay===0?"Сегодня":nextDay===1?"Завтра":`Через ${nextDay} дн.`}</p><p className={c.note}>{eventPeriod(next)}</p><Link className={c.openEvent} to={getEventRoute(next.event_id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>Открыть мероприятие</Link></>:<p className={c.empty}>Ближайших мероприятий с известными датами пока нет.</p>}</section>
        </aside>
      </div>
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
  const { perform } = useWorkspaceActions();
  const [statePending, setStatePending] = useState(false), [stateError, setStateError] = useState(false);
  const query = useQuery({ queryKey: ["events", id], queryFn: () => eventsApi.get(id) });
  const subs = useQuery({ queryKey: ["events", id, "subevents"], queryFn: () => eventsApi.subevents(id), enabled: !!query.data });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const [editor, setEditor] = useState<"leaders" | "season" | "child" | null>(null);
  const event = query.data, reportsLink = useReportsLink("event", event ? id : "", can(event, "create_report"));
  const changeClosed = async () => {
    if (!event || statePending) return;
    setStatePending(true);setStateError(false);
    try { await perform(() => eventsApi.setClosed(id, !event.is_closed, { expected_revision: event.revision })); }
    catch { setStateError(true); }
    finally { setStatePending(false); }
  };
  const childRows = subs.data?.items ?? [], nearest = childRows.filter(item => ["current", "upcoming"].includes(eventPhase(item))).sort((left, right) => (left.starts_at ?? "").localeCompare(right.starts_at ?? "")).slice(0, 5);
  if (editor === "child" && event && can(event, "create_subevent")) return <UnsavedChangesScope><Suspense fallback={<Loading />}><SubeventEditor parent={event} onClose={() => setEditor(null)} /></Suspense></UnsavedChangesScope>;
  return <section className={s.page}><QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{event && <>
    <BrandedHeader className={e.eventHeader}><div><SectionHomeLink to="/events" label="Мероприятия" /><h1 className={s.title}>{eventLogo(event.title) && <img src={eventLogo(event.title)!} alt="" className={e.titleLogo} />}{event.title}</h1><p className={e.period}>{eventPeriod(event)}</p>{event.is_closed && <Badge>Мероприятие закрыто</Badge>}<div className={e.headerLeaders}><div className={e.sectionHeading}><h2>Главорги</h2>{can(event, "manage_leaders") && <button type="button" className={e.iconButton} aria-label="Изменить главоргов" onClick={() => setEditor("leaders")}><Glyph name="edit" /></button>}</div><Leaders leaders={event.leaders} /></div></div><div className={`${s.row} ${e.headerActions}`} role="group" aria-label="Действия мероприятия">{can(event, "edit_event") && <RouteLink to={getEventEditRoute(id)}><Glyph name="edit" />Изменить мероприятие</RouteLink>}{(can(event, "close_event") || can(event, "reopen_event")) && <button type="button" className={s.button} disabled={statePending} onClick={() => void changeClosed()}>{event.is_closed ? "Открыть мероприятие" : "Закрыть мероприятие"}</button>}<RouteLink to="/events">Все мероприятия</RouteLink></div></BrandedHeader>
    {stateError && <p role="alert">Не удалось изменить состояние мероприятия. Обновите страницу и повторите попытку.</p>}
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
