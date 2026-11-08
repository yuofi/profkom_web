import { useId, useState } from "react";
import { Link } from "react-router-dom";
import type { Task, TaskLinkKind, TaskType, TrackerTaskRef } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { can } from "../../utils/session";
import { userMessage } from "../../utils/api/messages";
import { getTaskCreateRoute, getTaskRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { useDialogHold, useTaskCommand, useTaskFormCommand } from "./taskCommands";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { TrackerParentSelector } from "./TrackerParentSelector";
import { TaskStatusBadge } from "./TaskStatusBadge";
import s from "./TrackerTaskStage2.module.css";
import w from "../../components/Workspace/Workspace.module.css";
const relationNames: Record<TaskLinkKind,string> = { related:"Связана с", blocks:"Блокирует", blocked_by:"Зависит от", epic:"Входит в эпик", epic_member:"Задачи эпика", milestone:"Входит в вехи", milestone_member:"Задачи вехи" };
type LinkChoice=TaskLinkKind|"parent";
const kindChoices: Record<LinkChoice,string> = { parent:"Родительская задача", related:"Связана с", blocks:"Блокирует", blocked_by:"Зависит от", epic:"Входит в эпик", epic_member:"Добавить задачу в эпик", milestone:"Входит в веху", milestone_member:"Добавить задачу в веху" };
/** One line per kind, as the server treats it (tracker_stage2.py): a dependency only warns, until the task
 *  waited for is «Закрыта», and never stops a status change. */
const kindHelp: Record<LinkChoice,string> = {
  parent:"Эта задача станет подзадачей выбранной", related:"Ссылка в обе стороны, ни на что не влияет",
  blocks:"Выбранная ждёт эту: предупреждение, пока эта не «Закрыта»", blocked_by:"Эта ждёт выбранную: предупреждение, пока та не «Закрыта»",
  epic:"Задача войдёт в эпик; эпик у задачи один", epic_member:"Выбранная задача войдёт в этот эпик; эпик у задачи один",
  milestone:"Задача относится к контрольной точке плана", milestone_member:"Выбранная задача будет отнесена к этой вехе",
};
function TaskReference({ task }: {task:TrackerTaskRef}) {return <Link className={s.taskLink} to={getTaskRoute(task.task_id)}><strong>{task.task_key}</strong><span>{task.title}</span><TaskStatusBadge status={task.status} className={s.taskStatus}/></Link>;}
/** `editing`/`onEditingChange` let the task card open the link editor from elsewhere. */
export function TrackerTaskRelations({task,onEditParent,editing:openedOutside,onEditingChange}:{task:Task;onEditParent:()=>void;editing?:boolean;onEditingChange?:(open:boolean)=>void}) {
  const allowed=can(task,"manage_task_links"),parentEditable=can(task,"edit_task"),links=task.links??[];
  const [editingHere,setEditingHere]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const editing=openedOutside??editingHere,setEditing=onEditingChange??setEditingHere;
  const {refresh}=useWorkspaceActions(),run=useTaskCommand(task),linkHold=useDialogHold();
  const blocked=links.filter(link=>link.kind==="blocked_by" && link.task.status!=="closed");
  // Queued with the card's other commands, so a link removed right after a checkmark is not refused as stale.
  const remove=async(id:string)=>{if(busy)return;setBusy(true);setError("");try{await run(expected=>tasksApi.removeLink(task.task_id,id,{expected_revision:expected}));}catch(failure){setError(userMessage(failure));await refresh();}finally{setBusy(false);}};
  return <section id="task-relations" className={s.section} aria-label="Связанные задачи">
    <div className={s.heading}><h2>Связанные задачи</h2><div className={s.headingActions}>{task.queue && can(task,"edit_task") && <Link className={s.subtle} to={getTaskCreateRoute({queueId:task.queue.queue_id,parentTaskId:task.task_id})}>+ Создать подзадачу</Link>}{(allowed||parentEditable)&&<button type="button" className={s.subtle} disabled={busy} onClick={()=>setEditing(true)} aria-label="Добавить связь">+ Добавить связь</button>}</div></div>
    {!!blocked.length&&<p className={s.notice}>Есть незавершённые зависимости: {blocked.map(link=>link.task.task_key).join(", ")}. Рабочий статус можно менять независимо.</p>}
    <div className={s.relationGroups}>
      <div className={s.relationGroup}><h3>Родительская задача</h3><div className={s.relationRow}>{task.parent_task ? <Link className={s.taskLink} to={getTaskRoute(task.parent_task.task_id)}><strong>{task.parent_task.task_key}</strong><span>{task.parent_task.title}</span></Link>:<span className={s.hint}>{task.parent_task_unavailable?"Недоступна":"Не выбрана"}</span>}{parentEditable&&<button type="button" className={s.subtle} onClick={onEditParent}>Изменить родительскую задачу</button>}</div></div>
      {!!task.children?.length&&<div className={s.relationGroup}><h3>Подзадачи</h3><ul className={s.relationList}>{task.children.map(child=><li key={child.task_id}><TaskReference task={child}/></li>)}</ul></div>}
      {(Object.keys(relationNames)as TaskLinkKind[]).map(kind=>{const group=links.filter(link=>link.kind===kind);return !!group.length&&<div className={s.relationGroup} key={kind}><h3>{relationNames[kind]}</h3><ul className={s.relationList}>{group.map(link=><li className={s.relationRow} key={link.link_id}><TaskReference task={link.task}/>{allowed&&!link.managed&&<button type="button" className={s.itemAction} disabled={busy} aria-label={`Удалить связь: ${link.task.task_key}`} onClick={()=>{void remove(link.link_id);}}>×</button>}</li>)}</ul></div>;})}
    </div>
    {error&&<p role="alert" className={w.error}>{error}</p>}
    {editing&&(allowed||parentEditable||linkHold.held)&&<UnsavedChangesScope><LinkEditor task={task} onSend={linkHold.hold} onClose={()=>{setEditing(false);linkHold.release();}}/></UnsavedChangesScope>}
  </section>;
}
function LinkEditor({task,onClose,onSend}:{task:Task;onClose:()=>void;onSend?:()=>void}) {
  const [kind,setKind]=useState<LinkChoice>("related"),[target,setTarget]=useState(""),[busy,setBusy]=useState(false);const {refresh}=useWorkspaceActions(),save=useTaskFormCommand(task.task_id,onSend),reasonId=useId();
  const type=task.task_type??"task",allowed=can(task,"manage_task_links"),hasEpic=task.links?.some(link=>link.kind==="epic");
  const choices=(Object.keys(kindChoices)as LinkChoice[]).filter(key=>key==="parent"?can(task,"edit_task"):allowed&&(key==="epic"||key==="milestone"?type==="task":key==="epic_member"?type==="epic":key==="milestone_member"?type==="milestone":true));
  // A held dialog (useDialogHold) whose rights are gone keeps the chosen kind and target in sight.
  const actualKind=choices.includes(kind)?kind:choices[0]??kind,targetType:TaskType|undefined=actualKind==="epic"?"epic":actualKind==="milestone"?"milestone":["epic_member","milestone_member"].includes(actualKind)?"task":undefined;
  // A chosen epic dims «Входит в эпик» with the reason below; a held dialog without rights dims the kind it keeps.
  const epicTaken=!!hasEpic&&type==="task",unavailable:Partial<Record<LinkChoice,string>>=!choices.length?{[actualKind]:""}:epicTaken?{epic:reasonId}:{};
  return <TrackerTaskDialog title="Добавить связь" onClose={onClose} busy={busy}><ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} externalState={{kind:actualKind,target}} savedExternalState={{kind:choices.includes("related")?"related":choices[0],target:""}} onReplaceWithSaved={()=>{setKind(choices.includes("related")?"related":choices[0]);setTarget("");}} onConflict={refresh} submitLabel="Добавить связь"
    onSubmit={async(_,expectedRevision)=>{if(!target)throw Error("Выберите доступную задачу для связи");setBusy(true);try{const saved=await save(expectedRevision!,expected=>actualKind==="parent"?tasksApi.update(task.task_id,{expected_revision:expected,parent_task_id:target}):tasksApi.addLink(task.task_id,{expected_revision:expected,target_task_id:target,kind:actualKind}));onClose();return saved;}finally{setBusy(false);}}}>
    <KindCards choices={choices.length?choices:[actualKind]} value={actualKind} unavailable={unavailable} disabled={busy} onChange={value=>{setKind(value);setTarget("");}}/>
    <TrackerParentSelector key={`${actualKind}:${targetType??"any"}`} value={target} onChange={setTarget} taskId={task.task_id} seasonId={task.season_id} taskType={targetType} label="Связанная задача" disabled={busy}/>
    {epicTaken&&<p id={reasonId} className={s.hint}>У задачи уже выбран эпик. Чтобы заменить его, сначала удалите прежнюю связь.</p>}
  </ActionForm></TrackerTaskDialog>;
}
/** The kinds of link as radio cards (owner 2026-11-08, В1, variant Б): every kind the task's type allows at once,
 *  each with its line of explanation. A kind in `unavailable` stays in sight, dimmed, and cannot be chosen; its
 *  value is the id of the element saying why ("" when none does). */
function KindCards({choices,value,unavailable,disabled,onChange}:{choices:LinkChoice[];value:LinkChoice;unavailable:Partial<Record<LinkChoice,string>>;disabled:boolean;onChange:(kind:LinkChoice)=>void}) {
  const id=useId();
  return <fieldset className={s.kindCards} disabled={disabled}><legend>Тип связи</legend><div className={s.kindGrid}>
    {choices.map(key=>{const why=unavailable[key],off=why!==undefined,help=`${id}-${key}-help`;return <label className={s.kindCard} key={key} data-unavailable={off||undefined}>
      <input type="radio" name="relation_kind" value={key} checked={value===key} disabled={off} aria-labelledby={`${id}-${key}`} aria-describedby={why?`${help} ${why}`:help} onChange={()=>onChange(key)}/>
      <span id={`${id}-${key}`} className={s.kindName}>{kindChoices[key]}</span><span id={help} className={s.kindHelp}>{kindHelp[key]}</span>
    </label>;})}
  </div></fieldset>;
}
