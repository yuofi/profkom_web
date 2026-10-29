import { Link } from "react-router-dom";
import type { Task } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { useEffect, useState } from "react";
import { deadlineHint } from "./workdayDates";
import { getTaskRoute } from "../../utils/routes";
import { statusNames, taskStatus } from "./trackerStatus";
import s from "./WorkdayTasks.module.css";

export function WorkdayTasks({ tasks, overdue = false, now }: { tasks: Task[]; overdue?: boolean; now?: number }) {
  const [currentTime, setCurrentTime] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000);return () => window.clearInterval(timer); }, []);
  return <ul className={`${s.list} ${overdue ? s.overdue : ""}`} aria-label={overdue ? "Просроченные задачи" : "Ближайшие задачи"}>
    {tasks.map(task => <li key={task.task_id}><Link to={getTaskRoute(task.task_id)} className={s.row}>
      <span className={s.identity}><span className={s.key}>{task.task_key}</span><span className={s.title}>{task.title}</span><small>{statusNames[taskStatus(task)]}</small></span>
      <time className={s.deadline} dateTime={task.deadline_at ?? undefined} title={displayDate(task.deadline_at)}>{deadlineHint(task.deadline_at, now ?? currentTime, overdue)}</time>
      <span className={s.arrow} aria-hidden="true">›</span>
    </Link></li>)}
  </ul>;
}
