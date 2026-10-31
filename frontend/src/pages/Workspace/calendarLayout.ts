import type { CalendarItem } from "../../utils/api/contract";
import { capitalizeFirst, monthDays, monthTitle, moscowDay, occursOnDay, shiftMonth } from "../../utils/calendar";

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
  if (view === "month") return capitalizeFirst(monthTitle(date.slice(0, 7)));
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
  /** Items of one group overlap each other directly or through a chain. */
  group: number;
}
/** Real time bounds stay untouched; short marks reserve display space only for collision layout. */
export function timedCalendarItems(items: CalendarItem[], day: string): TimedCalendarItem[] {
  const first = dayStart(day), last = first + 86400000;
  const segments = items.filter(item => !item.all_day && occursOnDay(item, day)).map(item => {
    const start = Date.parse(item.starts_at), end = item.ends_at ? Date.parse(item.ends_at) : start;
    const point = end <= start;
    return { item, start: (Math.max(first, start) - first) / 60000, end: (Math.min(last, point ? start : end) - first) / 60000,
      point, continuesBefore: start < first, continuesAfter: !point && end > last, lane: 0, lanes: 1, group: 0 };
  }).sort((left, right) => left.start - right.start || right.end - left.end || left.item.id.localeCompare(right.item.id));
  let group: TimedCalendarItem[] = [], occupied: number[] = [], groupEnd = -1, groups = 0;
  const finish = () => { group.forEach(segment => { segment.lanes = occupied.length; });group = [];occupied = []; };
  for (const segment of segments) {
    if (segment.start >= groupEnd) { finish();groups++; }
    segment.group = groups;
    const displayEnd = Math.max(segment.end, segment.start + 32);
    const free = occupied.findIndex(end => end <= segment.start);
    segment.lane = free < 0 ? occupied.length : free;
    occupied[segment.lane] = displayEnd;
    group.push(segment);groupEnd = Math.max(...occupied);
  }
  finish();
  return segments;
}
/** A timed item that covers the whole Moscow day, such as the middle of a multi-day event:
 *  it belongs to the all-day row instead of a 00:00–24:00 block over the grid. */
export function coversWholeDay(item: CalendarItem, day: string) {
  if (item.all_day || !item.ends_at) return false;
  const first = dayStart(day), start = Date.parse(item.starts_at), end = Date.parse(item.ends_at);
  return end > start && start <= first && end >= first + 86400000;
}
/** Items folded into one "+N" mark in the last visible lane; it lists them from the same projection. */
export interface CalendarOverflow { id: string; start: number; lane: number; lanes: number; segments: TimedCalendarItem[] }
/** The grid of one day: at most `maxLanes` columns, whole-day spans left to the all-day row. */
export function calendarDayLayout(items: CalendarItem[], day: string, maxLanes: number) {
  const segments = timedCalendarItems(items.filter(item => !coversWholeDay(item, day)), day);
  const visible: TimedCalendarItem[] = [], overflow: CalendarOverflow[] = [];
  const groups = new Map<number, TimedCalendarItem[]>();
  segments.forEach(segment => groups.set(segment.group, [...(groups.get(segment.group) ?? []), segment]));
  for (const group of groups.values()) {
    if (group[0].lanes <= maxLanes) { visible.push(...group);continue; }
    const kept = maxLanes - 1;
    visible.push(...group.filter(segment => segment.lane < kept).map(segment => ({ ...segment, lanes: maxLanes })));
    let mark: CalendarOverflow | undefined, markEnd = -1;
    for (const segment of group.filter(segment => segment.lane >= kept).sort((left, right) => left.start - right.start || left.item.id.localeCompare(right.item.id))) {
      if (!mark || segment.start >= markEnd) { mark = { id: `${day}:${segment.item.id}`, start: segment.start, lane: kept, lanes: maxLanes, segments: [] };overflow.push(mark); }
      mark.segments.push(segment);markEnd = Math.max(markEnd, segment.start + 32, segment.end);
    }
  }
  return { segments: visible, overflow };
}
