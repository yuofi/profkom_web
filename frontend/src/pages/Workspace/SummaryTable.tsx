import type { ReactNode } from "react";
import type { Decision, SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { Badge } from "../../components/Workspace/WorkspaceUI";
import { UserChip } from "../../components/Workspace/UserChip";
import { decisionLabels } from "../../utils/decisions";
import s from "../../components/Workspace/Workspace.module.css";
import u from "./SeasonWorkspace.module.css";

const decisionPaths:Record<Decision,string>={
 golden_red_bull:"M9 3h6l1 4v13H8V7l1-4Zm-1 4h8M13 9l-3 5h3l-2 4 4-6h-3l1-3Z",
 kick_warning:"m12 3 10 18H2L12 3Zm0 6v5m0 3v1",
 kick:"M15 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-9 9v-2a5 5 0 0 1 10 0v2M17 4h6",
 nice:"M8 10v11H3V10h5Zm0 10h10a2 2 0 0 0 2-2l1-7a2 2 0 0 0-2-2h-6l1-6a1 1 0 0 0-2-1l-4 8",
};
export function DecisionBadges({ values }: { values: Decision[] }) {
  return values.length ? <div className={u.decisionIcons}>{values.map(d=><span key={d} role="img" aria-label={decisionLabels[d]} title={decisionLabels[d]} className={`${u.decisionIcon} ${s[d]}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={decisionPaths[d]}/></svg><span className={u.srOnly}>{decisionLabels[d]}</span></span>)}</div> : <span>Нет отметок</span>;
}

export function SummaryTable({ summary, filter = "", rows, renderDecisions, onParticipantSelect }: {
  summary: SeasonSummary; filter?: string; rows?: SummaryRow[]; renderDecisions?: (row: SummaryRow) => ReactNode; onParticipantSelect?: (row: SummaryRow) => void;
}) {
  const shown = (rows ?? summary.rows).filter(row => `${row.user.display_name} ${row.group_number}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <div className={u.summaryWrap} tabIndex={0} role="region" aria-label="Сезонная сводная, горизонтальная прокрутка"><table className={u.summaryTable}>
    <thead><tr>{["Место", "Участник", "ККР блоков", "ККР мероприятий", "Всего", "Отметки", "Прошлые отметки"].map(name => <th key={name} scope="col">{name}</th>)}</tr></thead>
    <tbody>{shown.map(row => <tr key={row.participant_id}>
      <td><div className={u.rank}><strong>{row.rank}</strong><span>Ранее: {row.previous_rank ?? "—"}</span></div></td>
      <td><UserChip user={row.user} /><p><small>{row.group_number} · {row.category === "junior" ? "Джуниор" : "Активист"}</small></p><div className={s.row}>{row.is_archived && <Badge tone="rose">Уже исключён</Badge>}{row.is_master && <Badge tone="yellow">Мастер</Badge>}</div>{onParticipantSelect ? <button type="button" className={u.tableAction} onClick={() => onParticipantSelect(row)}>Начисления и работа →</button> : <details className={u.sourceDetails}><summary>Источники начислений</summary>{row.source_scores.map((source, i) => <p key={`${source.source_id}-${i}`}>{source.title}: {source.score.toFixed(2)}</p>)}</details>}</td>
      <td>{row.source_scores.filter(source => ['block_task','block_volunteer','master_bonus','chair_task','chair_merit'].includes(source.source_kind)).reduce((sum,source)=>sum+source.score,0).toFixed(2)}</td>
      <td>{row.source_scores.filter(source => ['subevent_task','subevent_volunteer','event_task','head_merit'].includes(source.source_kind)).reduce((sum,source)=>sum+source.score,0).toFixed(2)}</td>
      <td><span className={u.score} data-negative={row.total_score < 0}>{row.total_score.toFixed(2)}</span></td>
      <td className={u.decisionCell}><div aria-label="Решения текущего сезона"><DecisionBadges values={row.decisions} /></div>{renderDecisions?.(row)}</td>
      <td className={u.decisionCell}><DecisionBadges values={row.previous_decisions} /></td>
    </tr>)}</tbody>
  </table>{!shown.length && <p className={u.empty}>Участники не найдены.</p>}</div>;
}
