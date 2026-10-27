import { useId, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { Task } from "../../utils/api/contract";
import { HoverCard } from "../../components/Workspace/HoverCard";
import { UserChip } from "../../components/Workspace/UserChip";
import { getTaskRoute } from "../../utils/routes";
import { TrackerPlanPreview } from "./TrackerPlanPreview";
import { TrackerPlanningNavigation } from "./TrackerPlanningNavigation";
import { dayMillis, dayTitle, moscowDay, taskPlanning, type PlanningRange } from "./trackerPlanning";
import { statusNames, taskStatus } from "./trackerStatus";
import s from "./TrackerPlanning.module.css";
const ROW = 116;
export function TrackerGantt({ tasks, range, month, onMonth, zoom, onZoom }: { tasks: Task[]; range: PlanningRange; month: string; onMonth: (month: string) => void; zoom: "week" | "month"; onZoom: (zoom: "week" | "month") => void }) {
  const markerId = `gantt-arrow-${useId().replace(/:/g, "")}`, dayWidth = zoom === "week" ? 30 : 12;
  const length = range.days.length * dayWidth, firstMs = dayMillis(range.first), today = moscowDay(), todayIndex = range.days.indexOf(today);
  const rows = tasks.map(task => ({ task, ...taskPlanning(task) })).filter(plan => plan.first && plan.last >= range.first && plan.first <= range.last);
  const index = new Map(rows.map((row, i) => [row.task.task_id, i]));
  const x = (day: string) => Math.max(0, Math.min(length, (dayMillis(day) - firstMs) / 86_400_000 * dayWidth));
  const edges = rows.flatMap((row, from) => (row.task.links ?? []).filter(link => link.kind === "blocks" && index.has(link.task.task_id)).map(link => {
    const to = index.get(link.task.task_id)!, end = Math.min(length - 2, x(row.last) + dayWidth), start = Math.max(2, x(rows[to].first));
    const y1 = from * ROW + ROW / 2, y2 = to * ROW + ROW / 2, bend = Math.min(length - 2, Math.max(end + 10, start - 12));
    return { id: link.link_id, d: `M ${end} ${y1} H ${bend} V ${y2} H ${start}` };
  }));
  const style = { "--timeline-width": `${length}px`, "--day-width": `${dayWidth}px`, "--plan-row-height": `${ROW}px` } as CSSProperties;
  return <section className={s.gantt} aria-label="Диаграмма Гантта"><TrackerPlanningNavigation month={month} onMonth={onMonth}><div className={s.zoom} aria-label="Масштаб диаграммы">{(["week", "month"] as const).map(value => <button key={value} type="button" aria-pressed={zoom === value} onClick={() => onZoom(value)}>{value === "week" ? "Недели" : "Месяцы"}</button>)}</div></TrackerPlanningNavigation>
    <p className={s.caption}>План на {dayTitle.format(firstMs)} — {dayTitle.format(dayMillis(range.last))}. Ромб обозначает веху или дедлайн без заданного начала; линии — зависимости, доступные в этом периоде.</p>
    <div className={s.ganttScroll} tabIndex={0} role="region" aria-label="План задач, прокрутка по горизонтали"><div className={s.ganttCanvas} style={style}>
      <div className={s.ganttHeader}><div className={s.ganttTaskHeader}>Задача</div><div className={s.timeHeader}>{range.days.map((day, i) => {
        const tick = zoom === "week" ? true : day.endsWith("-01") || i === 0 || [8, 15, 22].includes(Number(day.slice(-2)));
        return <span key={day} className={`${s.timeTick} ${day === today ? s.tickToday : ""}`} style={{ left: i * dayWidth, width: tick ? zoom === "month" ? dayWidth * 7 : dayWidth : dayWidth }} title={dayTitle.format(dayMillis(day))}>{tick && <><small>{day.endsWith("-01") || i === 0 ? new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "Europe/Moscow" }).format(dayMillis(day)) : ""}</small>{Number(day.slice(-2))}</>}</span>;
      })}</div></div>
      <div className={s.ganttBody}>
        {edges.length > 0 && <svg className={s.edges} width={length} height={rows.length * ROW} aria-hidden="true"><defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 Z" /></marker></defs>{edges.map(edge => <path key={edge.id} d={edge.d} markerEnd={`url(#${markerId})`} />)}</svg>}
        {todayIndex >= 0 && <div className={s.todayLine} style={{ left: `calc(var(--label-width) + ${(todayIndex + .5) * dayWidth}px)` }} aria-hidden="true" />}
        {rows.map(row => {
          const left = x(row.first), width = Math.max(6, Math.min(length, x(row.last) + dayWidth) - left), dependencies = (row.task.links ?? []).filter(link => link.kind === "blocked_by"), epic = (row.task.links ?? []).find(link => link.kind === "epic");
          return <div className={s.ganttRow} key={row.task.task_id}><div className={s.ganttTask} data-epic={epic ? "true" : undefined}><Link to={getTaskRoute(row.task.task_id)}><small>{row.task.task_key}{row.task.task_type === "epic" ? " · Эпик" : row.task.task_type === "milestone" ? " · Веха" : ""}{epic && ` · Эпик ${epic.task.task_key}`}</small><strong>{row.task.title}</strong></Link><div className={s.ganttPeople}>{(row.task.assignees ?? row.task.assignments.map(item => item.assignee)).slice(0, 1).map(user => <UserChip key={user.user_id} user={user} />)}{(row.task.assignees?.length ?? row.task.assignments.length) > 1 && <small>+{(row.task.assignees?.length ?? row.task.assignments.length) - 1}</small>}</div>
            {dependencies.length > 0 && <span className={s.dependencyCount}>Зависимостей: {dependencies.length}</span>}
          </div><div className={s.ganttTrack}>
            <HoverCard content={() => <TrackerPlanPreview task={row.task} />}>{({ describedBy, close }) => <Link className={`${s.bar} ${row.hasStart ? "" : s.milestone}`} data-status={taskStatus(row.task)} data-type={row.task.task_type ?? "task"} style={{ left: row.hasStart ? left : Math.min(length - dayWidth, left), width: row.hasStart ? width : dayWidth }} to={getTaskRoute(row.task.task_id)} aria-describedby={describedBy} onClick={close} aria-label={`${row.task.task_key ?? "Задача"} · ${row.task.title} · ${statusNames[taskStatus(row.task)]} · ${row.task.task_type === "milestone" ? "Веха, срок" : row.hasStart ? "Плановое начало " + dayTitle.format(dayMillis(row.first)) : "Начало не задано, дедлайн"} · ${dayTitle.format(dayMillis(row.last))}`}><span>{row.hasStart ? row.task.task_key ?? row.task.title : "◆"}</span></Link>}</HoverCard>
          </div></div>;
        })}
        {!rows.length && <p className={s.emptyTimeline}>В выбранном периоде нет задач. Измените месяц или фильтры.</p>}
      </div>
    </div></div>
    <p className={s.caption} aria-live="polite">Задач в периоде: {rows.length}. Сроки относятся к рабочему плану и не изменяют учёт ККР.</p>
  </section>;
}
