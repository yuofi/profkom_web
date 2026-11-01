import { createClientId } from "../../utils/clientId";
import { checklistDraft, checklistPayload, type ChecklistDraft } from "./trackerStage2Drafts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Task } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { can } from "../../utils/session";
import { userMessage } from "../../utils/api/messages";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { useDialogHold, useTaskCommand, useTaskFormCommand } from "./taskCommands";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import s from "./TrackerTaskStage2.module.css";
import w from "../../components/Workspace/Workspace.module.css";
export function ChecklistDraftFields({ items, onChange, disabled = false }: { items: ChecklistDraft[]; onChange: (items: ChecklistDraft[]) => void; disabled?: boolean }) {
  const move = (index: number, direction: number) => { const next = [...items];[next[index], next[index+direction]] = [next[index+direction], next[index]];onChange(next); };
  const fields = useRef(new Map<string, HTMLInputElement>()), add = useRef<HTMLButtonElement>(null), focusKey = useRef<string | null>(null);
  useEffect(() => { if (focusKey.current === null) return;(fields.current.get(focusKey.current) ?? add.current)?.focus();focusKey.current = null; });
  // Inside a form Enter must not submit an unfinished checklist: it adds the next item, and
  // Backspace in an empty item removes it, as in a list editor.
  const keys = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();if (items.length >= 200) return;
      const item = { key: createClientId(), text: "", checked: false };focusKey.current = item.key;onChange([...items.slice(0, index + 1), item, ...items.slice(index + 1)]);
    } else if (event.key === "Backspace" && !event.currentTarget.value) {
      event.preventDefault();focusKey.current = items[index - 1]?.key ?? items[index + 1]?.key ?? "";onChange(items.filter((_, i) => i !== index));
    }
  };
  return <div className={s.draftList}>
    {items.map((item, index) => <div className={s.draftRow} key={item.key}>
      <label className={s.draftCheck}><input type="checkbox" checked={item.checked} disabled={disabled} aria-label={`Выполнен пункт ${index+1}`} onChange={event => onChange(items.map((row,i) => i === index ? { ...row, checked: event.target.checked } : row))} /></label>
      <input ref={field => { if (field) fields.current.set(item.key, field);else fields.current.delete(item.key); }} aria-label={`Пункт чеклиста ${index+1}`} name={`checklist-${index}`} value={item.text} enterKeyHint="next" onKeyDown={event => keys(event, index)} placeholder="Что нужно сделать" required maxLength={1000} disabled={disabled} onChange={event => onChange(items.map((row,i) => i === index ? { ...row, text: event.target.value } : row))} />
      <div className={s.itemActions}><button type="button" className={s.itemAction} aria-label={`Поднять пункт ${index+1}`} disabled={disabled || index===0} onClick={() => move(index,-1)}>↑</button><button type="button" className={s.itemAction} aria-label={`Опустить пункт ${index+1}`} disabled={disabled || index===items.length-1} onClick={() => move(index,1)}>↓</button><button type="button" className={s.itemAction} aria-label={`Удалить пункт ${index+1}`} disabled={disabled} onClick={() => onChange(items.filter((_,i) => i!==index))}>×</button></div>
    </div>)}
    <button ref={add} type="button" className={s.subtle} disabled={disabled || items.length>=200} onClick={() => { const item = { key: createClientId(), text: "", checked: false };focusKey.current = item.key;onChange([...items,item]); }}>+ Добавить пункт</button>
  </div>;
}
export function TrackerTaskChecklist({ task }: { task: Task }) {
  const items = task.checklist ?? [], allowed = can(task,"edit_task_checklist"), toggleAllowed = can(task,"toggle_task_checklist"), done = items.filter(item => item.checked).length;
  const [editing,setEditing] = useState(false),[pending,setPending] = useState<readonly string[]>([]),[error,setError] = useState("");
  const saving = useRef(new Set<string>()), run = useTaskCommand(task);
  // The item editor whose save is queued stays open after an earlier answer drops its capability (TR-01 review).
  const editorHold = useDialogHold(), closeEditor = () => { setEditing(false);editorHold.release(); };
  if (!items.length && !allowed && !editorHold.held) return null;
  const toggle = async (itemId: string, checked: boolean) => {
    if (saving.current.has(itemId)) return;
    saving.current.add(itemId);setPending([...saving.current]);setError("");
    try { await run(expected => tasksApi.toggleChecklist(task.task_id,itemId,{ expected_revision: expected, checked }), current => ({ ...current, checklist: current.checklist?.map(item => item.item_id === itemId ? { ...item, checked } : item) })); }
    catch(failure) { setError(userMessage(failure)); } finally { saving.current.delete(itemId);setPending([...saving.current]); }
  };
  if (!items.length) return <section className={`${s.section} ${s.emptySection}`} aria-label="Чеклист задачи">
    <button type="button" className={s.subtle} onClick={() => setEditing(true)}>+ Добавить чеклист</button>
    {editing && <UnsavedChangesScope><ChecklistEditor task={task} onClose={closeEditor} onSend={editorHold.hold} /></UnsavedChangesScope>}
  </section>;
  return <section className={s.section} aria-label="Чеклист задачи">
    <div className={s.heading}><div className={s.headingTitle}><h2>Чеклист</h2><span role="status" className={s.saving}>{pending.length ? "Сохраняем…" : ""}</span></div><div className={s.headingActions}>{!!items.length && <span className={s.count}>{done} из {items.length}</span>}{allowed && <button type="button" className={s.subtle} disabled={!!pending.length} onClick={() => setEditing(true)}>{items.length ? "Изменить пункты" : "+ Добавить чеклист"}</button>}</div></div>
    {!!items.length && <><div className={s.progress} role="progressbar" aria-label="Выполнение чеклиста" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}><span style={{ width: `${done/items.length*100}%` }} /></div><ul className={s.checklist}>{items.map(item => <li key={item.item_id}><label className={s.check} data-checked={item.checked}><input type="checkbox" checked={item.checked} disabled={!toggleAllowed || editing || pending.includes(item.item_id)} aria-busy={pending.includes(item.item_id) || undefined} onChange={event => { void toggle(item.item_id,event.target.checked); }} /><span>{item.text}</span></label></li>)}</ul></>}
    {error && <p role="alert" className={w.error}>{error}</p>}
    {editing && (allowed || editorHold.held) && <UnsavedChangesScope><ChecklistEditor task={task} onClose={closeEditor} onSend={editorHold.hold} /></UnsavedChangesScope>}
  </section>;
}
function ChecklistEditor({ task,onClose,onSend }: { task: Task; onClose: () => void; onSend?: () => void }) {
  const [items,setItems] = useState(() => checklistDraft(task.checklist)),[busy,setBusy] = useState(false);const { refresh } = useWorkspaceActions(),save = useTaskFormCommand(task.task_id,onSend);
  return <TrackerTaskDialog title="Чеклист задачи" onClose={onClose} busy={busy}><ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} externalState={checklistPayload(items)} savedExternalState={checklistPayload(checklistDraft(task.checklist))} onReplaceWithSaved={() => setItems(checklistDraft(task.checklist))} onConflict={refresh} submitLabel="Сохранить чеклист"
    savedDetails={<ul>{task.checklist?.map(item => <li key={item.item_id}>{item.checked ? "✓ " : ""}{item.text}</li>)}</ul>}
    onSubmit={async (_,expectedRevision) => { const payload = checklistPayload(items);if(payload.some(item=>!item.text))throw Error("Заполните текст каждого пункта");setBusy(true);try { const saved = await save(expectedRevision!,expected=>tasksApi.update(task.task_id,{expected_revision:expected,checklist:payload}));onClose();return saved; } finally {setBusy(false);} }}>
    <ChecklistDraftFields items={items} onChange={setItems} disabled={busy} />
  </ActionForm></TrackerTaskDialog>;
}
