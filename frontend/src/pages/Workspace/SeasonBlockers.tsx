import { useState } from "react";
import type { SeasonBlocker } from "../../utils/api/contract";
import { SeasonBlockerLink } from "../../components/Workspace/SeasonBlockerLink";
import { plural } from "./seasonAnalyticsView";
import w from "../../components/Workspace/Workspace.module.css";
import u from "./SeasonWorkspace.module.css";

const groups: { kind: SeasonBlocker["kind"]; title: string }[] = [
  { kind: "previous_season_not_closed", title: "Не закрыт предыдущий сезон" },
  { kind: "unfinished_assignment", title: "Незавершённые назначения" },
  { kind: "missing_assessment", title: "Назначения без оценки" },
  { kind: "missing_final_report", title: "Нет итоговых отчётов" },
];
const PREVIEW = 10;

/** Close blockers by kind: a count per kind, its first items and the rest on request. */
export function SeasonBlockers({ blockers, seasonId }: { blockers: SeasonBlocker[]; seasonId: string }) {
  const known = new Set(groups.map(group => group.kind));
  const other = blockers.filter(blocker => !known.has(blocker.kind));
  return <div className={u.blockerGroups}>
    {groups.map(group => <BlockerGroup key={group.kind} title={group.title} items={blockers.filter(blocker => blocker.kind === group.kind)} seasonId={seasonId} />)}
    <BlockerGroup title="Другая незавершённая работа" items={other} seasonId={seasonId} />
  </div>;
}

function BlockerGroup({ title, items, seasonId }: { title: string; items: SeasonBlocker[]; seasonId: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const assignments = items.filter(item => item.owner_kind === "assignment");
  const tasks = new Set(assignments.map(item => item.task_id ?? item.subject ?? item.owner_id)).size;
  const shown = all ? items : items.slice(0, PREVIEW);
  return <section className={u.blockerGroup} aria-label={title}>
    <h3>{title} — {items.length}{assignments.length > 1 && tasks < assignments.length ? ` (в ${tasks} ${plural(tasks, "задаче", "задачах", "задачах")})` : ""}</h3>
    <ul className={w.list}>{shown.map((blocker, index) => <li key={`${blocker.owner_kind}:${blocker.owner_id}:${index}`}><SeasonBlockerLink blocker={blocker} seasonId={seasonId} /></li>)}</ul>
    {items.length > PREVIEW && <button type="button" className={u.tableAction} aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? "Свернуть" : `Показать все (${items.length})`}</button>}
  </section>;
}
