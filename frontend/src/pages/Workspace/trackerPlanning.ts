import type { Task, TaskListPageResponse } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";

export const taskTypeNames: Record<string, string> = { task: "Задача", milestone: "Веха", epic: "Эпик" };
export const taskPriorityNames: Record<string, string> = { low: "Низкий", normal: "Средний", high: "Высокий", urgent: "Срочный" };
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" });
export const dayTitle = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric" });
export const monthTitle = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", month: "long", year: "numeric" });
export function moscowDay(value: string | number | Date | null = Date.now()): string {
  if (value === null) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = dayFormat.formatToParts(date), part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export const dayMillis = (value: string) => Date.parse(`${value}T00:00:00+03:00`);
export const addDays = (value: string, days: number) => moscowDay(dayMillis(value) + days * 86_400_000);
export function planningMonth(value: string | null) {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) >= 1000 && Number(value.slice(0, 4)) <= 9998 ? value : moscowDay().slice(0, 7);
}
export function moveMonth(value: string, delta: number) {
  const [year, month] = value.split("-").map(Number), date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}`;
}
export interface PlanningRange { first: string; last: string; days: string[] }
export function planningRange(month: string, view: "calendar" | "gantt", zoom: "week" | "month" = "week"): PlanningRange {
  let first = `${month}-01`, last = addDays(`${moveMonth(month, 1)}-01`, -1);
  if (view === "calendar") {
    const weekday = new Date(`${first}T12:00:00Z`).getUTCDay(), mondayOffset = (weekday + 6) % 7;
    first = addDays(first, -mondayOffset);last = addDays(first, 41);
  } else if (zoom === "month") {
    first = `${moveMonth(month, -1)}-01`;last = addDays(`${moveMonth(month, 2)}-01`, -1);
  }
  const count = Math.round((dayMillis(last) - dayMillis(first)) / 86_400_000) + 1;
  return { first, last, days: Array.from({ length: count }, (_, index) => addDays(first, index)) };
}
export function taskPlanning(task: Task) {
  const deadline = moscowDay(task.deadline_at), starts = task.starts_at ? moscowDay(task.starts_at) : "";
  // A missing start stays missing. Never use a creation or private accounting date as a plan.
  const hasStart = task.task_type !== "milestone" && !!starts && !!deadline && starts <= deadline;
  return { first: hasStart ? starts : deadline, last: deadline, hasStart };
}
export async function loadPlanningTasks(filters: object, range: PlanningRange, signal?: AbortSignal) {
  const items = new Map<string, Task>(), seen = new Set<string>();let cursor: string | null = null;
  const { cursor: _cursor, ...base } = filters as Record<string, unknown>;
  void _cursor;
  do {
    if (signal?.aborted) throw new DOMException("Запрос отменён", "AbortError");
    const params: Record<string, unknown> = { ...base, limit: 100, date_from: new Date(dayMillis(range.first)).toISOString(), date_to: new Date(dayMillis(addDays(range.last, 1))).toISOString(), ...(cursor ? { cursor } : {}) };
    const page: TaskListPageResponse = await (signal ? tasksApi.listPage(params, signal) : tasksApi.listPage(params));
    if (signal?.aborted) throw new DOMException("Запрос отменён", "AbortError");
    page.items.forEach(task => items.set(task.task_id, task));cursor = page.next_cursor;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 100) throw new ApiError("Не удалось загрузить весь период. Сузьте фильтры и повторите попытку.", 0, "pagination_error");
      seen.add(cursor);
    }
  } while (cursor);
  return [...items.values()].filter(task => !!task.deadline_at);
}
