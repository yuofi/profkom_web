import { toUtc } from './dates';
export const moscowDay = (date: string) => new Date(Date.parse(date) + 3 * 3600_000).toISOString().slice(0, 10);
export function monthDays(month: string) {
  const [year, number] = month.split('-').map(Number); const start = new Date(Date.UTC(year, number - 1, 1));
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { offset: (start.getUTCDay() + 6) % 7, days: Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`), from: toUtc(`${month}-01T00:00`), to: new Date(Date.UTC(year, number, 1) - 3 * 3600_000 - 1).toISOString() };
}
