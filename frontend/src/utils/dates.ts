const moscow = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  dateStyle: "medium",
  timeStyle: "short",
});
export const displayDate = (value: string | null | undefined) =>
  value && !Number.isNaN(Date.parse(value))
    ? moscow.format(new Date(value))
    : "—";
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
