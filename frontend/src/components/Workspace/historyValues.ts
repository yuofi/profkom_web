import { displayDate } from "../../utils/dates";
import { statusNames } from "../../pages/Workspace/trackerStatus";
import { taskPriorityNames, taskTypeNames } from "../../pages/Workspace/trackerPlanning";
import { criteriaLabels } from "../../utils/kkrCriteria";

const seasonStates: Record<string, string> = { planned: "Запланирован", open: "Открыт", summarizing: "Подведение итогов", closed: "Закрыт" };
const roleNames: Record<string, string> = { chair: "Председатель", deputy_chair: "Заместитель председателя", master: "Мастер", deputy_master: "Заместитель мастера", event_leader: "Главорг", deputy_event_leader: "Заместитель главорга", subevent_leader: "Ответственный", deputy_subevent_leader: "Заместитель ответственного", organizer: "Организатор", member: "Участник блока" };
const codeNames: Record<string, Record<string, string>> = { status: statusNames, state: seasonStates, role: roleNames, task_type: taskTypeNames, priority: taskPriorityNames };
/** Keys inside recorded objects: KKR criteria and the inputs of each recipient. */
export const historyKeyNames: Record<string, string> = { ...criteriaLabels, hours: "Часы", evaluation: "Оценка", completed_at: "Дата выполнения", effective_completed_at: "Расчётная дата выполнения", participant_id: "Участник" };

/** One recorded value as people read it: names instead of codes, moments by Moscow time. */
export function historyText(value: string, field: string) {
  const names = codeNames[field];
  if (names && Object.hasOwn(names, value)) return names[value];
  if (field.endsWith("_at") && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return displayDate(value);
  return value || "Пусто";
}
