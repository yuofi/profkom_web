import type { AssignmentStatus, Task } from "../../utils/api/contract";
import type { Tone } from "../../components/Workspace/sections";
import { can } from "../../utils/session";

export const statusNames: Record<AssignmentStatus, string> = {
  assigned: "Назначена", in_progress: "В работе", help_required: "Нужна помощь", submitted: "На проверке",
  accepted: "Принята", needs_revision: "На доработке", not_completed: "Не выполнена", cancelled: "Отменена",
};
export const statusTones: Record<AssignmentStatus, Tone | undefined> = {
  assigned: "lilac", in_progress: "sky", help_required: "peach", submitted: "peach",
  accepted: "mint", needs_revision: "rose", not_completed: "rose", cancelled: undefined,
};
export function taskStatus(task: Task): AssignmentStatus { return task.status ?? task.assignments[0]?.status ?? "assigned"; }
export function taskTransitions(task: Task): AssignmentStatus[] {
  const state = taskStatus(task), result: AssignmentStatus[] = [];
  const active = !["accepted", "not_completed", "cancelled"].includes(state);
  if (can(task, "start_task") && ["assigned", "needs_revision"].includes(state)) result.push("in_progress");
  if (can(task, "resume_task") && state === "help_required") result.push("in_progress");
  if (active && can(task, "request_task_help") && state !== "help_required" && state !== "submitted") result.push("help_required");
  if (active && can(task, "submit_task_result") && state !== "submitted") result.push("submitted");
  if (can(task, "review_task")) {
    if (state === "submitted") result.push("accepted", "needs_revision");
    else if (state === "accepted") result.push("needs_revision");
    if (active) result.push("not_completed", "cancelled");
  }
  return [...new Set(result)];
}
