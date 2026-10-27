import { planningDraft, planningPayload, type PlanningDraft } from "./trackerStage2Drafts";
import { useState } from "react";
import type { Task, TaskPriority, TaskType } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { displayDate, moscowInput } from "../../utils/dates";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { taskTypeNames, taskPriorityNames } from "./trackerPlanning";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerTaskStage2.module.css";

export function TaskPlanningFields({ value, onChange, disabled = false, deadline }: { value: PlanningDraft; onChange: (value: PlanningDraft) => void; disabled?: boolean; deadline?: string }) {
  return <div className={s.planningFields}>
    <label className={w.field}>Тип задачи<select name="task_type" value={value.task_type} disabled={disabled} onChange={event => { const type = event.target.value as TaskType;onChange({ ...value, task_type: type, starts: type === "milestone" ? "" : value.starts }); }}>{Object.entries(taskTypeNames).map(([key,label]) => <option value={key} key={key}>{label}</option>)}</select></label>
    <label className={w.field}>Приоритет<select name="priority" value={value.priority} disabled={disabled} onChange={event => onChange({ ...value, priority: event.target.value as TaskPriority })}>{Object.entries(taskPriorityNames).map(([key,label]) => <option value={key} key={key}>{label}</option>)}</select></label>
    {value.task_type !== "milestone" ? <label className={w.field}>Плановое начало, МСК<input name="starts_at" type="datetime-local" value={value.starts} max={deadline && Number.isFinite(Date.parse(deadline)) ? moscowInput(deadline) : undefined} disabled={disabled} onChange={event => onChange({ ...value, starts: event.target.value })} /></label> : <p className={s.hint}>Веха — контрольная точка по дедлайну. Дата начала ей не нужна.</p>}
  </div>;
}
export function TaskPlanningEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const [draft, setDraft] = useState(() => planningDraft(task)), [busy, setBusy] = useState(false);
  const { perform, refresh } = useWorkspaceActions();
  return <TrackerTaskDialog title="Планирование задачи" onClose={onClose} busy={busy}>
    <ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} externalState={draft} savedExternalState={planningDraft(task)}
      onReplaceWithSaved={() => setDraft(planningDraft(task))} onConflict={refresh} submitLabel="Сохранить параметры" savedDetails={<p>{taskTypeNames[task.task_type ?? "task"]} · {taskPriorityNames[task.priority ?? "normal"]} · Начало: {displayDate(task.starts_at)}</p>}
      onSubmit={async (_, expectedRevision) => {
        const payload = planningPayload(draft);
        if (payload.starts_at && Date.parse(payload.starts_at) > Date.parse(task.deadline_at)) throw Error("Плановое начало не может быть позже дедлайна");
        setBusy(true);try { return await perform(() => tasksApi.update(task.task_id, { expected_revision: expectedRevision!, ...payload })); } finally { setBusy(false); }
      }}>
      <TaskPlanningFields value={draft} onChange={setDraft} disabled={busy} deadline={task.deadline_at} />
      <p className={s.hint}>Эпик объединяет работу по результату, веха — по сроку. Добавляйте задачи к ним через связи. Плановые даты не меняют учёт ККР.</p>
    </ActionForm>
  </TrackerTaskDialog>;
}
