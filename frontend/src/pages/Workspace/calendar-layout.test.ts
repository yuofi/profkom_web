import { expect, it } from "vitest";
import { calendarWindow, shiftCalendarDate, timedCalendarItems, validDay } from "./calendarLayout";
import type { CalendarItem } from "../../utils/api/contract";
const item = (id: string, starts_at: string, ends_at: string | null = null, all_day = false): CalendarItem => ({ id, starts_at, ends_at, all_day, title: id, season_id: "season", kind: "event", target: { kind: "event", id } });

it("uses exact half-open Moscow day/week/month windows across month and year boundaries", () => {
  expect(calendarWindow("day", "2026-10-29")).toMatchObject({ days: ["2026-10-29"], from: "2026-10-28T21:00:00.000Z", to: "2026-10-29T21:00:00.000Z" });
  const week = calendarWindow("week", "2027-01-01");
  expect(week.days).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  expect(week.to).toBe("2027-01-03T21:00:00.000Z");
  expect(calendarWindow("month", "2024-02-29").days).toHaveLength(29);
  expect(validDay("2026-02-29")).toBe(false);expect(validDay("2024-02-29")).toBe(true);
  expect(shiftCalendarDate("2026-01-31", "month", 1)).toBe("2026-02-28");
  expect(shiftCalendarDate("2026-12-31", "day", 1)).toBe("2027-01-01");
});
it("places actual overlapping intervals in separate lanes and releases the lane at an exclusive end", () => {
  const rows = timedCalendarItems([item("first", "2026-10-29T09:00:00+03:00", "2026-10-29T11:00:00+03:00"), item("overlap", "2026-10-29T10:00:00+03:00", "2026-10-29T12:00:00+03:00"), item("next", "2026-10-29T12:00:00+03:00", "2026-10-29T13:00:00+03:00")], "2026-10-29");
  expect(rows.map(row => [row.item.id, row.start, row.end, row.lane, row.lanes])).toEqual([["first", 540, 660, 0, 2], ["overlap", 600, 720, 1, 2], ["next", 720, 780, 0, 1]]);
});
it("clips multi-day intervals without creating a duration for a deadline or an unknown end", () => {
  const span = item("span", "2026-10-28T20:00:00Z", "2026-10-30T00:00:00+03:00"), point = item("point", "2026-10-28T22:00:00Z"), allDay = item("all-day", "2026-10-29T00:00:00+03:00", "2026-10-29T00:00:00+03:00", true);
  const rows = timedCalendarItems([span, point, allDay], "2026-10-29");
  expect(rows.find(row => row.item.id === "span")).toMatchObject({ start: 0, end: 1440, continuesBefore: true, continuesAfter: false, point: false });
  expect(rows.find(row => row.item.id === "point")).toMatchObject({ start: 60, end: 60, point: true });
  expect(rows.some(row => row.item.id === "all-day")).toBe(false);
  expect(timedCalendarItems([span, point], "2026-10-30")).toEqual([]);
});
