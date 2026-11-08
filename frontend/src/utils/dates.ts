const moscow = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  dateStyle: "medium",
  timeStyle: "short",
});
const keepParts = (text: string) =>
  text
    .split(", ")
    .map((part) => part.replace(/ /g, "\u00a0"))
    .join(", ");
/** "5 окт. 2026 г., 15:55": a line may break after the comma only, not inside the date or the time. */
export const displayDate = (value: string | null | undefined) =>
  value && !Number.isNaN(Date.parse(value))
    ? keepParts(moscow.format(new Date(value)))
    : "—";
const moscowShort = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const moscowYear = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  year: "numeric",
});
/** "5 окт., 15:55" within the current Moscow year; a date of another year keeps it, as in displayDate (D-02). */
export const shortDate = (value: string | null | undefined, now = Date.now()) =>
  value && !Number.isNaN(Date.parse(value)) &&
  moscowYear.format(new Date(value)) === moscowYear.format(now)
    ? keepParts(moscowShort.format(new Date(value)))
    : displayDate(value);
const moscowTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  timeStyle: "short",
});
/** "15:55" by Moscow: where the day is already said. */
export const displayTime = (value: string) =>
  Number.isNaN(Date.parse(value)) ? "—" : moscowTime.format(new Date(value));
const moscowDay = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" });
const moscowDayYear = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric" });
/** "8 ноября, 05:42" by Moscow within the current Moscow year, "8 ноября 2025 г., 05:42" otherwise; null for no date. */
export const dayMonthTime = (value: string | null | undefined, now = Date.now()) => {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  const date = new Date(value), day = moscowYear.format(date) === moscowYear.format(now) ? moscowDay : moscowDayYear;
  return keepParts(`${day.format(date)}, ${moscowTime.format(date)}`);
};
export const moscowInput = (value: string) =>
  new Date(Date.parse(value) + 3 * 3600_000).toISOString().slice(0, 16);
export const toUtc = (value: string) =>
  new Date(`${value}:00+03:00`).toISOString();
/** How long an open request has waited at its stage, e.g. "2 дн. 5 ч" (A-ROL-3). */
export function waited(since: string, now = Date.now()) {
  const hours = Math.max(0, Math.floor((now - Date.parse(since)) / 3_600_000));
  const days = Math.floor(hours / 24);
  return days ? `${days} дн. ${hours % 24} ч` : `${hours} ч`;
}
