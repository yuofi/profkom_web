import { expect, it } from "vitest";
import { dayMonthTime, displayDate, shortDate } from "./dates";

// Moscow is UTC+3: 31 Dec 21:30 UTC is already 1 January there.
const newYearNight = "2026-12-31T21:30:00Z";
const nbsp = (text: string) => text.replace(/ /g, "\u00a0");

it("D-02: drops the year of a date in the current Moscow year and keeps the line break after the comma only", () => {
  expect(shortDate("2026-11-01T00:31:00Z", Date.parse("2026-11-01T09:00:00Z"))).toBe(`${nbsp("1 нояб.")}, 03:31`);
  expect(shortDate("2026-03-05T09:05:00Z", Date.parse("2026-12-31T20:59:00Z"))).toBe(`${nbsp("5 мар.")}, 12:05`);
});
it("D-02: keeps the year on both sides of a Moscow New Year, as the full date does", () => {
  // Still 31 December in Moscow: the coming January shows its year.
  expect(shortDate(newYearNight, Date.parse("2026-12-31T20:59:00Z"))).toBe(displayDate(newYearNight));
  expect(shortDate(newYearNight, Date.parse("2026-12-31T20:59:00Z"))).toBe(`${nbsp("1 янв. 2027 г.")}, 00:30`);
  // Already 1 January in Moscow (still 31 December in UTC): the same date is in the current year.
  expect(shortDate(newYearNight, Date.parse("2026-12-31T21:00:00Z"))).toBe(`${nbsp("1 янв.")}, 00:30`);
  // A date of the past year keeps it too.
  expect(shortDate("2026-12-31T20:30:00Z", Date.parse("2027-01-01T09:00:00Z"))).toBe(`${nbsp("31 дек. 2026 г.")}, 23:30`);
});
it("D-02: an empty or broken value reads as a dash", () => {
  expect(shortDate(null)).toBe("—");expect(shortDate(undefined)).toBe("—");expect(shortDate("not a date")).toBe("—");
});
it("a sign-in notice names the day with the full month and the Moscow time, and the year only for another year", () => {
  expect(dayMonthTime("2026-11-08T02:42:00Z", Date.parse("2026-11-08T09:00:00Z"))).toBe(`${nbsp("8 ноября")}, 05:42`);
  expect(dayMonthTime(newYearNight, Date.parse("2026-12-31T20:59:00Z"))).toBe(`${nbsp("1 января 2027 г.")}, 00:30`);
  expect(dayMonthTime(newYearNight, Date.parse("2026-12-31T21:00:00Z"))).toBe(`${nbsp("1 января")}, 00:30`);
  expect(dayMonthTime(null)).toBeNull();expect(dayMonthTime("")).toBeNull();expect(dayMonthTime("not a date")).toBeNull();
});
