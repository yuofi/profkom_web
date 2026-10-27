import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task, TaskPriority, TaskType } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { userMessage } from "../../utils/api/messages";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { recordOwnChange, useOwnRevisions } from "../../components/Workspace/ownRevisions";
import { ownedLayerTarget, useAnchoredLayer } from "../../components/Workspace/useAnchoredLayer";
import { classificationCapabilities, classificationLabels, classificationOptions, taskClassificationValue, type TaskClassificationField, type TaskClassificationValue } from "./taskClassification";
import s from "./TaskClassificationMenu.module.css";

/** Decorative identity; icon-only controls supply their own accessible field label. */
export function TaskClassificationIcon({ field, value, onBrand = false, className = "" }: { field: TaskClassificationField; value: TaskClassificationValue; onBrand?: boolean; className?: string }) {
  return <svg className={`${s.icon} ${onBrand ? s.onBrand : ""} ${className}`} data-field={field} data-value={value} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
    {field === "task_type" ? value === "milestone" ? <><path d="m12 3 9 9-9 9-9-9Z" /><circle cx="12" cy="12" r="2" /></> : value === "epic" ? <path d="m13.5 2-9 12H11l-.5 8 9-13H13l.5-7Z" /> : <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></>
      : value === "low" ? <path d="m6 9 6 6 6-6" /> : value === "urgent" ? <><path d="m6 8 6-5 6 5M6 14l6-5 6 5M6 20l6-5 6 5" /></> : value === "high" ? <path d="m6 11 6-5 6 5M6 18l6-5 6 5" /> : <path d="m6 15 6-6 6 6" />}
  </svg>;
}
export function TaskClassificationMenu({ task, field, iconOnly = false, onBrand = false }: { task: Task; field: TaskClassificationField; iconOnly?: boolean; onBrand?: boolean }) {
  const current = taskClassificationValue(task, field), choices = classificationOptions[field], heading = classificationLabels[field], label = choices.find(option => option.value === current)?.label ?? "Не задано";
  const allowed = task.capabilities.includes(classificationCapabilities[field]);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), errorLayer = useRef<HTMLDivElement>(null), entry = useRef<"current" | "first" | "last">("current");
  const menuId = `task-classification-${useId()}`, portal = useAnchoredLayer(open && allowed, trigger, menu, 250);
  const errorPortal = useAnchoredLayer(!!error, trigger, errorLayer, 300);
  const { perform, refresh } = useWorkspaceActions(), own = useOwnRevisions();
  const close = useCallback(() => setOpen(false), []);
  useLayoutEffect(() => {
    if (!open || !allowed || !portal || !menu.current) return;
    const options = [...menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const selected = options.find(option => option.getAttribute("aria-checked") === "true");
    const focus = entry.current === "last" ? options.at(-1) : entry.current === "first" ? options[0] : selected ?? options[0];
    focus?.focus();
    const button = trigger.current;return () => { if (button?.isConnected) button.focus(); };
  }, [open, allowed, portal]);
  useEffect(() => {
    if (!open || !allowed) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("dialog") && event.target.closest("dialog") !== menu.current?.closest("dialog")) return;
      if (!ownedLayerTarget(event.target, menu.current) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);return () => document.removeEventListener("pointerdown", outside);
  }, [open, allowed, close]);
  const choose = async (next: TaskClassificationValue) => {
    if (saving.current || !allowed) return;
    close();if (next === current) return;saving.current = true;setBusy(true);setError("");
    try {
      await perform(async () => {
        const saved = await tasksApi.update(task.task_id, { expected_revision: task.revision, ...(field === "task_type" ? { task_type: next as TaskType } : { priority: next as TaskPriority }) });
        recordOwnChange(own, `task:${task.task_id}`, task.revision, saved.revision);own.setQueryData(["tasks", task.task_id], saved);return saved;
      });
    } catch (failure) { setError(userMessage(failure));await refresh(); } finally { saving.current = false;setBusy(false); }
  };
  return <span className={`${s.root} ${onBrand ? s.onBrand : ""}`} data-row-action onClick={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation();if (event.key === "Escape" && open) { event.preventDefault();close(); } }}>
    <button ref={trigger} type="button" className={`${s.trigger} ${iconOnly ? s.iconOnly : ""}`} disabled={!allowed} aria-disabled={busy || !allowed} aria-busy={busy} aria-label={`${heading}: ${label}`} title={`${heading}: ${label}`} aria-haspopup="menu" aria-expanded={open && allowed} aria-controls={open && allowed ? menuId : undefined} aria-describedby={error ? `${menuId}-error` : undefined}
      onClick={() => { if (saving.current || !allowed) return;entry.current = "current";setError("");setOpen(value => !value); }} onKeyDown={event => {
        event.stopPropagation();if (!allowed || saving.current || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();setError("");entry.current = event.key === "ArrowUp" ? "last" : "first";setOpen(true);
      }}><TaskClassificationIcon field={field} value={current} />{!iconOnly && <><span>{label}</span><svg className={s.caret} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></>}</button>
    {error && errorPortal && createPortal(<div ref={errorLayer} id={`${menuId}-error`} role="alert" className={s.error} onClick={event => event.stopPropagation()}>{error}</div>, errorPortal)}
    {open && allowed && portal && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={`Выбор: ${heading.toLowerCase()}`} tabIndex={-1} className={s.menu} data-row-action data-classification-menu onClick={event => event.stopPropagation()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault();close();return; }
      if (event.key === "Tab") { close();return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;event.preventDefault();
      const options = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])];if (!options.length) return;
      const active = options.indexOf(document.activeElement as HTMLButtonElement), index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[index].focus();
    }}><p className={s.menuHeading}>{heading}</p>{choices.map(option => <button type="button" role="menuitemradio" key={option.value} aria-checked={option.value === current} tabIndex={-1} className={s.option} onClick={() => { void choose(option.value); }}><TaskClassificationIcon field={field} value={option.value} /><span>{option.label}</span>{option.value === current && <svg className={s.check} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}</button>)}</div>, portal)}
  </span>;
}
