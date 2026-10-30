import type { AssignmentStatus, Task, TaskPublicStatus } from "../../utils/api/contract";
import type { Tone } from "../../components/Workspace/sections";
import { can } from "../../utils/session";

export const publicStatusNames: Record<TaskPublicStatus, string> = {
  open: "Открыта", in_progress: "В работе", completed: "Выполнена", closed: "Закрыта",
};
export const statusNames: Record<AssignmentStatus | TaskPublicStatus, string> = {
  ...publicStatusNames, assigned: "Открыта", help_required: "Нужна помощь", submitted: "На проверке",
  accepted: "Принята", needs_revision: "На доработке", not_completed: "Не выполнена", cancelled: "Отменена",
};
export const statusTones: Record<AssignmentStatus | TaskPublicStatus, Tone | undefined> = {
  open: "lilac", completed: "peach", closed: "mint",
  assigned: "lilac", in_progress: "sky", help_required: "peach", submitted: "peach",
  accepted: "mint", needs_revision: "rose", not_completed: "rose", cancelled: undefined,
};
export function publicStatus(value?: string): TaskPublicStatus {
  return ({ assigned: "open", submitted: "completed", accepted: "closed", not_completed: "closed", cancelled: "closed", help_required: "in_progress", needs_revision: "in_progress" } as Record<string, TaskPublicStatus>)[value ?? ""] ?? (value && value in publicStatusNames ? value as TaskPublicStatus : "open");
}
export function taskStatus(task: Task): TaskPublicStatus { return publicStatus(task.status ?? task.assignments[0]?.status); }
export function taskTransitions(task: Task): TaskPublicStatus[] {
  if (!can(task, "change_task_status")) return [];
  const allowed = task.allowed_statuses ?? Object.keys(publicStatusNames) as TaskPublicStatus[];
  return [...new Set(allowed.map(publicStatus))].filter(status => status !== taskStatus(task));
}
