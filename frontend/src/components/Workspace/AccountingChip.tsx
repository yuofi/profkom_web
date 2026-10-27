import { useQuery } from "@tanstack/react-query";
import type { AssignmentStatus, UnresolvedAssignment } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { can } from "../../utils/session";
import { canRetainData } from "../../utils/api/request";
import { getTaskRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { HoverCard } from "./HoverCard";
import { InteractiveChip } from "./InteractiveChip";
import s from "./AccountingChip.module.css";
const names: Record<AssignmentStatus, string> = {
  assigned: "Ожидает оценки", in_progress: "В работе", help_required: "Нужны уточнения", submitted: "Ожидает проверки",
  needs_revision: "На доработке", accepted: "Зачтено", not_completed: "Не выполнено", cancelled: "Исключено из ККР",
};
export function AccountingChip({ item }: { item: UnresolvedAssignment }) {
  const assignment = item.assignment;
  const to = `${getTaskRoute(item.task_id)}?assignment_id=${encodeURIComponent(assignment.assignment_id)}`;
  return <HoverCard content={() => <AccountingPreview item={item} />}>{({ describedBy, close }) => <InteractiveChip kind="link" to={to} className={s.chip} label={names[assignment.status]} ariaDescribedBy={describedBy} onClick={close} ariaLabel={`Учёт ККР: ${assignment.assignee.display_name} · ${names[assignment.status]}`} />}</HoverCard>;
}
function AccountingPreview({ item }: { item: UnresolvedAssignment }) {
  const assignment = item.assignment, allowed = can(assignment, "view_assessment_inputs");
  const query = useQuery({ queryKey: ["assessments", assignment.assignment_id], queryFn: () => tasksApi.assessment(assignment.assignment_id), enabled: allowed });
  if (!allowed || query.error && !canRetainData(query.error)) return <div className={s.preview}><strong>Учёт ККР недоступен</strong><p>Нет доступа к расчётным данным назначения.</p></div>;
  const data = query.data;
  return <div className={s.preview}><small>Учёт работы · ККР</small><strong>{data?.workflow_status ? names[data.workflow_status] : names[assignment.status]}</strong><p>{assignment.assignee.display_name}</p>
    {query.isLoading ? <p role="status">Загружаем учёт…</p> : data ? <><dl><div><dt>Часы</dt><dd>{data.hours ?? "Не заданы"}</dd></div><div><dt>Оценка</dt><dd>{data.evaluation ?? "Не выставлена"}</dd></div>{data.effective_completed_at && <div><dt>Дата работы</dt><dd>{displayDate(data.effective_completed_at)}</dd></div>}</dl><p className={s.hint}>Нажмите на чип, чтобы открыть оценку этого исполнителя в задаче.</p></> : <p>Не удалось загрузить расчётные данные.</p>}
  </div>;
}
