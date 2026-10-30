import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { TaskPublicStatus, Task } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { userMessage } from "../../utils/api/messages";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { Glyph, Loading } from "../../components/Workspace/WorkspaceUI";
import { toneStyle } from "../../components/Workspace/sections";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { recordOwnChange, useOwnRevisions } from "../../components/Workspace/ownRevisions";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TaskStatusMenu.module.css";
import { publicStatusNames as statusNames, statusTones, taskStatus, taskTransitions } from "./trackerStatus";

const ResultDialog = lazy(() => import("./TaskResultDialog").then(module => ({ default: module.TaskResultDialog })));

/** Public workflow only. Hours, evaluations and accounting dates use their own protected forms. */
export function TaskStatusMenu({ task, variant = "chip", onChanged, onClosed }: { task: Task; variant?: "chip" | "actions"; onChanged?: () => void; onClosed?: (saved: Task) => void }) {
  const [open, setOpen] = useState(false), [resultOpen, setResultOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const { perform, refresh } = useWorkspaceActions(), own = useOwnRevisions();
  const state = taskStatus(task), transitions = taskTransitions(task);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const menu = ref.current?.querySelector<HTMLElement>('[role="menu"]');
    (menu?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu)?.focus();
    document.addEventListener("pointerdown", close);return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const choose = async (next: TaskPublicStatus) => {
    if (busy || !transitions.includes(next)) return;
    setOpen(false);trigger.current?.focus();setError("");setBusy(true);
    try {
      const saved = await perform(async () => { const saved = await tasksApi.changeStatus(task.task_id, { expected_revision: task.revision, status: next });recordOwnChange(own, `task:${task.task_id}`, task.revision, saved.revision);own.setQueryData(["tasks", task.task_id], saved);return saved; });
      onChanged?.();
      if (next === "closed") onClosed?.(saved);
    } catch (failure) { setError(userMessage(failure));await refresh(); } finally { setBusy(false); }
  };
  const take = async () => {
    if (busy || !task.capabilities.includes("take_task")) return;
    setError("");setBusy(true);
    try {
      await perform(async () => { const saved = await tasksApi.take(task.task_id, { expected_revision: task.revision });recordOwnChange(own, `task:${task.task_id}`, task.revision, saved.revision);own.setQueryData(["tasks", task.task_id], saved);return saved; });
      onChanged?.();
    } catch (failure) { setError(userMessage(failure));await refresh(); } finally { setBusy(false); }
  };
  return <div ref={ref} className={s.root} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();if (!open) return;
    if (event.key === "Escape") { event.preventDefault();setOpen(false);trigger.current?.focus();return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[index].focus();
  }}>
    {variant === "chip" ? <>
      <button ref={trigger} type="button" className={s.chip} style={toneStyle(statusTones[state])} aria-label={`Статус задачи: ${statusNames[state]}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}><span className={s.dot} /><span className={s.chipLabel}>{statusNames[state]}</span><Glyph name="expand_more" /></button>
      {open && <div role="menu" tabIndex={-1} aria-label="Выбор статуса задачи" className={s.menu}><p className={s.menuNote}>Общий статус задачи</p>{Object.entries(statusNames).map(([key, label]) => <button type="button" role="menuitem" className={s.option} key={key} disabled={!transitions.includes(key as TaskPublicStatus)} aria-current={key === state ? "true" : undefined} onClick={() => { void choose(key as TaskPublicStatus); }}><span className={s.menuDot} style={toneStyle(statusTones[key as TaskPublicStatus])} />{label}{key === state && <Glyph name="check" />}</button>)}</div>}
    </> : <div className={s.actions} aria-label="Действия с задачей">
      {task.capabilities.includes("take_task") && <button type="button" className={w.button} disabled={busy} onClick={() => { void take(); }}>Взять в работу</button>}
      {task.capabilities.includes("submit_task_result") && <button type="button" className={`${w.button} ${w.primary}`} disabled={busy} onClick={() => setResultOpen(true)}>Сдать результат</button>}
    </div>}
    {error && <p role="alert" className={w.error}>{error}</p>}
    {resultOpen && task.capabilities.includes("submit_task_result") && <UnsavedChangesScope><Suspense fallback={<Loading />}><ResultDialog task={task} onClose={() => setResultOpen(false)} onChanged={onChanged} /></Suspense></UnsavedChangesScope>}
  </div>;
}
