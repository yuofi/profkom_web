import { displayDate } from "../../utils/dates";
import { moscowDay } from "../../utils/calendar";

export interface EventPeriod { starts_at?: string | null; ends_at?: string | null; all_day?: boolean }
const dayLabel = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "Europe/Moscow" }).format(new Date(value));
export function eventPeriod(value: EventPeriod): string {
  const format = value.all_day ? dayLabel : displayDate;
  if (!value.starts_at && !value.ends_at) return "Даты уточняются";
  if (!value.starts_at) return `До ${format(value.ends_at!)}`;
  if (!value.ends_at || value.all_day && moscowDay(value.starts_at) === moscowDay(value.ends_at)) return `${format(value.starts_at)}${value.all_day ? " · весь день" : ""}`;
  return `${format(value.starts_at)} — ${format(value.ends_at)}${value.all_day ? " · целые дни" : ""}`;
}
export function eventPhase(value: EventPeriod, now = Date.now()): "current" | "upcoming" | "past" | "undated" {
  if (!value.starts_at) return "undated";
  const first = Date.parse(value.starts_at);
  const last = value.ends_at ? Date.parse(value.ends_at) + (value.all_day ? 86_400_000 : 0) : Date.parse(`${moscowDay(value.starts_at)}T21:00:00Z`);
  return first > now ? "upcoming" : last > now ? "current" : "past";
}

export function outsideParentPeriod(child: EventPeriod, parent: EventPeriod): boolean {
  const start = child.starts_at ? Date.parse(child.starts_at) : null, lastDate = child.ends_at ? Date.parse(child.ends_at) : null;
  const lower = parent.starts_at ? Date.parse(parent.starts_at) : null;
  const upper = parent.ends_at ? Date.parse(parent.ends_at) + (parent.all_day ? 86400000 : 0) : null;
  const end = lastDate === null ? null : lastDate + (child.all_day ? 86400000 : 0);
  return !!(start !== null && lower !== null && start < lower || lastDate !== null && lower !== null && lastDate < lower
    || start !== null && upper !== null && (start > upper || parent.all_day && start === upper)
    || end !== null && upper !== null && end > upper);
}
