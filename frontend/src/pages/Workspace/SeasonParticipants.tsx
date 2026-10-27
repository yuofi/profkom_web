import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import type { SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { QueryState, Empty } from "../../components/Workspace/WorkspaceUI";
import { UserChip } from "../../components/Workspace/UserChip";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { getTaskRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { userMessage } from "../../utils/api/messages";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { SummaryTable } from "./SummaryTable";
import u from "./SeasonWorkspace.module.css";
import w from "../../components/Workspace/Workspace.module.css";

export function SeasonParticipants({ summary, renderDecisions }: { summary: SeasonSummary; renderDecisions?: (row: SummaryRow) => ReactNode }) {
  const [search, setSearch] = useState(""), [block, setBlock] = useState(""), [sort, setSort] = useState("rank"), [person, setPerson] = useState<SummaryRow | null>(null), [exportError, setExportError] = useState("");
  const blocks = [...new Map(summary.rows.flatMap(row => row.blocks.map(item => [item.block_id, item] as const))).values()];
  const rows = summary.rows.filter(row => !block || row.blocks.some(item => item.block_id === block)).sort((a, b) => sort === "name" ? a.user.display_name.localeCompare(b.user.display_name, "ru") : sort === "score-asc" ? a.total_score - b.total_score || a.rank - b.rank : a.rank - b.rank);
  return <section className={u.stack} aria-label="Участники и ККР">
    <div className={u.summaryMeta}><p>{summary.state === "approved" ? `Утверждено ${displayDate(summary.approved_at)}` : "Предварительные итоги"} · Версия {summary.version} · Участников {summary.rows.length}</p><button type="button" className={u.secondary} onClick={async () => {
      setExportError("");try { const blob = await seasonsApi.export(summary.season_id);const url = URL.createObjectURL(blob);const link = document.createElement("a");link.href = url;link.download = `kkr-${summary.season_id}.xlsx`;link.click();setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { setExportError(userMessage(error)); }
    }}>Скачать XLSX</button></div>
    {exportError && <p role="alert" className={w.error}>{exportError}</p>}
    <div className={u.toolbar}><label>Поиск по имени или группе<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Имя или группа" /></label><div><EntityPicker label="Блок" value={block} onChange={setBlock} placeholder="Все блоки" options={[{ value: "", label: "Все блоки" }, ...blocks.map(item => ({ value: item.block_id, label: item.name, block: item }))]} /></div><label>Порядок<select aria-label="Порядок" value={sort} onChange={e => setSort(e.target.value)}><option value="rank">По месту в сводной</option><option value="score-asc">ККР по возрастанию</option><option value="name">По имени</option></select></label></div>
    <SummaryTable summary={summary} rows={rows} filter={search} renderDecisions={renderDecisions} onParticipantSelect={setPerson} />
    <p className={u.note}>Оценённые назначения включают работу с нулевой и отрицательной оценкой. Это количество личных расчётных записей, а не число выполненных задач.</p>
    {person && <UnsavedChangesScope><TrackerTaskDialog title="Начисления участника" onClose={() => setPerson(null)}><ParticipantWork seasonId={summary.season_id} person={person} /></TrackerTaskDialog></UnsavedChangesScope>}
  </section>;
}
function ParticipantWork({ seasonId, person }: { seasonId: string; person: SummaryRow }) {
  const { session } = useSession();const allowed = can(session, "view_kkr");
  const contributions = useQuery({ queryKey: ["assessments", "season-participant", seasonId], queryFn: () => seasonsApi.assessments({ season_id: seasonId }), enabled: allowed });
  const tasks = useQuery({ queryKey: ["tasks", "accounting-links", seasonId], queryFn: () => tasksApi.list({ season_id: seasonId, mine: false }), enabled: allowed });
  if (!allowed) return <Empty>Нет доступа к расчётным данным.</Empty>;
  const items = contributions.data?.items.filter(item => item.participant_id === person.participant_id) ?? [];
  return <section className={u.stack}><div className={u.dialogIdentity}><UserChip user={person.user} /><strong className={u.score}>{person.total_score.toFixed(2)} ККР</strong></div><p className={u.note}>{person.group_number} · {person.blocks.map(item => item.name).join(", ") || "Без блока"}</p>
    <QueryState loading={contributions.isLoading} error={contributions.error} retry={() => void contributions.refetch()}><ul className={u.detailList}>{items.map(item => {
      const assignmentId = item.assignment_inputs?.assignment_id;const task = tasks.data?.items.find(task => task.assignments.some(a => a.assignment_id === assignmentId));
      return <li key={item.contribution_id}><div className={u.panelHeader}><h3>{item.source_title}</h3><strong>{item.score?.toFixed(2) ?? "—"} ККР</strong></div>{item.assignment_inputs && <p>Часы: {item.assignment_inputs.hours ?? "—"} · Оценка: {item.assignment_inputs.evaluation ?? "—"} · Выполнено: {displayDate(item.assignment_inputs.effective_completed_at)}</p>}{task && <Link to={`${getTaskRoute(task.task_id)}?assignment_id=${encodeURIComponent(assignmentId!)}&return_season=${encodeURIComponent(seasonId)}`}>Открыть задачу и её учёт →</Link>}{item.merit_id && <Link to={`/seasons/${encodeURIComponent(seasonId)}/merits`}>Заслуги и волонтёрство сезона →</Link>}<p className={u.note}>Формула: {item.calculation_version}</p></li>;
    })}</ul>{!items.length && <Empty>Начислений участника в этом сезоне пока нет.</Empty>}</QueryState>
    {tasks.error && <p className={u.note}>Ссылки на задачи недоступны. Начисления показаны выше.</p>}
  </section>;
}
