import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { useState, useRef, useEffect, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useLocation, useParams, useSearchParams, useNavigate } from "react-router-dom";
import { QueryState, Empty, Glyph, Card } from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import { ownedLayerTarget, useAnchoredLayer } from "../../components/Workspace/useAnchoredLayer";
import { DecisionBadges, DecisionSymbol, ranked } from "./SummaryTable";
import m from "./TaskClassificationMenu.module.css";
import { AnchoredPopover } from "../../components/Workspace/AnchoredPopover";
import { UserChip } from "../../components/Workspace/UserChip";
import { SeasonBlockers } from "./SeasonBlockers";
import { seasonsApi } from "../../utils/api/seasons.api";
import { isStale, userMessage } from "../../utils/api/messages";
import { normalizeApiError } from "../../utils/api/request";
import { can, useSession } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { getSeasonRoute, getSeasonCreateRoute, getKkrTemplatesRoute } from "../../utils/routes";
import { createsMerits, readsMerits } from "./meritAccess";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import type { Decision, Season, SeasonBlocker, SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { decisionLabels, decisionTitle } from "../../utils/decisions";
import { SeasonEditor } from "./SeasonEditor";
import { SeasonParticipants } from "./SeasonParticipants";
import { SeasonAnalytics, AnalyticsMetrics } from "./SeasonAnalytics";
import { analyticsKey, sourceNames, metricValue, plural } from "./seasonAnalyticsView";
import { SeasonStatistics, SeasonKkrHistory, SeasonKkrControl, SeasonKkrSummon } from "./SeasonKkrViews";
import { SummaryHistory } from "./SummaryHistory";
import { HistoryDisclosure } from "../../components/Workspace/HistoryPanel";
import { KkrTemplateLibrary } from "../../components/Workspace/KkrTemplateLibrary";
export { DecisionBadges } from "./SummaryTable";
import w from "../../components/Workspace/Workspace.module.css";
import u from "./SeasonWorkspace.module.css";

const states = { planned: "Запланирован", open: "Открыт", summarizing: "Подведение итогов", closed: "Закрыт" };
const typeNames = { winter_spring: "Зима — весна", summer_autumn: "Лето — осень", autumn_winter: "Осень — зима" };
const State = ({ season }: { season: Season }) => <span className={u.state} data-state={season.state}>{states[season.state]}</span>;
const dateRange = (season: Season) => `${displayDate(season.starts_at)} — ${displayDate(season.ends_at)}`;

/** Only one season may wait to open: with one planned, creation leads to it instead of a form that would be refused. */
function PlannedSeason({ season }: { season: Season }) {
  return <p className={u.plannedNotice} role="status">Уже есть запланированный сезон: <Link to={getSeasonRoute(season.season_id)}>{season.title}</Link></p>;
}
export function SeasonsPage() {
  const { session } = useSession();const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });const planned = query.data?.items.find(season => season.state === "planned");
  const ordered = [...(query.data?.items ?? [])].sort((a, b) => b.sequence_number - a.sequence_number);const current = ordered.find(season => season.is_current);const other = ordered.filter(season => season.season_id !== current?.season_id);
  return <section className={u.page}><BrandedHeader className={u.header}><div><SectionHomeLink to="/seasons" /><h1 className={w.title}>Сезоны и ККР</h1><p className={w.description}>Работа участников, начисления и итоги — в контексте выбранного сезона.</p></div><div className={w.row}><Link className={w.button} to={getKkrTemplatesRoute()}><Glyph name="description" />Шаблоны ККР</Link>{can(session, "open_season") && (planned ? <PlannedSeason season={planned} /> : <Link className={`${u.primary} ${w.button}`} to={getSeasonCreateRoute()}><Glyph name="add" />Создать сезон</Link>)}</div></BrandedHeader>
    <QueryState loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>
      {current && <section className={u.current} aria-label="Текущий сезон"><div><p className={u.eyebrow}>Текущий сезон</p><h2>{current.title}</h2><p>{dateRange(current)}</p><div className={u.statusLine}><State season={current} /><small>{typeNames[current.type]}</small></div></div><Link className={u.primary} to={getSeasonRoute(current.season_id)}>Открыть сезон <span aria-hidden="true">→</span></Link></section>}
      <section className={u.stack}><div className={u.sectionHeading}><h2>{current ? "Другие сезоны" : "Все сезоны"}</h2><small>{other.length} сезонов</small></div><div className={u.seasonList}>{other.map(season => <Link key={season.season_id} className={u.seasonRow} to={getSeasonRoute(season.season_id)}><div><h3>{season.title}</h3><p>{typeNames[season.type]}</p></div><span className={u.seasonDates}>{dateRange(season)}</span><State season={season} /><span aria-hidden="true">↗</span></Link>)}</div>{!other.length && <Empty>{current ? "Других сезонов пока нет." : "Сезонов пока нет. Создайте первый сезон, чтобы начать учёт работы."}</Empty>}</section>
    </QueryState>
  </section>;
}
export function KkrTemplatesPage() {
  return <section className={u.page}><BrandedHeader className={u.header}><div><SectionHomeLink to="/seasons" /><h1 className={w.title}>Шаблоны ККР</h1><p className={w.description}>Личные и командные заготовки для учёта работы. Применение шаблона заполняет черновик.</p></div><Link to="/seasons" className={w.button}><Glyph name="arrow_back" />Сезоны и ККР</Link></BrandedHeader>
    <Card><UnsavedChangesScope><KkrTemplateLibrary embedded /></UnsavedChangesScope></Card>
  </section>;
}
export function SeasonCreatePage() {
  const { session } = useSession();const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled: can(session, "open_season") });
  const planned = query.data?.items.find(season => season.state === "planned");
  if (!can(session, "open_season")) return <section className={u.page}><h1>Новый сезон</h1><Empty>Создание сезона доступно председателю.</Empty><Link to="/seasons" className={u.secondary}>Все сезоны</Link></section>;
  if (query.isLoading) return <QueryState loading error={null}>{null}</QueryState>;
  if (planned) return <section className={u.page}><h1 className={w.title}>Новый сезон</h1><PlannedSeason season={planned} /><p className={u.note}>Новый сезон можно создать, когда запланированный откроется.</p><Link to="/seasons" className={u.secondary}>Все сезоны</Link></section>;
  return <UnsavedChangesScope><SeasonEditor /></UnsavedChangesScope>;
}
type SeasonAction = "open" | "begin-summary" | "close";
const commands: { action: SeasonAction; capability: string; label: string; icon: "event" | "pending_actions" | "check" }[] = [
  { action: "open", capability: "open_season", label: "Открыть и сделать текущим", icon: "event" },
  { action: "begin-summary", capability: "begin_summary", label: "Начать подведение итогов", icon: "pending_actions" },
  { action: "close", capability: "close_season", label: "Закрыть сезон", icon: "check" },
];
/** One menu of season actions: it stays on screen and closes on Escape or a click outside. */
function SeasonManage({ season, summary, onEdit, onBlocked }: { season: Season; summary?: SeasonSummary; onEdit: () => void; onBlocked: (blockers: SeasonBlocker[]) => void }) {
  const { session } = useSession();const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const correct = season.state === "closed" && can(session, "correct_season") && can(summary, "correct_summary");
  const available = commands.filter(command => can(season, command.capability));
  if (!can(season, "edit_season") && !available.length && !correct) return null;
  const close = () => setOpen(false);
  return <><button ref={anchor} type="button" className={`${u.secondary} ${w.button}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>Управление сезоном <Glyph name="expand_more" /></button>
    <AnchoredPopover open={open} anchorRef={anchor} label="Управление сезоном" onRequestClose={close} busy={busy} width={320}><div className={u.manageMenu}>
      {can(season, "edit_season") && <button type="button" className={u.manageItem} onClick={() => { close();onEdit(); }}><Glyph name="edit" />Название и период</button>}
      {available.map(command => <SeasonCommand key={command.action} season={season} {...command} onBusy={setBusy} onDone={close} onBlocked={blockers => { close();onBlocked(blockers); }} />)}
      {correct && <Link className={u.manageItem} to={`${getSeasonRoute(season.season_id)}/corrections`} onClick={close}><Glyph name="edit_document" />Исправить итоги…</Link>}
    </div></AnchoredPopover></>;
}
function SeasonCommand({ season, action, label, icon, onBusy, onDone, onBlocked }: { season: Season; action: SeasonAction; label: string; icon: (typeof commands)[number]["icon"]; onBusy: (busy: boolean) => void; onDone: () => void; onBlocked: (blockers: SeasonBlocker[]) => void }) {
  const { perform, refresh } = useWorkspaceActions();const running = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async () => {
    if (running.current) return;running.current = true;setBusy(true);onBusy(true);setError("");
    try { await perform(() => seasonsApi.command(season.season_id, action, { expected_revision: season.revision }));onDone(); }
    catch (failure) { const blockers = normalizeApiError(failure).blockers;if (blockers.length) onBlocked(blockers);else { setError(userMessage(failure));if (isStale(failure)) await refresh(); } }
    finally { running.current = false;setBusy(false);onBusy(false); }
  };
  return <><button type="button" className={u.manageItem} disabled={busy} aria-busy={busy} onClick={() => void run()}><Glyph name={icon} />{busy ? "Выполняем…" : label}</button>{error && <p role="alert" className={w.error}>{error}</p>}</>;
}
type Tab = "overview" | "participants" | "analytics" | "history" | "control";
const tabs = [{ id: "participants", title: "Участники и ККР", icon: "groups" }, { id: "analytics", title: "Аналитика", icon: "insights" }, { id: "history", title: "История ККР", icon: "sync" }, { id: "control", title: "Заполнение ККР", icon: "task_alt" }] as const;
export function SeasonPage() { return <SeasonHub />; }
/** Old summary links lead to the season's one address; without the right they say why the summary is absent. */
export function SummaryPage() {
  const { id = "" } = useParams(), { session } = useSession();
  return <Navigate replace to={getSeasonRoute(id)} state={can(session, "view_summary") ? undefined : { notice: "Итоги сезона доступны председателю, заместителям и HR." }} />;
}
const tabRoute = (id: string, tab: Tab) => `${getSeasonRoute(id)}${tab === "participants" ? "" : `?tab=${tab}`}`;
function SeasonHub({ initialTab = "participants" }: { initialTab?: Tab }) {
  const { id = "" } = useParams(), { session } = useSession();const navigate=useNavigate();const [params] = useSearchParams();const [editing, setEditing] = useState(false);
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const [blocked, setBlocked] = useState<{ seasonId: string; items: SeasonBlocker[] } | null>(null);
  const allowed = can(session, "view_summary");const selected = params.get("tab") ?? initialTab;const tab = tabs.some(tab => tab.id === selected) ? selected as Tab : "participants";
  const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });const season = query.data?.items.find(season => season.season_id === id);
  // A summary exists for a found season that has opened; a planned one has nothing to sum up yet.
  const summary = useQuery({ queryKey: ["summary", id], queryFn: () => seasonsApi.summary(id), enabled: allowed && !!season && season.state !== "planned" });
  if (editing && season) return <UnsavedChangesScope><SeasonEditor key={id} season={season} onClose={() => setEditing(false)} /></UnsavedChangesScope>;
  return <section className={u.page}>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => void query.refetch()}>{season ? <>
      <BrandedHeader className={u.header}><div><SectionHomeLink to="/seasons" /><nav className={u.breadcrumbs} aria-label="Путь сезона"><Link to="/seasons">Сезоны</Link><span>›</span><span>{typeNames[season.type]}</span></nav><h1 className={w.title}>{season.title}</h1><div className={u.period}><span>{dateRange(season)}</span>{can(season, "edit_season") && <button type="button" className={u.iconButton} aria-label="Редактировать сезон" onClick={() => setEditing(true)}><Glyph name="edit" /></button>}</div><div className={u.statusLine}><State season={season} />{season.is_current && <small>Текущий сезон</small>}{allowed && summary.data && <small>{summary.data.state === "approved" ? "Итоги утверждены" : "Предварительные итоги"} · Версия {summary.data.version}</small>}</div></div>
        <div className={u.headerActions}>{can(season, "remind_kkr") && <SeasonKkrSummon key={id} seasonId={id} />}
        {season.state === "closed" && can(session, "view_kkr") && <Link className={`${u.secondary} ${w.button}`} to={`${getSeasonRoute(id)}/sources`}><Glyph name="fact_check" />Подробные начисления</Link>}
        <SeasonManage season={season} summary={summary.data} onEdit={() => setEditing(true)} onBlocked={items => setBlocked({ seasonId: id, items })} /></div>
      </BrandedHeader>
      {notice && <div role="status" className={u.panel}><p>{notice}</p></div>}
      {blocked?.seasonId === id && <section className={u.panel} aria-label="Препятствия закрытию"><div className={u.panelHeader}><h2 role="alert">Сезон пока нельзя закрыть: {blocked.items.length} {plural(blocked.items.length, "препятствие", "препятствия", "препятствий")}</h2><button type="button" className={u.secondary} onClick={() => setBlocked(null)}>Скрыть</button></div><SeasonBlockers blockers={blocked.items} seasonId={id} /></section>}
      {allowed && <label className={u.seasonSelect}>Сезон<select aria-label="Выбранный сезон" value={id} onChange={e=>navigate(tabRoute(e.target.value, tab))}>{query.data?.items.map(item=><option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>}
      {allowed && <nav className={u.tabs} aria-label="Разделы сезона">{tabs.map(item => <Link key={item.id} to={tabRoute(id, item.id)} aria-current={tab === item.id ? "page" : undefined}><Glyph name={item.icon} />{item.title}</Link>)}</nav>}
      {tab === "overview" || !allowed ? <SeasonOverview season={season} summary={summary.data} allowed={allowed} /> : tab === "participants" ? season.state === "planned" ? <SeasonNotOpen seasonId={id} /> : <QueryState loading={summary.isLoading} error={summary.error} keepDataOnError={!!summary.data} retry={() => void summary.refetch()}>{summary.data && <UnsavedChangesScope><SeasonDecisionEditors key={summary.data.season_id} summary={summary.data} /></UnsavedChangesScope>}</QueryState> : tab === "analytics" ? <section className={u.stack}><SeasonStatistics seasonId={id} summary={summary.data} /><LazyPanel key={`analytics:${id}`} title="Динамика задач, часов и ККР"><SeasonAnalytics key={id} seasonId={id} /></LazyPanel></section> : tab === "control" ? <SeasonKkrControl seasonId={id} /> : <section className={u.stack}><div className={u.sectionHeading}><h2>История ККР по сезонам</h2></div><SeasonKkrHistory /><LazyPanel key={`versions:${id}`} title="Версии утверждённых итогов"><SummaryHistory key={id} seasonId={id} /></LazyPanel></section>}
      {allowed && <LazyPanel key={`workflow:${id}`} title="Работа сезона и управление итогами"><SeasonOverview season={season} summary={summary.data} allowed={allowed} participants={tab !== "participants"} /></LazyPanel>}
      <HistoryDisclosure kind="season" id={id} title="История названия и периода сезона" />
    </> : !query.isLoading && <><Empty>Сезон не найден.</Empty><Link to="/seasons" className={u.secondary}>Все сезоны</Link></>}</QueryState>
  </section>;
}
/** A planned season has no work, totals or marks yet; the analytics still compare the past seasons. */
function SeasonNotOpen({ seasonId }: { seasonId: string }) {
  return <section className={u.panel} aria-label="Участники и ККР"><h2>Сезон ещё не открыт</h2><p>Участники, начисления и отметки появятся после открытия сезона.</p><Link className={u.secondary} to={tabRoute(seasonId, "analytics")}>Аналитика прошлых сезонов <span aria-hidden="true">→</span></Link></section>;
}
function LazyPanel({title,children}:{title:string;children:ReactNode}) {
  const [open,setOpen]=useState(false);
  return <details className={u.disclosure} onToggle={event=>setOpen(event.currentTarget.open)}><summary><span>{title}</span><Glyph name="expand_more"/></summary>{open&&<div className={u.disclosureBody}>{children}</div>}</details>;
}

/** `participants`: the top of the participants list, left out where the list itself is open. */
function SeasonOverview({ season, summary, allowed, participants = true }: { season: Season; summary?: SeasonSummary; allowed: boolean; participants?: boolean }) {
  const { session } = useSession();const id = season.season_id;
  const analytics = useQuery({ queryKey: analyticsKey(id), queryFn: () => seasonsApi.analytics(id), enabled: allowed });
  const bonuses = useQuery({ queryKey: ["masterBonuses", id], queryFn: () => seasonsApi.bonuses(id), enabled: allowed });
  const readiness = useQuery({ queryKey: ["seasons", "readiness", id], queryFn: () => seasonsApi.readiness(id), enabled: allowed && ["open", "summarizing"].includes(season.state) });
  const scores = analytics.data?.source_breakdown ?? [], maximum = Math.max(1, ...scores.map(source => Math.abs(source.kkr ?? 0)));
  return <div className={u.stack}>
    {allowed && ["open", "summarizing"].includes(season.state) && <section className={u.panel} aria-label="Проверки сезона"><h2>Проверки сезона</h2><QueryState loading={readiness.isLoading} error={readiness.error} retry={() => void readiness.refetch()}>{readiness.data && (readiness.data.ready ? <p>Препятствий для закрытия нет.</p> : <details><summary>Препятствий закрытию: {readiness.data.blockers.length}</summary><SeasonBlockers blockers={readiness.data.blockers} seasonId={id} /></details>)}</QueryState></section>}
    {allowed && <QueryState loading={analytics.isLoading} error={analytics.error} retry={() => void analytics.refetch()}>{analytics.data && <><AnalyticsMetrics totals={analytics.data.totals} />{analytics.data.coverage.notes.length > 0 && <p className={u.coverageLine}>{analytics.data.coverage.notes[0]}</p>}</>}</QueryState>}
    <div className={u.overviewColumns}><section className={u.panel}><div className={u.panelHeader}><h2>Работа сезона</h2></div><p>Задачи, результаты и мероприятия этого периода.</p><div className={u.actions}><Link className={u.secondary} to={`/tasks?season_id=${encodeURIComponent(id)}&mine=false`}>Задачи сезона <span aria-hidden="true">→</span></Link><Link className={u.secondary} to={`/events?season_id=${encodeURIComponent(id)}${season.state === "closed" ? "&archive=true" : ""}`}>Мероприятия <span aria-hidden="true">→</span></Link>{(createsMerits(session) || readsMerits(session)) && <Link className={u.secondary} to={`/seasons/${encodeURIComponent(id)}/merits`}>Заслуги и волонтёрство <span aria-hidden="true">→</span></Link>}</div><p className={u.note}>{season.state === "closed" ? "Итоги сезона сохранены. Правки исходных полей выполняются у соответствующей задачи; прежние версии остаются в истории." : "Статус задачи отражает ход работы. Начисления ККР появляются после отдельного расчётного решения уполномоченного руководителя."}</p></section>
      {allowed && <section className={u.panel}><div className={u.panelHeader}><h2>Источники ККР</h2><Link to={`/seasons/${encodeURIComponent(id)}/sources`}>Все начисления →</Link></div>{scores.length ? scores.map(source => <div className={u.source} key={source.source_kind}><div><span>{sourceNames[source.source_kind]}</span><strong>{metricValue(source.kkr)}</strong></div><div className={u.track}><span data-negative={(source.kkr ?? 0) < 0} style={{ width: `${Math.abs(source.kkr ?? 0) / maximum * 100}%` }} /></div></div>) : <p className={u.note}>{analytics.isLoading ? "Загружаем начисления…" : "Учтённых начислений пока нет."}</p>}</section>}
    </div>
    {allowed && participants && summary && <section className={u.panel}><div className={u.panelHeader}><h2>Участники сезона</h2><Link to={getSeasonRoute(id)}>Все участники и ККР →</Link></div>{[...summary.rows].sort((a, b) => a.rank - b.rank).slice(0, 5).map(row => <div key={row.participant_id} className={u.personRank}><span>{ranked(summary) ? row.rank : "—"}</span><UserChip user={row.user} /><strong>{metricValue(row.total_score)}</strong></div>)}{!summary.rows.length && <Empty>Участников с расчётными данными пока нет.</Empty>}</section>}
    {allowed && <section className={u.panel}><details><summary>Бонусы мастеров и основания расчёта</summary><QueryState loading={bonuses.isLoading} error={bonuses.error}>{bonuses.data?.items.map(bonus => <details className={w.details} key={bonus.bonus_id}><summary>{bonus.recipient?.display_name ?? "Мастер не назначен"} · {bonus.amount.toFixed(2)} ККР · учитываемых организаторов {bonus.eligible_organizer_count}</summary><p className={u.note}>Версия расчёта: {bonus.calculation_version}</p><Link to={`/blocks/${encodeURIComponent(bonus.block_id)}`} className={u.tableAction}>Блок — источник бонуса →</Link><ul className={u.coverage}>{bonus.basis.map(member => <li key={member.participant_id}>{member.user.display_name}: {metricValue(member.member_task_score)} — {member.included ? "включён" : member.exclusion === "master" ? "исключён как мастер" : "исключён: неположительный вклад"}</li>)}</ul></details>)}{bonuses.data?.items.length === 0 && <Empty>Бонусов в этом сезоне нет.</Empty>}</QueryState></details></section>}
  </div>;
}
function SeasonDecisionEditors({ summary }: { summary: SeasonSummary }) {
  const [active, setActive] = useState<string | null>(null);const guardEditor = useGuardedAction();
  return <SeasonParticipants summary={summary} onFilterApply={() => setActive(null)} renderDecisions={row => can(summary, "edit_decisions") && row.user.user_id !== null ? <DecisionsForm row={row} summary={summary} open={active === row.participant_id}
    onToggleEditor={reset => { const next = active === row.participant_id ? null : row.participant_id;guardEditor(() => {setActive(next);reset?.();}); }} onSaved={() => setActive(null)} /> : null} />;
}
function DecisionsForm({ summary, row, open, onToggleEditor, onSaved }: { summary: SeasonSummary; row: SummaryRow; open: boolean; onToggleEditor: (reset?:()=>void) => void; onSaved: () => void }) {
  const anchorRef=useRef<HTMLButtonElement>(null),saving=useRef(false);const client=useQueryClient();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<Decision[]|null>(null);
  const close=()=>onToggleEditor(()=>setPending(null));
  const save=async(values:Decision[],reason?:string,expectedVersion=summary.version)=>{
    if(saving.current)throw Error('Сохранение уже выполняется');saving.current=true;setBusy(true);setError('');
    try{const result=await seasonsApi.decisions(summary.season_id,row.user.user_id!,{expected_version:expectedVersion,decisions:values,...(reason?{reason}:{})});client.setQueryData(['summary',summary.season_id],result);await client.invalidateQueries({queryKey:['kkr-history']});return result;}
    catch(error){setError(userMessage(error));if(normalizeApiError(error).code==='revision_conflict')await client.invalidateQueries({queryKey:['summary',summary.season_id]});throw error;}
    finally{saving.current=false;setBusy(false);}
  };
  const choose=(values:Decision[])=>{if(saving.current)return;if(summary.state==='approved'){setPending(values);return;}void save(values).then(close).catch(()=>{});};
  return <><button ref={anchorRef} type="button" className={m.trigger} aria-label={`Изменить отметки: ${row.user.display_name}`} aria-expanded={open} aria-haspopup={pending?'dialog':'menu'} aria-busy={busy} disabled={busy} onClick={()=>onToggleEditor(()=>setPending(null))} onKeyDown={event=>{if(!open&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();onToggleEditor(()=>setPending(null));}}}><span aria-label="Решения текущего сезона">{row.decisions.length?<DecisionBadges values={row.decisions}/>:<span>Без отметки</span>}</span><svg className={m.caret} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
    <MarkChoiceMenu open={open&&pending===null} anchorRef={anchorRef} label={`Отметки: ${row.user.display_name}`} values={row.decisions} preserveSelected={summary.state==='approved'} busy={busy} error={error} onClose={close} onChoose={choose}/>
    <AnchoredPopover open={open&&pending!==null} anchorRef={anchorRef} label={`Отметки: ${row.user.display_name}`} onRequestClose={close} busy={busy} width={340}>
      <ActionForm revision={summary.version} record={`summary:${summary.season_id}`} adoptWhenUntouched onConflict={()=>void client.invalidateQueries({queryKey:['summary',summary.season_id]})} fields={[{name:'decisions',label:'Отметки',type:'multi',confirmRemoval:false,value:pending??row.decisions,options:Object.entries(decisionLabels).map(([value,label])=>({value,label}))},{name:'reason',label:'Причина исправления',required:true}]} onSubmit={async(values,revision)=>{const result=await save(values.decisions as Decision[],text(values,'reason'),revision);/* A saved correction closes so a second click cannot repeat it. */setPending(null);onSaved();return {revision:result.version};}}/>
      {error&&<p role="alert" className={w.error}>{error}</p>}
    </AnchoredPopover></>;
}
function MarkChoiceMenu({open,anchorRef,label,values,preserveSelected,busy,error,onClose,onChoose}:{open:boolean;anchorRef:RefObject<HTMLButtonElement|null>;label:string;values:Decision[];preserveSelected:boolean;busy:boolean;error:string;onClose:()=>void;onChoose:(values:Decision[])=>void}) {
  const menu=useRef<HTMLDivElement>(null),portal=useAnchoredLayer(open,anchorRef,menu,280);
  useLayoutEffect(()=>{if(!open||!portal)return;const selected=menu.current?.querySelector<HTMLElement>('[aria-checked="true"]');(selected??menu.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]'))?.focus({preventScroll:true});const trigger=anchorRef.current;return()=>{if(trigger?.isConnected)trigger.focus({preventScroll:true});};},[open,portal,anchorRef]);
  useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!busy&&!ownedLayerTarget(event.target,menu.current)&&!anchorRef.current?.contains(event.target as Node))onClose();};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open,busy,anchorRef,onClose]);
  if(!open||!portal)return null;
  return createPortal(<div ref={menu} role="menu" aria-label={label} className={m.menu} data-anchored-popover data-mark-menu onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)onClose();return;}if(event.key==='Tab'){if(!busy)onClose();return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const options=[...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]:not(:disabled)')??[])];const active=options.indexOf(document.activeElement as HTMLButtonElement),index=event.key==='Home'?0:event.key==='End'?options.length-1:(active+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[index]?.focus();}}><p className={m.menuHeading}>Отметка</p><button type="button" role="menuitemcheckbox" aria-checked={!values.length} className={m.option} disabled={busy} onClick={()=>preserveSelected||values.length?onChoose([]):onClose()}><span>Без отметки</span>{!values.length&&<Glyph name="check"/>}</button>{Object.entries(decisionLabels).map(([value,title])=><button type="button" role="menuitemcheckbox" aria-label={title} title={decisionTitle(value as Decision)} key={value} className={m.option} disabled={busy} aria-checked={values.includes(value as Decision)} onClick={()=>onChoose(values.includes(value as Decision)?preserveSelected?values:values.filter(mark=>mark!==value):[...values,value as Decision])}><DecisionSymbol value={value as Decision}/><span>{title}</span>{values.includes(value as Decision)&&<Glyph name="check"/>}</button>)}{error&&<p role="alert" className={w.error}>{error}</p>}</div>,portal);
}
