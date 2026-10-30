import type { ReactNode } from "react";
import type { Decision, SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { Badge } from "../../components/Workspace/WorkspaceUI";
import { UserChip } from "../../components/Workspace/UserChip";
import { decisionLabels, decisionTitle } from "../../utils/decisions";
import s from "../../components/Workspace/Workspace.module.css";
import u from "./SeasonWorkspace.module.css";

const decisionSymbols: Record<Decision, ReactNode> = {
  golden_red_bull: <><rect x="11" y="4" width="18" height="32" rx="5" fill="#f3c65b" /><path d="M14 9h12M14 31h12" stroke="#74602c" strokeWidth="2" /><path d="m22 12-8 11h7l-2 7 9-12h-7l1-6Z" fill="#352d19" /></>,
  kick_warning: <><path d="m17 6-14 25a3 3 0 0 0 3 4h28a3 3 0 0 0 3-4L23 6a3.5 3.5 0 0 0-6 0Z" fill="#f4ad69" /><path d="M20 14v10M20 29v.2" stroke="#3c291d" strokeWidth="3" strokeLinecap="round" /></>,
  kick: <><rect x="5" y="4" width="28" height="32" rx="4.5" fill="#ef8590" /><circle cx="14" cy="13" r="4" fill="#542e39" /><path d="M8 25v-2a6 6 0 0 1 12 0v2H8Z" fill="#542e39" /><path d="M24 11h4M24 16h4" stroke="#542e39" strokeWidth="2" strokeLinecap="round" /><circle cx="30" cy="29" r="9" fill="#171911" /><circle cx="30" cy="29" r="7.3" fill="#ef8590" /><path d="m27 26 6 6m0-6-6 6" stroke="#542e39" strokeWidth="2.7" strokeLinecap="round" /></>,
  nice: <><path d="M5 4h19v6H11v21h13v6H5V4Z" fill="#a6bff2" /><path d="M19 21h18m-7-7 7 7-7 7" stroke="#a6bff2" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /><circle cx="14.5" cy="20" r="1.2" fill="#a6bff2" /></>,
};
export function DecisionSymbol({value}:{value:Decision}) {
 return <svg viewBox="0 0 40 40" width="24" height="24" fill="none" aria-hidden="true" focusable="false">{decisionSymbols[value]}</svg>;
}
export function DecisionBadges({ values }: { values: Decision[] }) {
  return values.length ? <span className={u.decisionIcons}>{values.map(d=><span key={d} role="img" aria-label={decisionLabels[d]} title={decisionTitle(d)} className={u.decisionIcon}><DecisionSymbol value={d}/><span className={u.srOnly}>{decisionLabels[d]}</span></span>)}</span> : <span>Нет отметок</span>;
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
      <td className={u.decisionCell}>{renderDecisions?.(row)??<div aria-label="Решения текущего сезона"><DecisionBadges values={row.decisions} /></div>}</td>
      <td className={u.decisionCell}><DecisionBadges values={row.previous_decisions} /></td>
    </tr>)}</tbody>
  </table>{!shown.length && <p className={u.empty}>Участники не найдены.</p>}</div>;
}
