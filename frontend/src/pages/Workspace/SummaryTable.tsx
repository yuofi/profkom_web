import type { ReactNode } from "react";
import type { Decision, SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { Badge } from "../../components/Workspace/WorkspaceUI";
import { UserChip } from "../../components/Workspace/UserChip";
import { decisionLabels } from "../../utils/decisions";
import s from "../../components/Workspace/Workspace.module.css";
import u from "./SeasonWorkspace.module.css";

export function DecisionBadges({ values }: { values: Decision[] }) {
  return values.length ? <div className={s.row}>{values.map(d => <span key={d} className={`${s.decision} ${s[d]}`}>{decisionLabels[d]}</span>)}</div> : <span>Нет отметок</span>;
}
export function SummaryTable({ summary, filter = "", rows, renderDecisions, onParticipantSelect }: {
  summary: SeasonSummary; filter?: string; rows?: SummaryRow[]; renderDecisions?: (row: SummaryRow) => ReactNode; onParticipantSelect?: (row: SummaryRow) => void;
}) {
  const shown = (rows ?? summary.rows).filter(row => `${row.user.display_name} ${row.group_number}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <div className={u.summaryWrap} tabIndex={0} role="region" aria-label="Сезонная сводная, горизонтальная прокрутка"><table className={u.summaryTable}>
    <thead><tr>{["Место", "Участник", "Блоки", "ККР", "Оценённых назначений", "Отметки"].map(name => <th key={name} scope="col">{name}</th>)}</tr></thead>
    <tbody>{shown.map(row => <tr key={row.participant_id}>
      <td><div className={u.rank}><strong>{row.rank}</strong><span>Ранее: {row.previous_rank ?? "—"}</span></div></td>
      <td><UserChip user={row.user} /><p><small>{row.group_number} · {row.category === "junior" ? "Джуниор" : "Активист"}</small></p><div className={s.row}>{row.is_archived && <Badge tone="rose">Уже исключён</Badge>}{row.is_master && <Badge tone="yellow">Мастер</Badge>}</div>{onParticipantSelect ? <button type="button" className={u.tableAction} onClick={() => onParticipantSelect(row)}>Начисления и работа →</button> : <details className={u.sourceDetails}><summary>Источники начислений</summary>{row.source_scores.map((source, i) => <p key={`${source.source_id}-${i}`}>{source.title}: {source.score.toFixed(2)}</p>)}</details>}</td>
      <td>{row.blocks.map(block => block.name).join(", ") || "—"}</td>
      <td><span className={u.score} data-negative={row.total_score < 0}>{row.total_score.toFixed(2)}</span></td>
      <td>{row.evaluated_task_count}</td>
      <td className={u.decisionCell}><div aria-label="Решения текущего сезона"><DecisionBadges values={row.decisions} /></div>{row.previous_decisions.length > 0 && <details><summary>Отметки прошлого сезона</summary><DecisionBadges values={row.previous_decisions} /></details>}{renderDecisions?.(row)}</td>
    </tr>)}</tbody>
  </table>{!shown.length && <p className={u.empty}>Участники не найдены.</p>}</div>;
}
