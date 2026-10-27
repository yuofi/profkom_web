import type { Task, TaskPlanning, TaskPriority, TaskType, TaskChecklistInput } from "../../utils/api/contract";
import { moscowInput, toUtc } from "../../utils/dates";
export interface PlanningDraft { task_type: TaskType; priority: TaskPriority; starts: string }
export const planningDraft = (task?: Task): PlanningDraft => ({ task_type: task?.task_type ?? "task", priority: task?.priority ?? "normal", starts: task?.starts_at ? moscowInput(task.starts_at) : "" });
export const planningPayload = (draft: PlanningDraft): TaskPlanning => ({ task_type: draft.task_type, priority: draft.priority, starts_at: draft.task_type === "milestone" || !draft.starts ? null : toUtc(draft.starts) });
export type ChecklistDraft = TaskChecklistInput & { key: string };
export const checklistDraft = (items: TaskChecklistInput[] = []): ChecklistDraft[] => items.map(item => ({ ...item, key: item.item_id ?? crypto.randomUUID() }));
export const checklistPayload = (items: ChecklistDraft[]): TaskChecklistInput[] => items.map(({ item_id, text, checked }) => ({ ...(item_id ? { item_id } : {}), text: text.trim(), checked }));
