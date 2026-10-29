import { toUtc } from "./dates";
export const moscowDay = (date: string) =>
  new Date(Date.parse(date) + 3 * 3600_000).toISOString().slice(0, 10);
export const validMonth = (month: string) => /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month);
export const normalizeMonth = (month: string) => validMonth(month) ? month : moscowDay(new Date().toISOString()).slice(0, 7);
export function shiftMonth(month: string, offset: number) {
  month = normalizeMonth(month);
  const date = new Date(`${month}-15T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
export const monthTitle = (month: string) => new Intl.DateTimeFormat("ru-RU", {
  month: "long", year: "numeric", timeZone: "UTC",
}).format(new Date(`${normalizeMonth(month)}-15T12:00:00Z`)).replace(/\s*г\.$/, "").trim();
export function monthDays(month: string) {
  month = normalizeMonth(month);
  const [year, number] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, number - 1, 1));
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return {
    offset: (start.getUTCDay() + 6) % 7,
    days: Array.from(
      { length },
      (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
    ),
    from: toUtc(`${month}-01T00:00`),
    to: new Date(Date.UTC(year, number, 1) - 3 * 3600_000).toISOString(),
  };
}
/** Timed ends are exclusive; all-day ends name their last included Moscow day. */
export function occursOnDay(item: { starts_at: string; ends_at?: string | null; all_day?: boolean }, day: string) {
  const first = Date.parse(item.starts_at), start = Date.parse(`${day}T00:00:00+03:00`), end = start + 86_400_000;
  const last = Date.parse(item.ends_at ?? item.starts_at) + (item.all_day ? 86_400_000 : 0);
  return first < end && (last > first ? last > start : first >= start);
}
