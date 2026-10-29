import type { CalendarItem } from "../../utils/api/contract";
import { monthDays, monthTitle, moscowDay, occursOnDay, shiftMonth } from "../../utils/calendar";

export type CalendarView = "day" | "week" | "month";
export const calendarView = (value: string | null): CalendarView => value === "day" || value === "week" ? value : "month";
export const dayStart = (day: string) => Date.parse(`${day}T00:00:00+03:00`);
export function validDay(value: string | null): value is string {
  return !!value && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayStart(value)) && moscowDay(new Date(dayStart(value)).toISOString()) === value;
}
export const addCalendarDays = (day: string, delta: number) => moscowDay(new Date(dayStart(day) + delta * 86400000).toISOString());
export function calendarWindow(view: CalendarView, date: string) {
  if (view === "month") return monthDays(date.slice(0, 7));
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const first = view === "week" ? addCalendarDays(date, -((weekday + 6) % 7)) : date;
  const days = Array.from({ length: view === "week" ? 7 : 1 }, (_, index) => addCalendarDays(first, index));
  return { days, offset: 0, from: new Date(dayStart(first)).toISOString(), to: new Date(dayStart(addCalendarDays(days.at(-1)!, 1))).toISOString() };
}
export function shiftCalendarDate(date: string, view: CalendarView, delta: number) {
  if (view !== "month") return addCalendarDays(date, delta * (view === "week" ? 7 : 1));
  const month = shiftMonth(date.slice(0, 7), delta);
  return `${month}-${String(Math.min(Number(date.slice(-2)), monthDays(month).days.length)).padStart(2, "0")}`;
}
export function calendarTitle(view: CalendarView, date: string) {
  if (view === "month") return monthTitle(date.slice(0, 7));
  const format = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" });
  const range = calendarWindow(view, date);
  return view === "day" ? format.format(dayStart(date)) : format.formatRange(dayStart(range.days[0]), dayStart(range.days.at(-1)!));
}
export interface TimedCalendarItem {
  item: CalendarItem;
  start: number;
  end: number;
  point: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
  lane: number;
  lanes: number;
}
/** Real time bounds stay untouched; short marks reserve display space only for collision layout. */
export function timedCalendarItems(items: CalendarItem[], day: string): TimedCalendarItem[] {
  const first = dayStart(day), last = first + 86400000;
  const segments = items.filter(item => !item.all_day && occursOnDay(item, day)).map(item => {
    const start = Date.parse(item.starts_at), end = item.ends_at ? Date.parse(item.ends_at) : start;
    const point = end <= start;
    return { item, start: (Math.max(first, start) - first) / 60000, end: (Math.min(last, point ? start : end) - first) / 60000,
      point, continuesBefore: start < first, continuesAfter: !point && end > last, lane: 0, lanes: 1 };
  }).sort((left, right) => left.start - right.start || right.end - left.end || left.item.id.localeCompare(right.item.id));
  let group: TimedCalendarItem[] = [], occupied: number[] = [], groupEnd = -1;
  const finish = () => { group.forEach(segment => { segment.lanes = occupied.length; });group = [];occupied = []; };
  for (const segment of segments) {
    if (segment.start >= groupEnd) finish();
    const displayEnd = Math.max(segment.end, segment.start + 32);
    const free = occupied.findIndex(end => end <= segment.start);
    segment.lane = free < 0 ? occupied.length : free;
    occupied[segment.lane] = displayEnd;
    group.push(segment);groupEnd = Math.max(...occupied);
  }
  finish();
  return segments;
}
