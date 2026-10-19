import type { ReactNode } from "react";
import type { Decision, SeasonSummary, SummaryRow } from "../../utils/api/contract";
import { Badge } from "../../components/Workspace/WorkspaceUI";
import { decisionLabels } from "../../utils/decisions";
import s from "../../components/Workspace/Workspace.module.css";

export function DecisionBadges({ values }: { values: Decision[] }) {
  return values.length ? (
    <div className={s.row}>
      {values.map((d) => (
        <span key={d} className={`${s.decision} ${s[d]}`}>
          {decisionLabels[d]}
        </span>
      ))}
    </div>
  ) : (
    <span>Нет отметок</span>
  );
}
export function SummaryTable({ summary, filter = "", renderDecisions }: {
  summary: SeasonSummary;
  filter?: string;
  renderDecisions?: (row: SummaryRow) => ReactNode;
}) {
  return (
    <div
      className={s.tableWrap}
      tabIndex={0}
      role="region"
      aria-label="Сезонная сводная, горизонтальная прокрутка"
    >
      <table className={`${s.table} ${s.summaryTable}`}>
        <thead>
          <tr>
            {[
              "Место / прошлое",
              "Участник",
              "Блоки",
              "Источники",
              "ККР / задач",
              "Отметки",
            ].map((x) => (
              <th key={x}>{x}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.rows
            .filter((row) =>
              `${row.user.display_name} ${row.group_number}`
                .toLowerCase()
                .includes(filter.toLowerCase()),
            )
            .map((row) => (
              <tr key={row.participant_id}>
                <td>
                  {row.rank} / {row.previous_rank ?? "—"}
                </td>
                <td>
                  {row.user.display_name}
                  <p className={s.muted}>
                    {row.group_number} ·{" "}
                    {row.category === "junior"
                      ? "Джуниор"
                      : "Активист"}
                  </p>
                  {row.is_archived && <Badge>Уже исключён</Badge>}
                  {row.is_master && <Badge>Мастер</Badge>}
                </td>
                <td>
                  {row.blocks.map((b) => b.name).join(", ") || "—"}
                </td>
                <td>
                  {row.source_scores.map((source, i) => (
                    <p key={i}>
                      {source.title}: {source.score.toFixed(2)}
                    </p>
                  ))}
                </td>
                <td>
                  {row.total_score.toFixed(2)} /{" "}
                  {row.evaluated_task_count}
                </td>
                <td>
                  <div aria-label="Решения текущего сезона">
                    <DecisionBadges values={row.decisions} />
                  </div>
                  <div aria-label="Решения прошлого сезона">
                    <p className={s.muted}>Ранее:</p>
                    <DecisionBadges
                      values={row.previous_decisions}
                    />
                  </div>
                  {renderDecisions?.(row)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
