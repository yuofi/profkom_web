import type { AssignmentStatus, Task } from "../../utils/api/contract";
import type { Tone } from "../../components/Workspace/sections";
import { can } from "../../utils/session";

export const statusNames: Record<AssignmentStatus, string> = {
  assigned: "Открыта", in_progress: "В работе", help_required: "Нужна помощь", submitted: "На проверке",
  accepted: "Принята", needs_revision: "На доработке", not_completed: "Не выполнена", cancelled: "Отменена",
};
export const statusTones: Record<AssignmentStatus, Tone | undefined> = {
  assigned: "lilac", in_progress: "sky", help_required: "peach", submitted: "peach",
  accepted: "mint", needs_revision: "rose", not_completed: "rose", cancelled: undefined,
};
export function taskStatus(task: Task): AssignmentStatus { return task.status ?? task.assignments[0]?.status ?? "assigned"; }
export function taskTransitions(task: Task): AssignmentStatus[] {
  if (!can(task, "change_task_status")) return [];
  const allowed = task.allowed_statuses ?? Object.keys(statusNames) as AssignmentStatus[];
  return [...new Set(allowed)].filter(status => status in statusNames && status !== taskStatus(task));
}
