import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import { seasonsApi } from "../../utils/api/seasons.api";
import { can, useSession } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { SummaryTable } from "./SummaryTable";
import s from "../../components/Workspace/Workspace.module.css";
import u from "./SeasonWorkspace.module.css";
import { UserChip } from "../../components/Workspace/UserChip";

export function SummaryHistory({ seasonId }: { seasonId: string }) {
  const { session } = useSession();
  const allowed = can(session, "view_summary");
  const [selection, setSelection] = useState("");
  const versions = useQuery({
    queryKey: ["summaryVersions", seasonId],
    queryFn: () => seasonsApi.summaryVersions(seasonId), enabled: allowed,
  });
  const snapshot = useQuery({
    queryKey: ["summaryVersions", seasonId, selection],
    queryFn: () => seasonsApi.summaryVersion(seasonId, Number(selection)),
    enabled: allowed && !!selection,
  });
  if (!allowed) return null;
  const historical = snapshot.data;
  const participant = (id: string) => historical?.summary.rows.find(r => r.participant_id === id)?.user.display_name ?? "Участник";
  return <section className={u.panel}><h2>Версии сводной</h2>
    <p className={u.note}>Сохранённые версии доступны только для чтения. Действующие итоги — на вкладке «Участники и ККР».</p>
    <QueryState loading={versions.isLoading} error={versions.error} retry={() => { void versions.refetch(); }}>
      {versions.data?.items.length ? <label className={s.field}>
        Версия итогов
        <select value={selection} onChange={e => setSelection(e.target.value)}>
          <option value="">Выберите сохранённую версию</option>
          {versions.data.items.map(v => <option key={v.version} value={String(v.version)}>
            Версия {v.version} · {displayDate(v.changed_at)} · {v.changed_by.display_name}
          </option>)}
        </select>
      </label> : <Empty>Сохранённых версий пока нет.</Empty>}
      {selection && <QueryState loading={snapshot.isLoading} error={snapshot.error} retry={() => { void snapshot.refetch(); }}>
        {historical && <section aria-label="Историческая сводная" className={s.stack}>
          <div>
            <h3>Историческая версия {historical.version}</h3>
            <div className={u.statusLine}><UserChip user={historical.changed_by} /><span>{displayDate(historical.changed_at)}</span></div>
            <p>Основание: {historical.reason}</p>
            {historical.previous_summary_version !== null && <p>Версия итогов предыдущего сезона: {historical.previous_summary_version}</p>}
          </div>
          <SummaryTable summary={historical.summary} />
          <details className={s.details}>
            <summary>Источники начислений сохранённой версии</summary>
            <ul className={s.list}>{historical.contributions.map(c => <li key={c.contribution_id}>
              {participant(c.participant_id)} · {c.source_title}: {c.score?.toFixed(2) ?? "—"}
              <span className={s.muted}> · Формула: {c.calculation_version}</span>
            </li>)}</ul>
            {!historical.contributions.length && <Empty>Начислений в этой версии нет.</Empty>}
          </details>
          <details className={s.details}>
            <summary>Бонусы мастеров сохранённой версии</summary>
            {historical.master_bonuses.map(b => <div key={b.bonus_id}>
              <p>{b.recipient_participant_id ? participant(b.recipient_participant_id) : "Мастер не назначен"}: {b.amount.toFixed(2)} · {b.calculation_version}</p>
              <ul>{b.basis.map(m => <li key={m.participant_id}>
                {m.user.display_name}: {m.member_task_score} — {m.included ? "включён" : m.exclusion === "master" ? "исключён как мастер" : "исключён: неположительный вклад"}
              </li>)}</ul>
            </div>)}
            {!historical.master_bonuses.length && <Empty>Бонусов в этой версии нет.</Empty>}
          </details>
        </section>}
      </QueryState>}
    </QueryState>
  </section>;
}
