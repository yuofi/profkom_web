import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import type { Task, TaskInputs } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { displayDate, moscowInput, toUtc } from "../../utils/dates";
import { can, useSession } from "../../utils/session";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { taskStatus } from "./trackerStatus";
import s from "./TrackerTaskDetail.module.css";

/**
 * The deadline is an assessment input (УВ-5): it moves through the dated, reasoned
 * assessment-inputs change, never through an ordinary task edit, and only for those whose
 * inputs carry edit_assessment_dates. Other task managers learn who moves it: in a closed
 * season the chair, the deputies and the HR master only, not the HR deputy (SE-13).
 */
export function TaskDeadlineParameter({ task, now, onSaved }: { task: Task; now: number; onSaved?: () => void }) {
  const { session } = useSession();
  const accountable = can(task, "view_assessment_inputs") && task.scope.kind !== "queue";
  // task.dates.edit belongs to the summary roles only; area leads need not read the inputs for it.
  const inputs = useQuery({ queryKey: ["assessments", "task", task.task_id], queryFn: () => tasksApi.inputs(task.task_id), enabled: accountable && can(session, "view_summary") });
  const [moving, setMoving] = useState(false);
  const movable = can(inputs.data, "edit_assessment_dates");
  const manager = accountable || can(task, "edit_task") || can(task, "edit_task_metadata");
  // The task page reads the seasons with the task (PF-14); the hint joins that entry.
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, refetchOnMount: false, enabled: manager });
  const closed = seasons.data?.items.find(item => item.season_id === task.season_id)?.state === "closed";
  return <div><dt>Дедлайн, МСК</dt><dd>
    {task.deadline_at ? <time dateTime={task.deadline_at} className={Date.parse(task.deadline_at) < now && taskStatus(task) !== "closed" ? s.overdue : undefined}>{displayDate(task.deadline_at)}</time> : <span>Не задан</span>}
    {movable ? <button type="button" className={s.deadlineEdit} onClick={() => setMoving(true)}>Перенести срок</button>
      : manager && !inputs.isLoading && !seasons.isLoading && <p className={s.seasonContext}>{closed ? "Срок закрытого сезона переносят председатель, замы и мастер HR" : "Срок переносят председатель, замы, мастер HR и его заместитель"}</p>}
    {moving && movable && inputs.data && <UnsavedChangesScope><DeadlineEditor task={task} inputs={inputs.data} refetch={() => void inputs.refetch()} onClose={() => setMoving(false)} onSaved={onSaved} /></UnsavedChangesScope>}
  </dd></div>;
}

function DeadlineEditor({ task, inputs, refetch, onClose, onSaved }: { task: Task; inputs: TaskInputs; refetch: () => void; onClose: () => void; onSaved?: () => void }) {
  const client = useQueryClient();
  // The card's season parameter already reads the seasons; the end bounds the new deadline.
  const seasonEnd = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list }).data?.items.find(item => item.season_id === task.season_id)?.ends_at;
  const range = seasonEnd ? `Не раньше ${displayDate(inputs.assigned_at)} и не позже ${displayDate(seasonEnd)} (конец сезона), МСК.` : "Не раньше выдачи задачи и не позже конца сезона.";
  return <TrackerTaskDialog title="Перенести срок" onClose={onClose}>
    <p>Задача: {task.task_key ? `${task.task_key} · ` : ""}{task.title}</p>
    <ActionForm revision={inputs.revision} record={`task-inputs:${task.task_id}`} onConflict={refetch} submitLabel="Перенести срок"
      fields={[{ name: "deadline_at", label: "Новый дедлайн, МСК", type: "datetime-local", required: true, value: inputs.deadline_at ? moscowInput(inputs.deadline_at) : "", hint: range }, { name: "reason", label: "Причина переноса", required: true }]}
      onSubmit={async (values, revision) => {
        const saved = await tasksApi.updateInputs(task.task_id, { expected_revision: revision!, deadline_at: toUtc(text(values, "deadline_at")), reason: text(values, "reason") });
        client.setQueryData(["assessments", "task", task.task_id], saved);
        await Promise.all([client.invalidateQueries({ queryKey: ["accounting-batch", task.task_id] }), client.invalidateQueries({ queryKey: ["tasks"] })]);
        onSaved?.();onClose();return saved;
      }} />
  </TrackerTaskDialog>;
}
