import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { Decision, SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { QueryState, Empty } from "../../components/Workspace/WorkspaceUI";
import { UserChip } from "../../components/Workspace/UserChip";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { getTaskRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { userMessage } from "../../utils/api/messages";
import { decisionLabels } from "../../utils/decisions";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { SummaryTable } from "./SummaryTable";
import { metricValue, plural } from "./seasonAnalyticsView";
import u from "./SeasonWorkspace.module.css";
import w from "../../components/Workspace/Workspace.module.css";

const WIDE = "(min-width: 769px)";
export function SeasonParticipants({ summary, renderDecisions, onFilterApply }: { summary: SeasonSummary; renderDecisions?: (row: SummaryRow) => ReactNode; onFilterApply?: () => void }) {
  // A task opened from a participant's card returns with ?participant= and reopens that card.
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(""), [block, setBlock] = useState(""), [sort, setSort] = useState("rank"), [person, setPerson] = useState<SummaryRow | null>(() => summary.rows.find(row => row.participant_id === params.get("participant")) ?? null), [exportError, setExportError] = useState("");
  const closePerson = () => { setPerson(null);if (params.has("participant")) { const next = new URLSearchParams(params);next.delete("participant");setParams(next, { replace: true }); } };
  const [category, setCategory] = useState(""), [master, setMaster] = useState(""), [archived, setArchived] = useState(""), [mark, setMark] = useState<Decision | "" | "any" | "none">("");
  const guardFilter = useGuardedAction();
  // Open on a wide screen (the summary is hidden there); folded on a phone until asked for.
  const [filtersOpen, setFiltersOpen] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia(WIDE).matches);
  // «Порядок» is one element: in the first row of a wide screen, among the folded filters on a phone (D-07).
  const [wide, setWide] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia(WIDE).matches);
  // The wide layout has no summary to unfold them, so widening the window (rotation, split screen) opens them.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(WIDE);const sync = () => { setWide(query.matches);if (query.matches) setFiltersOpen(true); };
    query.addEventListener("change", sync);return () => query.removeEventListener("change", sync);
  }, []);
  const activeFilters = [block, category, master, archived, mark].filter(Boolean).length + (sort === "rank" ? 0 : 1);
  const updateFilter = <T extends string,>(current: T, next: T, update: Dispatch<SetStateAction<T>>) => { if (next !== current) guardFilter(() => { onFilterApply?.();update(next); }); };
  const blocks = [...new Map(summary.rows.flatMap(row => row.blocks.map(item => [item.block_id, item] as const))).values()];
  const rows = summary.rows.filter(row => (!block || row.blocks.some(item => item.block_id === block))
    && (!category || row.category === category)
    && (!master || row.is_master === (master === "true"))
    && (!archived || row.is_archived === (archived === "true"))
    && (!mark || (mark === "any" ? row.decisions.length > 0 : mark === "none" ? row.decisions.length === 0 : row.decisions.includes(mark))))
    .sort((a, b) => sort === "name" ? a.user.display_name.localeCompare(b.user.display_name, "ru") : sort === "score-asc" ? a.total_score - b.total_score || a.rank - b.rank : a.rank - b.rank);
  const order = <label className={wide ? u.barOrder : undefined}>Порядок<select aria-label="Порядок" value={sort} onChange={e => setSort(e.target.value)}><option value="rank">По месту в сводной</option><option value="score-asc">ККР по возрастанию</option><option value="name">По имени</option></select></label>;
  return <section className={u.stack} aria-label="Участники и ККР">
    {/* Two rows over the table: search, order, version and XLSX; then the filters. A phone puts the version line first (D-07). */}
    <div className={`${u.toolbar} ${u.participantsBar}`} aria-label="Фильтры участников"><label className={u.barSearch}>Поиск по имени или группе<input type="search" value={search} onChange={e => updateFilter(search, e.target.value, setSearch)} placeholder="Имя или группа" /></label>
      {wide && order}
      {/* «Предварительные итоги» are in the header; an approved summary keeps its date here. */}
      <div className={`${u.summaryMeta} ${u.barMeta}`}><p>{summary.state === "approved" && `Утверждено ${displayDate(summary.approved_at)} · `}Версия {summary.version} · {summary.rows.length} {plural(summary.rows.length, "участник", "участника", "участников")}</p><button type="button" className={u.secondary} onClick={async () => {
        setExportError("");try { const blob = await seasonsApi.export(summary.season_id);const url = URL.createObjectURL(blob);const link = document.createElement("a");link.href = url;link.download = `kkr-${summary.season_id}.xlsx`;link.click();setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { setExportError(userMessage(error)); }
      }}>Скачать XLSX</button></div>
      <details className={u.filterDisclosure} open={filtersOpen} onToggle={event => setFiltersOpen(event.currentTarget.open)}><summary>Фильтры{activeFilters > 0 && ` · ${activeFilters}`}</summary><div className={u.toolbar}><div><EntityPicker name="block" label="Блок" value={block} onChange={value => updateFilter(block, value, setBlock)} placeholder="Все блоки" options={[{ value: "", label: "Все блоки" }, ...blocks.map(item => ({ value: item.block_id, label: item.name, block: item }))]} /></div>
      <label>Категория<select name="category" value={category} onChange={e => updateFilter(category, e.target.value, setCategory)}><option value="">Все категории</option><option value="junior">Джуниоры</option><option value="activist">Активисты</option></select></label>
      <label>Мастера<select name="is_master" value={master} onChange={e => updateFilter(master, e.target.value, setMaster)}><option value="">Все участники</option><option value="true">Только мастера</option><option value="false">Кроме мастеров</option></select></label>
      <label>Архив аккаунта<select name="is_archived" value={archived} onChange={e => updateFilter(archived, e.target.value, setArchived)}><option value="">Все участники</option><option value="true">Уже исключён</option><option value="false">Действующие</option></select></label>
      <label>Отметки текущего сезона<select name="marks" value={mark} onChange={e => updateFilter(mark, e.target.value as typeof mark, setMark)}><option value="">Все отметки</option><option value="any">Есть отметки</option><option value="none">Без отметок</option>{Object.entries(decisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {!wide && order}</div></details></div>
    {exportError && <p role="alert" className={w.error}>{exportError}</p>}
    <SummaryTable summary={summary} rows={rows} filter={search} renderDecisions={renderDecisions} onParticipantSelect={setPerson} />
    <p className={u.note}>Кнопка «Начисления и работа» рядом с участником показывает его вклад и ведёт к учёту работы в задаче.</p>
    {person && <UnsavedChangesScope><TrackerTaskDialog title="Начисления участника" onClose={closePerson}><ParticipantWork seasonId={summary.season_id} person={person} /></TrackerTaskDialog></UnsavedChangesScope>}
  </section>;
}
function ParticipantWork({ seasonId, person }: { seasonId: string; person: SummaryRow }) {
  const { session } = useSession();const allowed = can(session, "view_kkr");
  // include_task_ids: each row names its task when the reader may open it (PF-06), so no task list is paged.
  const contributions = useQuery({ queryKey: ["assessments", "season-participant", seasonId, person.participant_id], queryFn: () => seasonsApi.assessments({ season_id: seasonId, participant_id: person.participant_id, include_task_ids: true }), enabled: allowed });
  if (!allowed) return <Empty>Нет доступа к расчётным данным.</Empty>;
  const items = contributions.data?.items.filter(item => item.participant_id === person.participant_id) ?? [];
  return <section className={u.stack}><div className={u.dialogIdentity}><UserChip user={person.user} /><strong className={u.score}>{metricValue(person.total_score)} ККР</strong></div><p className={u.note}>{person.group_number} · {person.blocks.map(item => item.name).join(", ") || "Без блока"}</p>
    <QueryState loading={contributions.isLoading} error={contributions.error} retry={() => void contributions.refetch()}><ul className={u.detailList}>{items.map(item => {
      const assignmentId = item.assignment_inputs?.assignment_id, taskId = item.assignment_inputs?.task_id;
      return <li key={item.contribution_id}><div className={u.panelHeader}><h3>{item.source_title}</h3><strong>{metricValue(item.score)} ККР</strong></div>{item.assignment_inputs && <p>Часы: {item.assignment_inputs.hours ?? "—"} · Оценка: {item.assignment_inputs.evaluation ?? "—"} · Выполнено: {displayDate(item.assignment_inputs.effective_completed_at)}</p>}{taskId && <Link to={`${getTaskRoute(taskId)}?assignment_id=${encodeURIComponent(assignmentId!)}&return_season=${encodeURIComponent(seasonId)}&return_to=participant&participant=${encodeURIComponent(person.participant_id)}`}>Открыть задачу и её учёт →</Link>}{item.merit_id && <Link to={`/seasons/${encodeURIComponent(seasonId)}/merits`}>Заслуги и волонтёрство сезона →</Link>}</li>;
    })}</ul>{!items.length && <Empty>Начислений участника в этом сезоне пока нет.</Empty>}</QueryState>
  </section>;
}
