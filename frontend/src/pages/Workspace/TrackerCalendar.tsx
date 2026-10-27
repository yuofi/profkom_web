import { Link } from "react-router-dom";
import type { Task } from "../../utils/api/contract";
import { HoverCard } from "../../components/Workspace/HoverCard";
import { getTaskRoute } from "../../utils/routes";
import { TrackerPlanPreview } from "./TrackerPlanPreview";
import { TrackerPlanningNavigation } from "./TrackerPlanningNavigation";
import { dayMillis, dayTitle, moscowDay, taskPlanning, type PlanningRange } from "./trackerPlanning";
import { statusNames, taskStatus } from "./trackerStatus";
import s from "./TrackerPlanning.module.css";

export function TrackerCalendar({ tasks, range, month, onMonth }: { tasks: Task[]; range: PlanningRange; month: string; onMonth: (month: string) => void }) {
  const today = moscowDay(), plans = tasks.map(task => ({ task, ...taskPlanning(task) }));
  return <section className={s.calendar} aria-label="Календарь задач"><TrackerPlanningNavigation month={month} onMonth={onMonth} />
    <p className={s.caption}>Плановые сроки задач. Вехи и задачи без начала показаны только в день дедлайна.</p>
    <div className={s.calendarScroll} tabIndex={0} role="region" aria-label="Сетка календаря задач"><div className={s.weekdays} aria-hidden="true">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(day => <span key={day}>{day}</span>)}</div>
      <div className={s.calendarGrid}>{range.days.map(day => {
        const items = plans.filter(plan => plan.first && plan.first <= day && plan.last >= day), label = dayTitle.format(dayMillis(day));
        return <section key={day} className={`${s.day} ${day.slice(0, 7) === month ? "" : s.outside} ${day === today ? s.today : ""}`} aria-label={label}>
          <h3><time dateTime={day} aria-current={day === today ? "date" : undefined}>{Number(day.slice(-2))}</time><span className={s.dayCount}>{items.length ? items.length : ""}</span></h3>
          <div className={s.dayTasks}>{items.slice(0, 3).map(plan => <CalendarTask key={plan.task.task_id} task={plan.task} kind={!plan.hasStart ? "Дедлайн" : day === plan.first ? "Начало" : day === plan.last ? "Дедлайн" : "В работе по плану"} />)}
            {items.length > 3 && <details className={s.more}><summary>Ещё {items.length - 3}</summary>{items.slice(3).map(plan => <CalendarTask key={plan.task.task_id} task={plan.task} kind={!plan.hasStart || day === plan.last ? "Дедлайн" : day === plan.first ? "Начало" : "В работе по плану"} />)}</details>}
          </div>
        </section>;
      })}</div>
    </div>
    <p className={s.caption} aria-live="polite">Задач в периоде: {tasks.length}</p>
  </section>;
}
function CalendarTask({ task, kind }: { task: Task; kind: string }) {
  return <HoverCard content={() => <TrackerPlanPreview task={task} />}>{({ describedBy, close }) => <Link className={s.calendarTask} data-status={taskStatus(task)} data-type={task.task_type ?? "task"} to={getTaskRoute(task.task_id)} aria-describedby={describedBy} aria-label={`${task.task_key ?? "Задача"} · ${task.title} · ${kind} · ${statusNames[taskStatus(task)]}`} onClick={close}><small>{task.task_key} · {task.task_type === "milestone" ? "Веха" : kind}</small><span>{task.title}</span></Link>}</HoverCard>;
}
