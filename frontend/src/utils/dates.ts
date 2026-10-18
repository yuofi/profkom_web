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
