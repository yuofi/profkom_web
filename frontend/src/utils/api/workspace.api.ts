import type { Dashboard, CalendarItem, Notification, Participation } from "./contract";
import { idPath, allPages as page, request } from "./request";
export const workspaceApi = {
  dashboard: () => request<Dashboard>("get", "/dashboard"),
  participation: () => request<Participation>("get", "/participation"),
  calendar: (from: string, to: string) =>
    page<CalendarItem>("/calendar", { from, to, timezone: "Europe/Moscow" }),
  notifications: () => page<Notification>("/notifications"),
  read: (id: string) =>
    request<void>("post", `/notifications/${idPath(id)}/read`, {}),
  readAll: () => request<void>("post", "/notifications/read-all", {}),
};
