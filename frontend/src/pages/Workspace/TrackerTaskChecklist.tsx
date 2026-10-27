import { checklistDraft, checklistPayload, type ChecklistDraft } from "./trackerStage2Drafts";
import { useState } from "react";
import type { Task } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { can } from "../../utils/session";
import { userMessage } from "../../utils/api/messages";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { useOwnRevisions, recordOwnChange } from "../../components/Workspace/ownRevisions";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import s from "./TrackerTaskStage2.module.css";
import w from "../../components/Workspace/Workspace.module.css";
export function ChecklistDraftFields({ items, onChange, disabled = false }: { items: ChecklistDraft[]; onChange: (items: ChecklistDraft[]) => void; disabled?: boolean }) {
  const move = (index: number, direction: number) => { const next = [...items];[next[index], next[index+direction]] = [next[index+direction], next[index]];onChange(next); };
  return <div className={s.draftList}>
    {items.map((item, index) => <div className={s.draftRow} key={item.key}>
      <label className={s.draftCheck}><input type="checkbox" checked={item.checked} disabled={disabled} aria-label={`Выполнен пункт ${index+1}`} onChange={event => onChange(items.map((row,i) => i === index ? { ...row, checked: event.target.checked } : row))} /></label>
      <input aria-label={`Пункт чеклиста ${index+1}`} name={`checklist-${index}`} value={item.text} placeholder="Что нужно сделать" required maxLength={1000} disabled={disabled} onChange={event => onChange(items.map((row,i) => i === index ? { ...row, text: event.target.value } : row))} />
      <div className={s.itemActions}><button type="button" className={s.itemAction} aria-label={`Поднять пункт ${index+1}`} disabled={disabled || index===0} onClick={() => move(index,-1)}>↑</button><button type="button" className={s.itemAction} aria-label={`Опустить пункт ${index+1}`} disabled={disabled || index===items.length-1} onClick={() => move(index,1)}>↓</button><button type="button" className={s.itemAction} aria-label={`Удалить пункт ${index+1}`} disabled={disabled} onClick={() => onChange(items.filter((_,i) => i!==index))}>×</button></div>
    </div>)}
    <button type="button" className={s.subtle} disabled={disabled || items.length>=200} onClick={() => onChange([...items,{ key: crypto.randomUUID(), text: "", checked: false }])}>+ Добавить пункт</button>
  </div>;
}
export function TrackerTaskChecklist({ task }: { task: Task }) {
  const items = task.checklist ?? [], allowed = can(task,"edit_task_checklist"), toggleAllowed = can(task,"toggle_task_checklist"), done = items.filter(item => item.checked).length;
  const [editing,setEditing] = useState(false),[busy,setBusy] = useState(false),[error,setError] = useState("");
  const { perform, refresh } = useWorkspaceActions(), own = useOwnRevisions();
  if (!items.length && !allowed) return null;
  const toggle = async (itemId: string, checked: boolean) => {
    if (busy) return;setBusy(true);setError("");
    try { await perform(async () => { const saved = await tasksApi.toggleChecklist(task.task_id,itemId,{ expected_revision: task.revision, checked });recordOwnChange(own,`task:${task.task_id}`,task.revision,saved.revision);own.setQueryData(["tasks",task.task_id],saved);return saved; }); }
    catch(failure) { setError(userMessage(failure));await refresh(); } finally { setBusy(false); }
  };
  return <section className={s.section} aria-label="Чеклист задачи">
    <div className={s.heading}><h2>Чеклист</h2><div className={s.headingActions}>{!!items.length && <span className={s.count}>{done} из {items.length}</span>}{allowed && <button type="button" className={s.subtle} disabled={busy} onClick={() => setEditing(true)}>{items.length ? "Изменить пункты" : "+ Добавить чеклист"}</button>}</div></div>
    {!!items.length && <><div className={s.progress} role="progressbar" aria-label="Выполнение чеклиста" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}><span style={{ width: `${done/items.length*100}%` }} /></div><ul className={s.checklist}>{items.map(item => <li key={item.item_id}><label className={s.check} data-checked={item.checked}><input type="checkbox" checked={item.checked} disabled={!toggleAllowed || busy || editing} onChange={event => { void toggle(item.item_id,event.target.checked); }} /><span>{item.text}</span></label></li>)}</ul></>}
    {busy && <p role="status" className={s.hint}>Сохраняем отметку…</p>}{error && <p role="alert" className={w.error}>{error}</p>}
    {editing && allowed && <UnsavedChangesScope><ChecklistEditor task={task} onClose={() => setEditing(false)} /></UnsavedChangesScope>}
  </section>;
}
function ChecklistEditor({ task,onClose }: { task: Task; onClose: () => void }) {
  const [items,setItems] = useState(() => checklistDraft(task.checklist)),[busy,setBusy] = useState(false);const { perform,refresh } = useWorkspaceActions();
  return <TrackerTaskDialog title="Чеклист задачи" onClose={onClose} busy={busy}><ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} externalState={checklistPayload(items)} savedExternalState={checklistPayload(checklistDraft(task.checklist))} onReplaceWithSaved={() => setItems(checklistDraft(task.checklist))} onConflict={refresh} submitLabel="Сохранить чеклист"
    savedDetails={<ul>{task.checklist?.map(item => <li key={item.item_id}>{item.checked ? "✓ " : ""}{item.text}</li>)}</ul>}
    onSubmit={async (_,expectedRevision) => { const payload = checklistPayload(items);if(payload.some(item=>!item.text))throw Error("Заполните текст каждого пункта");setBusy(true);try { const saved = await perform(()=>tasksApi.update(task.task_id,{expected_revision:expectedRevision!,checklist:payload}));onClose();return saved; } finally {setBusy(false);} }}>
    <ChecklistDraftFields items={items} onChange={setItems} disabled={busy} />
  </ActionForm></TrackerTaskDialog>;
}
