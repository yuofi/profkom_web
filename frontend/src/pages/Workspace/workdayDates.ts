import { moscowDay } from "../../utils/calendar";

const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
export function deadlineHint(value: string | null, now: number, overdue: boolean) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Без срока";
  const time = Date.parse(value);
  if (overdue) {
    const minutes = Math.max(1, Math.floor((now - time) / 60000));
    return `Просрочено: ${minutes >= 1440 ? `${Math.floor(minutes / 1440)} дн.` : minutes >= 60 ? `${Math.floor(minutes / 60)} ч` : `${minutes} мин`}`;
  }
  const day = moscowDay(value), today = moscowDay(new Date(now).toISOString());
  const tomorrow = moscowDay(new Date(now + 86400000).toISOString());
  return `${day === today ? "Сегодня" : day === tomorrow ? "Завтра" : date.format(time)}, ${clock.format(time)}`;
}
