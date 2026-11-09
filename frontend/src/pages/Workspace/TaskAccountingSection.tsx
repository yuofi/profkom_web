import { useQuery } from "@tanstack/react-query";
import type { Task } from "../../utils/api/contract";
import { kkrApi } from "../../utils/api/kkr.api";
import { canRetainData } from "../../utils/api/request";
import { accountingSummary } from "../../utils/kkrAccounting";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerTaskDetail.module.css";

/**
 * «Учёт работы и ККР» on a closed task (owner A2): what is entered so far in one line and «Оценить работу»
 * across the section. The line reads the KKR window's own batch, so a save in the window updates it at once.
 */
export function TaskAccountingSection({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const batch = useQuery({ queryKey: ["accounting-batch", task.task_id], queryFn: () => kkrApi.batch(task.task_id) });
  // A refusal of access drops the private values instead of showing the cached ones.
  const data = batch.error && !canRetainData(batch.error) ? undefined : batch.data;
  return <section className={s.accounting} aria-label="Учёт работы и ККР">
    <div className={s.sectionHeading}><h2>Учёт работы и ККР</h2></div>
    {data && <p className={s.accountingSummary}>{accountingSummary(data)}</p>}
    <button type="button" className={`${w.button} ${w.primary} ${s.accountingOpen}`} onClick={onOpen}>Оценить работу</button>
  </section>;
}
