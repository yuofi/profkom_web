import type { Dashboard, CalendarItem, Notification, Participation, Task } from "./contract";
import { idPath, allPages as page, request } from "./request";
export interface Workday {
  today: string; agenda: CalendarItem[]; tasks: Task[]; overdue_tasks: Task[]; overdue_count: number; undated_count?: number;
  approvals: { kind: string; title: string; count: number; to: string }[];
  merit_entries: { title: string; to: string }[];
}
export const workspaceApi = {
  home: (watching = false) => request<Workday>("get", "/workspace/home", undefined, { watching }),
  dashboard: () => request<Dashboard>("get", "/dashboard"),
  participation: () => request<Participation>("get", "/participation"),
  calendar: (from: string, to: string, filters: object = {}, signal?: AbortSignal) =>
    page<CalendarItem>("/calendar", { from, to, timezone: "Europe/Moscow", ...filters }, signal),
  notifications: () => page<Notification>("/notifications"),
  read: (id: string) =>
    request<void>("post", `/notifications/${idPath(id)}/read`, {}),
  readAll: () => request<void>("post", "/notifications/read-all", {}),
};
