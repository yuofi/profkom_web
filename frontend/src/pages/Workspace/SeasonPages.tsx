import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { QueryState, Empty, Glyph, Card } from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import { UserChip } from "../../components/Workspace/UserChip";
import { SeasonBlockerLink } from "../../components/Workspace/SeasonBlockerLink";
import { seasonsApi } from "../../utils/api/seasons.api";
import { normalizeApiError } from "../../utils/api/request";
import { can, useSession } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { getSeasonRoute, getSeasonCreateRoute, getKkrTemplatesRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import type { Decision, Season, SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { decisionLabels } from "../../utils/decisions";
import { SeasonEditor } from "./SeasonEditor";
import { SeasonParticipants } from "./SeasonParticipants";
import { SeasonAnalytics, AnalyticsMetrics } from "./SeasonAnalytics";
import { analyticsKey, sourceNames, metricValue } from "./seasonAnalyticsView";
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

export function SeasonsPage() {
  const { session } = useSession();const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const ordered = [...(query.data?.items ?? [])].sort((a, b) => b.sequence_number - a.sequence_number);const current = ordered.find(season => season.is_current);const other = ordered.filter(season => season.season_id !== current?.season_id);
  return <section className={u.page}><BrandedHeader className={u.header}><div><SectionHomeLink to="/seasons" label="Учёт работы" /><h1 className={w.title}>Сезоны и ККР</h1><p className={w.description}>Работа участников, начисления и итоги — в контексте выбранного сезона.</p></div><div className={w.row}><Link className={w.button} to={getKkrTemplatesRoute()}><Glyph name="description" />Шаблоны ККР</Link>{can(session, "open_season") && <Link className={`${u.primary} ${w.button}`} to={getSeasonCreateRoute()}><Glyph name="add" />Создать сезон</Link>}</div></BrandedHeader>
    <QueryState loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>
      {current && <section className={u.current} aria-label="Текущий сезон"><div><p className={u.eyebrow}>Текущий сезон</p><h2>{current.title}</h2><p>{dateRange(current)}</p><div className={u.statusLine}><State season={current} /><small>{typeNames[current.type]}</small></div></div><Link className={u.primary} to={getSeasonRoute(current.season_id)}>Открыть сезон <span aria-hidden="true">→</span></Link></section>}
      <section className={u.stack}><div className={u.sectionHeading}><h2>{current ? "Другие сезоны" : "Все сезоны"}</h2><small>{other.length} сезонов</small></div><div className={u.seasonList}>{other.map(season => <Link key={season.season_id} className={u.seasonRow} to={getSeasonRoute(season.season_id)}><div><h3>{season.title}</h3><p>{typeNames[season.type]}</p></div><span className={u.seasonDates}>{dateRange(season)}</span><State season={season} /><span aria-hidden="true">↗</span></Link>)}</div>{!other.length && <Empty>{current ? "Других сезонов пока нет." : "Сезонов пока нет. Создайте первый сезон, чтобы начать учёт работы."}</Empty>}</section>
    </QueryState>
  </section>;
}
export function KkrTemplatesPage() {
  return <section className={u.page}><BrandedHeader className={u.header}><div><SectionHomeLink to="/seasons" label="Учёт работы" /><h1 className={w.title}>Шаблоны ККР</h1><p className={w.description}>Личные и командные заготовки для учёта работы. Применение шаблона заполняет черновик.</p></div><Link to="/seasons" className={w.button}><Glyph name="arrow_back" />Сезоны и ККР</Link></BrandedHeader>
    <Card><UnsavedChangesScope><KkrTemplateLibrary embedded /></UnsavedChangesScope></Card>
  </section>;
}
export function SeasonCreatePage() {
  const { session } = useSession();return can(session, "open_season") ? <UnsavedChangesScope><SeasonEditor /></UnsavedChangesScope> : <section className={u.page}><h1>Новый сезон</h1><Empty>Создание сезона доступно председателю.</Empty><Link to="/seasons" className={u.secondary}>Все сезоны</Link></section>;
}
function SeasonCommand({ season, action, label }: { season: Season; action: "open" | "begin-summary" | "close"; label: string }) {
  const { perform, refresh } = useWorkspaceActions();const [failure, setFailure] = useState<ReturnType<typeof normalizeApiError> | null>(null);
  return <div><ActionForm revision={season.revision} record={`season:${season.season_id}`} onConflict={refresh} fields={[]} submitLabel={label} allowExitSave={false} onSubmit={async (_, expectedRevision) => {
    setFailure(null);try { const saved = await perform(() => seasonsApi.command(season.season_id, action, { expected_revision: expectedRevision! }));return "season" in saved ? saved.season : saved; } catch (error) { setFailure(normalizeApiError(error));throw error; }
  }} />{failure?.blockers.length ? <ul className={w.list} aria-label="Препятствия закрытию">{failure.blockers.map((blocker, index) => <li key={index}><SeasonBlockerLink blocker={blocker} seasonId={season.season_id} /></li>)}</ul> : null}</div>;
}
type Tab = "overview" | "participants" | "analytics" | "history";
const tabs = [{ id: "overview", title: "Обзор", icon: "space_dashboard" }, { id: "participants", title: "Участники и ККР", icon: "groups" }, { id: "analytics", title: "Аналитика", icon: "insights" }, { id: "history", title: "История", icon: "sync" }] as const;
export function SeasonPage() { return <SeasonHub />; }
/** Existing summary links enter the same workspace on its participants tab. */
export function SummaryPage() { return <SeasonHub initialTab="participants" />; }
function SeasonHub({ initialTab = "overview" }: { initialTab?: Tab }) {
  const { id = "" } = useParams(), { session } = useSession();const [params] = useSearchParams();const [editing, setEditing] = useState(false);
  const allowed = can(session, "view_summary");const selected = params.get("tab") ?? initialTab;const tab = tabs.some(tab => tab.id === selected) ? selected as Tab : "overview";
  const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });const season = query.data?.items.find(season => season.season_id === id);
  const summary = useQuery({ queryKey: ["summary", id], queryFn: () => seasonsApi.summary(id), enabled: allowed });
  if (editing && season) return <UnsavedChangesScope><SeasonEditor key={id} season={season} onClose={() => setEditing(false)} /></UnsavedChangesScope>;
  return <section className={u.page}>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => void query.refetch()}>{season ? <>
      <BrandedHeader className={u.header}><div><SectionHomeLink to="/seasons" label="Учёт работы" /><nav className={u.breadcrumbs} aria-label="Путь сезона"><Link to="/seasons">Сезоны</Link><span>›</span><span>{typeNames[season.type]}</span></nav><h1 className={w.title}>{season.title}</h1><div className={u.period}><span>{dateRange(season)}</span>{can(season, "edit_season") && <button type="button" className={u.iconButton} aria-label="Редактировать сезон" onClick={() => setEditing(true)}><Glyph name="edit" /></button>}</div><div className={u.statusLine}><State season={season} />{season.is_current && <small>Текущий сезон</small>}{allowed && summary.data && <small>{summary.data.state === "approved" ? "Итоги утверждены" : "Предварительные итоги"} · Версия {summary.data.version}</small>}</div></div>
        {season.capabilities.some(cap => ["open_season", "begin_summary", "close_season", "edit_season"].includes(cap)) && <details className={u.manage}><summary className={`${u.secondary} ${w.button}`}>Управление сезоном <Glyph name="expand_more" /></summary><div className={u.manageMenu}>{can(season, "edit_season") && <button type="button" className={u.secondary} onClick={() => setEditing(true)}><Glyph name="edit" />Название и период</button>}{can(season, "open_season") && <SeasonCommand season={season} action="open" label="Открыть и сделать текущим" />}{can(season, "begin_summary") && <SeasonCommand season={season} action="begin-summary" label="Начать подведение итогов" />}{can(season, "close_season") && <SeasonCommand season={season} action="close" label="Закрыть сезон" />}</div></details>}
      </BrandedHeader>
      {allowed && <nav className={u.tabs} aria-label="Разделы сезона">{tabs.map(item => <Link key={item.id} to={`${getSeasonRoute(id)}${item.id === "overview" ? "" : `?tab=${item.id}`}`} aria-current={tab === item.id ? "page" : undefined}><Glyph name={item.icon} />{item.title}</Link>)}</nav>}
      {tab === "overview" || !allowed ? <SeasonOverview season={season} summary={summary.data} allowed={allowed} /> : tab === "participants" ? <QueryState loading={summary.isLoading} error={summary.error} keepDataOnError={!!summary.data} retry={() => void summary.refetch()}>{summary.data && <UnsavedChangesScope><SeasonDecisionEditors key={summary.data.season_id} summary={summary.data} /></UnsavedChangesScope>}</QueryState> : tab === "analytics" ? <SeasonAnalytics key={id} seasonId={id} /> : <section className={u.stack}><div className={u.sectionHeading}><h2>История итогов</h2></div><SummaryHistory key={id} seasonId={id} /></section>}
      <HistoryDisclosure kind="season" id={id} title="История названия и периода сезона" />
    </> : !query.isLoading && <Empty>Сезон недоступен.</Empty>}</QueryState>
  </section>;
}
function SeasonOverview({ season, summary, allowed }: { season: Season; summary?: SeasonSummary; allowed: boolean }) {
  const { session } = useSession();const id = season.season_id;
  const analytics = useQuery({ queryKey: analyticsKey(id), queryFn: () => seasonsApi.analytics(id), enabled: allowed });
  const bonuses = useQuery({ queryKey: ["masterBonuses", id], queryFn: () => seasonsApi.bonuses(id), enabled: allowed });
  const readiness = useQuery({ queryKey: ["seasons", "readiness", id], queryFn: () => seasonsApi.readiness(id), enabled: allowed && ["open", "summarizing"].includes(season.state) });
  const scores = analytics.data?.source_breakdown ?? [], maximum = Math.max(1, ...scores.map(source => Math.abs(source.kkr ?? 0)));
  return <div className={u.stack}>
    {allowed && ["open", "summarizing"].includes(season.state) && <section className={u.panel} aria-label="Готовность к закрытию"><h2>Готовность к закрытию</h2><QueryState loading={readiness.isLoading} error={readiness.error} retry={() => void readiness.refetch()}>{readiness.data && (readiness.data.ready ? <p>Препятствий для закрытия нет.</p> : <ul className={w.list}>{readiness.data.blockers.map((blocker, index) => <li key={`${blocker.owner_kind}:${blocker.owner_id}:${index}`}><SeasonBlockerLink blocker={blocker} seasonId={id} /></li>)}</ul>)}</QueryState></section>}
    {allowed && <QueryState loading={analytics.isLoading} error={analytics.error} retry={() => void analytics.refetch()}>{analytics.data && <><AnalyticsMetrics totals={analytics.data.totals} />{analytics.data.coverage.notes.length > 0 && <p className={u.coverageLine}>{analytics.data.coverage.notes[0]}</p>}</>}</QueryState>}
    <div className={u.overviewColumns}><section className={u.panel}><div className={u.panelHeader}><h2>Работа сезона</h2></div><p>Задачи, результаты и мероприятия этого периода.</p><div className={u.actions}><Link className={u.secondary} to={`/tasks?season_id=${encodeURIComponent(id)}&mine=false`}>Задачи сезона <span aria-hidden="true">→</span></Link><Link className={u.secondary} to="/events">Мероприятия <span aria-hidden="true">→</span></Link>{["create_volunteer_merit", "create_head_merit", "create_chair_merit", "view_summary"].some(cap => can(session, cap)) && <Link className={u.secondary} to={`/seasons/${encodeURIComponent(id)}/merits`}>Заслуги и волонтёрство <span aria-hidden="true">→</span></Link>}</div><p className={u.note}>{season.state === "closed" ? "Итоги сезона сохранены. Правки исходных полей выполняются у соответствующей задачи; прежние версии остаются в истории." : "Статус задачи отражает ход работы. Начисления ККР появляются после отдельного расчётного решения уполномоченного руководителя."}</p></section>
      {allowed && <section className={u.panel}><div className={u.panelHeader}><h2>Источники ККР</h2><Link to={`/seasons/${encodeURIComponent(id)}/sources`}>Все начисления →</Link></div>{scores.length ? scores.map(source => <div className={u.source} key={source.source_kind}><div><span>{sourceNames[source.source_kind]}</span><strong>{metricValue(source.kkr)}</strong></div><div className={u.track}><span data-negative={(source.kkr ?? 0) < 0} style={{ width: `${Math.abs(source.kkr ?? 0) / maximum * 100}%` }} /></div></div>) : <p className={u.note}>{analytics.isLoading ? "Загружаем начисления…" : "Учтённых начислений пока нет."}</p>}</section>}
    </div>
    {allowed && summary && <section className={u.panel}><div className={u.panelHeader}><h2>Участники сезона</h2><Link to={`${getSeasonRoute(id)}?tab=participants`}>Все участники и ККР →</Link></div>{[...summary.rows].sort((a, b) => a.rank - b.rank).slice(0, 5).map(row => <div key={row.participant_id} className={u.personRank}><span>{row.rank}</span><UserChip user={row.user} /><strong>{metricValue(row.total_score)}</strong></div>)}{!summary.rows.length && <Empty>Участников с расчётными данными пока нет.</Empty>}</section>}
    {allowed && <section className={u.panel}><details><summary>Бонусы мастеров и основания расчёта</summary><QueryState loading={bonuses.isLoading} error={bonuses.error}>{bonuses.data?.items.map(bonus => <details className={w.details} key={bonus.bonus_id}><summary>{bonus.recipient?.display_name ?? "Мастер не назначен"} · {bonus.amount.toFixed(2)} ККР · учитываемых организаторов {bonus.eligible_organizer_count}</summary><p className={u.note}>Версия расчёта: {bonus.calculation_version}</p><Link to={`/blocks/${encodeURIComponent(bonus.block_id)}`} className={u.tableAction}>Блок — источник бонуса →</Link><ul className={u.coverage}>{bonus.basis.map(member => <li key={member.participant_id}>{member.user.display_name}: {metricValue(member.member_task_score)} — {member.included ? "включён" : member.exclusion === "master" ? "исключён как мастер" : "исключён: неположительный вклад"}</li>)}</ul></details>)}{bonuses.data?.items.length === 0 && <Empty>Бонусов в этом сезоне нет.</Empty>}</QueryState></details></section>}
  </div>;
}
function SeasonDecisionEditors({ summary }: { summary: SeasonSummary }) {
  const [active, setActive] = useState<string | null>(null);const guardEditor = useGuardedAction();
  return <SeasonParticipants summary={summary} onFilterApply={() => setActive(null)} renderDecisions={row => can(summary, "edit_decisions") && row.user.user_id !== null ? <DecisionsForm row={row} summary={summary} open={active === row.participant_id}
    onToggleEditor={() => { const next = active === row.participant_id ? null : row.participant_id;guardEditor(() => setActive(next)); }} /> : null} />;
}
function DecisionsForm({ summary, row, open, onToggleEditor }: { summary: SeasonSummary; row: SummaryRow; open: boolean; onToggleEditor: () => void }) {
  const { perform, refresh } = useWorkspaceActions();
  // A single scoped editor keeps registration/render work bounded. Closing or
  // switching a dirty editor is confirmed before its form can unmount.
  return <details open={open}><summary onClick={event => { event.preventDefault();onToggleEditor(); }}>Изменить отметки</summary>{open && <><p className={u.note}>Отметки сохраняют решение в сводной. Архивирование аккаунта выполняется отдельно.</p><ActionForm key={`${summary.season_id}/${row.user.user_id}`} revision={summary.version} record={`summary:${summary.season_id}`} fields={[{ name: "decisions", label: "Текущие отметки", type: "multi", confirmRemoval: false, value: row.decisions, options: Object.entries(decisionLabels).map(([value, label]) => ({ value, label })) }, { name: "reason", label: "Основание", required: true }]} onSubmit={async (values, revision) => perform(() => seasonsApi.decisions(summary.season_id, row.user.user_id!, { expected_version: revision!, decisions: values.decisions as Decision[], reason: text(values, "reason") }))} onConflict={refresh} /></>}</details>;
}
