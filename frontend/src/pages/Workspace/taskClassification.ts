import type { Task, TaskPriority, TaskType } from "../../utils/api/contract";
import { taskPriorityNames, taskTypeNames } from "./trackerPlanning";
export type TaskClassificationField = "task_type" | "priority";
export type TaskClassificationValue = TaskType | TaskPriority;
export const classificationLabels: Record<TaskClassificationField, string> = { task_type: "Тип задачи", priority: "Приоритет" };
export const classificationCapabilities: Record<TaskClassificationField, string> = { task_type: "change_task_type", priority: "change_task_priority" };
export const classificationOptions: Record<TaskClassificationField, readonly { value: TaskClassificationValue; label: string }[]> = {
  task_type: (["task", "milestone", "epic"] as const).map(value => ({ value, label: taskTypeNames[value] })),
  priority: (["low", "normal", "high", "urgent"] as const).map(value => ({ value, label: taskPriorityNames[value] })),
};
export function taskClassificationValue(task: Task, field: TaskClassificationField): TaskClassificationValue { return field === "task_type" ? task.task_type ?? "task" : task.priority ?? "normal"; }
