import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TaskType } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { canRetainData } from "../../utils/api/request";
import { userMessage } from "../../utils/api/messages";
import s from "./TrackerParentSelector.module.css";
import w from "../../components/Workspace/Workspace.module.css";

type ParentRef = { task_id: string; task_key?: string; title: string };
const label = (parent: ParentRef) => `${parent.task_key ?? "Задача"} · ${parent.title}`;
/** One combobox owns both searching and choosing a readable parent; raw query text is never a saved relation. */
export function TrackerParentSelector({ value, onChange, seasonId, taskId, initialParent, disabled = false, label: fieldLabel = "Родительская задача", taskType }: {
  value: string; onChange: (id: string) => void; seasonId?: string | null; taskId?: string; initialParent?: ParentRef | null; disabled?: boolean; label?: string; taskType?: TaskType;
}) {
  const id = useId(), root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<ParentRef | null>(null);
  const [open, setOpen] = useState(false), [search, setSearch] = useState(""), [active, setActive] = useState(0);
  const selected = useQuery({ queryKey: ["tasks", value], queryFn: () => tasksApi.get(value), enabled: !!value });
  const query = useQuery({ queryKey: ["tasks", "parent-combobox", seasonId === null ? "without-season" : seasonId ?? "", taskId ?? "", taskType ?? "", search], queryFn: () => tasksApi.listPage({ ...(seasonId ? { season_id: seasonId } : {}), q: search || undefined, ...(taskType ? { task_type: taskType } : {}), limit: 100 }), enabled: open && !disabled });
  const options = (query.error && !canRetainData(query.error) ? [] : query.data?.items ?? []).filter(task => task.task_id !== taskId && (seasonId === undefined || task.season_id === seasonId) && (!taskType || task.task_type === taskType));
  const refused = !!selected.error && !canRetainData(selected.error);
  const parent = refused ? null : selected.data?.task_id === value ? selected.data : selected.isLoading && picked?.task_id === value ? picked : initialParent?.task_id === value ? initialParent : null;
  const selectedLabel = value ? parent ? label(parent) : selected.isLoading ? "Загрузка задачи…" : "Недоступная задача" : "";
  const pick = (parentId: string) => { input.current?.focus();setPicked(options.find(option => option.task_id === parentId) ?? null);onChange(parentId);setOpen(false);setSearch(""); };
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div ref={root} className={`${w.field} ${s.root}`}>
    <label htmlFor={id}>{fieldLabel}</label>
    <div className={s.control}><input ref={input} id={id} name="parent_task" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open && options[active] ? `${id}-option-${active}` : undefined}
      disabled={disabled} value={open ? search : selectedLabel} placeholder="Название или ключ · необязательно" autoComplete="off"
      onFocus={() => { if (!disabled) { setOpen(true);setSearch("");setActive(0); } }}
      onChange={event => { setSearch(event.target.value);setOpen(true);setActive(0); }}
      onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={event => {
        if (event.key === "Escape" && open) { event.preventDefault();event.stopPropagation();setOpen(false);return; }
        if (event.key === "Enter") { event.preventDefault();if (open && options[active]) pick(options[active].task_id);else { setSearch("");setOpen(true); }return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();setOpen(true);
        if (!options.length) return;
        setActive(index => event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length);
      }} />
      {!!value && <button type="button" disabled={disabled} aria-label={fieldLabel === "Родительская задача" ? "Убрать родительскую задачу" : "Убрать выбранную задачу"} onClick={() => pick("")}>×</button>}
    </div>
    <input type="hidden" name="parent_task_id" value={value} />
    {open && !disabled && <div className={s.popup}>
      {query.isLoading && <p role="status">Ищем задачи…</p>}{query.error && <p role="alert">{userMessage(query.error)}</p>}
      <ul id={`${id}-options`} role="listbox" aria-label={fieldLabel === "Родительская задача" ? "Доступные родительские задачи" : "Доступные задачи для связи"}>{options.map((task, index) => <li id={`${id}-option-${index}`} key={task.task_id} role="option" aria-selected={value === task.task_id} data-active={active === index} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(task.task_id)}><strong>{task.task_key ?? "Задача"}</strong><span>{task.title}</span>{task.queue && <small>{task.queue.name}</small>}</li>)}</ul>
      {!query.isLoading && !query.error && !options.length && <p>Подходящих задач нет.</p>}
      {query.data?.next_cursor && <p>Показана часть задач. Уточните название или ключ.</p>}
    </div>}
  </div>;
}
