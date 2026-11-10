import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TaskPublicStatus, Task } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { userMessage } from "../../utils/api/messages";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import { toneStyle } from "../../components/Workspace/sections";
import { useDialogHold, useTaskCommand } from "./taskCommands";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { TaskInitialSeasonEditor } from "./TaskSeasonDialog";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TaskStatusMenu.module.css";
import { publicStatusNames as statusNames, statusTones, taskStatus, taskTransitions } from "./trackerStatus";

/** Every status chip is as wide as the longest status name (owner 2026-11-01): the label box measures all of them. */
const chipSizer = Object.values(statusNames).join("\n");
function ChipLabel({ state }: { state: TaskPublicStatus }) {
  return <span className={s.chipLabel} data-sizer={chipSizer}><span>{statusNames[state]}</span></span>;
}

/** Public workflow only. Hours, evaluations and accounting dates use their own protected forms.
 *  There is no «Взять в работу» or «Сдать результат»: results go into comments (owner 2026-11-08, В6). */
export function TaskStatusMenu({ task, onChanged, onClosed }: { task: Task; onChanged?: () => void; onClosed?: (saved: Task) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [choosingSeason, setChoosingSeason] = useState(false), hold = useDialogHold();
  const closeSeason = () => { setChoosingSeason(false);hold.release();trigger.current?.focus(); };
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
    setOpen(false);trigger.current?.focus();setError("");
    if (next === "closed" && task.scope.kind === "block" && !task.season_id) { setChoosingSeason(true);return; }
    setBusy(true);
    try {
      const saved = await run(expected => tasksApi.changeStatus(task.task_id, { expected_revision: expected, status: next }));
      onChanged?.();
      if (next === "closed") onClosed?.(saved);
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
    {!transitions.length && !busy ? <span className={`${s.chip} ${s.static}`} style={toneStyle(statusTones[state])} role="img" aria-label={`Статус задачи: ${statusNames[state]}. ${lockedHint}`} title={lockedHint}><span className={s.dot} /><ChipLabel state={state} /></span> : <>
      <button ref={trigger} type="button" className={s.chip} style={toneStyle(statusTones[state])} aria-label={`Статус задачи: ${statusNames[state]}`} aria-haspopup="menu" aria-expanded={open} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => { if (!busy) setOpen(!open); }}><span className={s.dot} /><ChipLabel state={state} /><Glyph name="expand_more" /></button>
      {open && <div ref={menu} role="menu" tabIndex={-1} aria-label="Выбор статуса задачи" className={`${s.menu} ${alignEnd ? s.menuEnd : ""}`}><p className={s.menuNote}>Общий статус задачи</p>{Object.entries(statusNames).map(([key, label]) => <button type="button" role="menuitem" className={s.option} key={key} disabled={!transitions.includes(key as TaskPublicStatus)} aria-current={key === state ? "true" : undefined} onClick={() => { void choose(key as TaskPublicStatus); }}><span className={s.menuDot} style={toneStyle(statusTones[key as TaskPublicStatus])} />{label}{key === state && <Glyph name="check" />}</button>)}</div>}
    </>}
    {error && <p role="alert" className={w.error}>{error}</p>}
    {choosingSeason && <UnsavedChangesScope><TrackerTaskDialog title="Сезон перед закрытием задачи" onClose={closeSeason}><TaskInitialSeasonEditor task={task} closeTask onSending={hold.hold} onSaved={saved => { closeSeason();onChanged?.();onClosed?.(saved); }} /></TrackerTaskDialog></UnsavedChangesScope>}
  </div>;
}
