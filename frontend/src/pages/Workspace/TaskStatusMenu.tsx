import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TaskPublicStatus, Task } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { userMessage } from "../../utils/api/messages";
import { Glyph, Loading } from "../../components/Workspace/WorkspaceUI";
import { toneStyle } from "../../components/Workspace/sections";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useDialogHold, useTaskCommand } from "./taskCommands";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TaskStatusMenu.module.css";
import { publicStatusNames as statusNames, statusTones, taskStatus, taskTransitions } from "./trackerStatus";

/** Every status chip is as wide as the longest status name (owner 2026-11-01): the label box measures all of them. */
const chipSizer = Object.values(statusNames).join("\n");
function ChipLabel({ state }: { state: TaskPublicStatus }) {
  return <span className={s.chipLabel} data-sizer={chipSizer}><span>{statusNames[state]}</span></span>;
}
const ResultDialog = lazy(() => import("./TaskResultDialog").then(module => ({ default: module.TaskResultDialog })));

/** Public workflow only. Hours, evaluations and accounting dates use their own protected forms. */
export function TaskStatusMenu({ task, variant = "chip", onChanged, onClosed }: { task: Task; variant?: "chip" | "actions"; onChanged?: () => void; onClosed?: (saved: Task) => void }) {
  const [open, setOpen] = useState(false), [resultOpen, setResultOpen] = useState(false);
  // A queued result stays in its dialog after a status answer drops submit_task_result (TR-01 review).
  const resultHold = useDialogHold();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const run = useTaskCommand(task);
  const state = taskStatus(task), transitions = taskTransitions(task);
  const lockedHint = task.queue?.key === "KKR" ? "Статус контрольного эпика меняется автоматически." : state === "closed" ? "Переоткрыть задачу может только её автор." : "Сменить статус этой задачи нельзя.";
  const menu = useRef<HTMLDivElement>(null), [alignEnd, setAlignEnd] = useState(false);
  useLayoutEffect(() => {
    // A menu opened near the right edge of a table opens leftwards instead of widening the page.
    if (!open || !menu.current || !ref.current || window.matchMedia?.("(max-width: 768px)").matches) return;
    const width = menu.current.offsetWidth, anchor = ref.current.getBoundingClientRect();
    setAlignEnd(anchor.left + width > document.documentElement.clientWidth - 8 && anchor.right - width >= 8);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const menu = ref.current?.querySelector<HTMLElement>('[role="menu"]');
    (menu?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu)?.focus();
    document.addEventListener("pointerdown", close);return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  // While the status saves the chip is aria-disabled, not `disabled`: a disabled button drops the
  // keyboard focus it just got back from the menu to <body>.
  const choose = async (next: TaskPublicStatus) => {
    if (busy || !transitions.includes(next)) return;
    setOpen(false);trigger.current?.focus();setError("");setBusy(true);
    try {
      const saved = await run(expected => tasksApi.changeStatus(task.task_id, { expected_revision: expected, status: next }));
      onChanged?.();
      if (next === "closed") onClosed?.(saved);
    } catch (failure) { setError(userMessage(failure)); } finally { setBusy(false); }
  };
  const take = async () => {
    if (busy || !task.capabilities.includes("take_task")) return;
    setError("");setBusy(true);
    try {
      await run(expected => tasksApi.take(task.task_id, { expected_revision: expected }));
      onChanged?.();
    } catch (failure) { setError(userMessage(failure)); } finally { setBusy(false); }
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
    {variant === "chip" ? !transitions.length && !busy ? <span className={`${s.chip} ${s.static}`} style={toneStyle(statusTones[state])} role="img" aria-label={`Статус задачи: ${statusNames[state]}. ${lockedHint}`} title={lockedHint}><span className={s.dot} /><ChipLabel state={state} /></span> : <>
      <button ref={trigger} type="button" className={s.chip} style={toneStyle(statusTones[state])} aria-label={`Статус задачи: ${statusNames[state]}`} aria-haspopup="menu" aria-expanded={open} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => { if (!busy) setOpen(!open); }}><span className={s.dot} /><ChipLabel state={state} /><Glyph name="expand_more" /></button>
      {open && <div ref={menu} role="menu" tabIndex={-1} aria-label="Выбор статуса задачи" className={`${s.menu} ${alignEnd ? s.menuEnd : ""}`}><p className={s.menuNote}>Общий статус задачи</p>{Object.entries(statusNames).map(([key, label]) => <button type="button" role="menuitem" className={s.option} key={key} disabled={!transitions.includes(key as TaskPublicStatus)} aria-current={key === state ? "true" : undefined} onClick={() => { void choose(key as TaskPublicStatus); }}><span className={s.menuDot} style={toneStyle(statusTones[key as TaskPublicStatus])} />{label}{key === state && <Glyph name="check" />}</button>)}</div>}
    </> : <div className={s.actions} aria-label="Действия с задачей">
      {task.capabilities.includes("take_task") && <button type="button" className={w.button} disabled={busy} onClick={() => { void take(); }}>Взять в работу</button>}
      {task.capabilities.includes("submit_task_result") && <button type="button" className={`${w.button} ${w.primary}`} disabled={busy} onClick={() => setResultOpen(true)}>Сдать результат</button>}
    </div>}
    {error && <p role="alert" className={w.error}>{error}</p>}
    {resultOpen && (task.capabilities.includes("submit_task_result") || resultHold.held) && <UnsavedChangesScope><Suspense fallback={<Loading />}><ResultDialog task={task} onClose={() => { setResultOpen(false);resultHold.release(); }} onSend={resultHold.hold} onChanged={onChanged} /></Suspense></UnsavedChangesScope>}
  </div>;
}
