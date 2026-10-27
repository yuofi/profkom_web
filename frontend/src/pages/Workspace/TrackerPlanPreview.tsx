import type { Task } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { UserChip } from "../../components/Workspace/UserChip";
import { TeamChip } from "../../components/Workspace/TeamChip";
import { statusNames, taskStatus } from "./trackerStatus";
import { taskPriorityNames, taskTypeNames } from "./trackerPlanning";
import s from "./TrackerPlanning.module.css";

export function TrackerPlanPreview({ task }: { task: Task }) {
  return <div className={s.preview}><small>{task.task_key ?? "Задача"}</small><strong>{task.title}</strong><p>{statusNames[taskStatus(task)]} · {taskTypeNames[task.task_type ?? "task"]} · {taskPriorityNames[task.priority ?? "normal"]}</p>
    <dl><div><dt>Плановое начало</dt><dd>{task.starts_at ? displayDate(task.starts_at) : "Не задано"}</dd></div><div><dt>Дедлайн</dt><dd>{displayDate(task.deadline_at)}</dd></div></dl>
    {(task.links ?? []).some(link => link.kind === "epic") && <p>Эпик: {(task.links ?? []).filter(link => link.kind === "epic").map(link => `${link.task.task_key} · ${link.task.title}`).join(", ")}</p>}
    {(task.links ?? []).some(link => link.kind === "milestone") && <p>Вехи: {(task.links ?? []).filter(link => link.kind === "milestone").map(link => link.task.task_key).join(", ")}</p>}
    <TeamChip scope={task.scope} title={task.scope_title} avatarUrl={task.scope_avatar_url} interactive={false} />
    {!!(task.assignees?.length ?? task.assignments.length) && <div className={s.previewPeople}>{(task.assignees ?? task.assignments.map(item => item.assignee)).map((user, index) => <UserChip key={`${user.user_id}-${index}`} user={user} interactive={false} />)}</div>}
  </div>;
}
