import { dayMillis, monthTitle, moveMonth, moscowDay } from "./trackerPlanning";
import s from "./TrackerPlanning.module.css";
export function TrackerPlanningNavigation({ month, onMonth, children }: { month: string; onMonth: (month: string) => void; children?: React.ReactNode }) {
  return <div className={s.toolbar}><div className={s.monthControls}><button type="button" aria-label="Предыдущий месяц" title="Предыдущий месяц" onClick={() => onMonth(moveMonth(month, -1))}>‹</button><h2 aria-live="polite">{monthTitle.format(dayMillis(`${month}-01`))}</h2><button type="button" aria-label="Следующий месяц" title="Следующий месяц" onClick={() => onMonth(moveMonth(month, 1))}>›</button></div><button type="button" className={s.todayButton} onClick={() => onMonth(moscowDay().slice(0, 7))}>Сегодня</button>{children}</div>;
}
