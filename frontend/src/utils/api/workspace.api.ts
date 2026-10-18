import type { Dashboard, CalendarItem, Notification } from './contract';
import { idPath, page, request } from './request';
export const workspaceApi = {
  dashboard: () => request<Dashboard>('get', '/dashboard'),
  calendar: (from: string, to: string) => page<CalendarItem>('/calendar', { from, to, timezone: 'Europe/Moscow' }),
  notifications: () => page<Notification>('/notifications'),
  read: (id: string) => request<void>('post', `/notifications/${idPath(id)}/read`, {}),
  readAll: () => request<void>('post', '/notifications/read-all', {}),
};
