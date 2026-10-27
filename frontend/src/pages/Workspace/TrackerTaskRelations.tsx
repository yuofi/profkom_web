import { useState } from "react";
import { Link } from "react-router-dom";
import type { Task, TaskLinkKind, TaskType, TrackerTaskRef } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { can } from "../../utils/session";
import { userMessage } from "../../utils/api/messages";
import { getTaskCreateRoute, getTaskRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { useOwnRevisions, recordOwnChange } from "../../components/Workspace/ownRevisions";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { TrackerParentSelector } from "./TrackerParentSelector";
import { statusNames } from "./trackerStatus";
import s from "./TrackerTaskStage2.module.css";
import w from "../../components/Workspace/Workspace.module.css";
const relationNames: Record<TaskLinkKind,string> = { related:"Связана с", blocks:"Блокирует", blocked_by:"Зависит от", epic:"Входит в эпик", epic_member:"Задачи эпика", milestone:"Входит в вехи", milestone_member:"Задачи вехи" };
const kindChoices: Record<TaskLinkKind|string,string> = { parent:"Родительская задача", related:"Связана с", blocks:"Блокирует", blocked_by:"Зависит от", epic:"Входит в эпик", epic_member:"Добавить задачу в эпик", milestone:"Входит в веху", milestone_member:"Добавить задачу в веху" };
function TaskReference({ task }: {task:TrackerTaskRef}) {return <Link className={s.taskLink} to={getTaskRoute(task.task_id)}><strong>{task.task_key}</strong><span>{task.title}</span><small>{statusNames[task.status]}</small></Link>;}
export function TrackerTaskRelations({task,onEditParent}:{task:Task;onEditParent:()=>void}) {
  const allowed=can(task,"manage_task_links"),parentEditable=can(task,"edit_task"),links=task.links??[];
  const [editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const {perform,refresh}=useWorkspaceActions(),own=useOwnRevisions();
  const blocked=links.filter(link=>link.kind==="blocked_by" && !["accepted","not_completed","cancelled"].includes(link.task.status));
  const remove=async(id:string)=>{if(busy)return;setBusy(true);setError("");try{await perform(async()=>{const saved=await tasksApi.removeLink(task.task_id,id,{expected_revision:task.revision});recordOwnChange(own,`task:${task.task_id}`,task.revision,saved.revision);own.setQueryData(["tasks",task.task_id],saved);return saved;});}catch(failure){setError(userMessage(failure));await refresh();}finally{setBusy(false);}};
  return <section id="task-relations" className={s.section} aria-label="Связанные задачи">
    <div className={s.heading}><h2>Связанные задачи</h2><div className={s.headingActions}>{task.queue && can(task,"edit_task") && <Link className={s.subtle} to={getTaskCreateRoute({queueId:task.queue.queue_id,parentTaskId:task.task_id})}>Создать подзадачу</Link>}{(allowed||parentEditable)&&<button type="button" className={s.subtle} disabled={busy} onClick={()=>setEditing(true)} aria-label="Добавить связь">+ Добавить связь</button>}</div></div>
    {!!blocked.length&&<p className={s.notice}>Есть незавершённые зависимости: {blocked.map(link=>link.task.task_key).join(", ")}. Рабочий статус можно менять независимо.</p>}
    <div className={s.relationGroups}>
      <div className={s.relationGroup}><h3>Родительская задача</h3><div className={s.relationRow}>{task.parent_task ? <Link className={s.taskLink} to={getTaskRoute(task.parent_task.task_id)}><strong>{task.parent_task.task_key}</strong><span>{task.parent_task.title}</span></Link>:<span className={s.hint}>{task.parent_task_unavailable?"Недоступна":"Не выбрана"}</span>}{parentEditable&&<button type="button" className={s.subtle} onClick={onEditParent}>Изменить родительскую задачу</button>}</div></div>
      {!!task.children?.length&&<div className={s.relationGroup}><h3>Подзадачи</h3><ul className={s.relationList}>{task.children.map(child=><li key={child.task_id}><TaskReference task={child}/></li>)}</ul></div>}
      {(Object.keys(relationNames)as TaskLinkKind[]).map(kind=>{const group=links.filter(link=>link.kind===kind);return !!group.length&&<div className={s.relationGroup} key={kind}><h3>{relationNames[kind]}</h3><ul className={s.relationList}>{group.map(link=><li className={s.relationRow} key={link.link_id}><TaskReference task={link.task}/>{allowed&&<button type="button" className={s.itemAction} disabled={busy} aria-label={`Удалить связь: ${link.task.task_key}`} onClick={()=>{void remove(link.link_id);}}>×</button>}</li>)}</ul></div>;})}
      {!links.length&&!task.children?.length&&<p className={s.hint}>Через «+» можно связать работу, выбрать эпик и добавить несколько вех.</p>}
    </div>
    {error&&<p role="alert" className={w.error}>{error}</p>}
    {editing&&(allowed||parentEditable)&&<UnsavedChangesScope><LinkEditor task={task} onClose={()=>setEditing(false)}/></UnsavedChangesScope>}
  </section>;
}
function LinkEditor({task,onClose}:{task:Task;onClose:()=>void}) {
  const [kind,setKind]=useState<TaskLinkKind|"parent">("related"),[target,setTarget]=useState(""),[busy,setBusy]=useState(false);const {perform,refresh}=useWorkspaceActions();
  const type=task.task_type??"task",allowed=can(task,"manage_task_links"),hasEpic=task.links?.some(link=>link.kind==="epic");
  const choices=(Object.keys(kindChoices)as (TaskLinkKind|"parent")[]).filter(key=>key==="parent"?can(task,"edit_task"):allowed&&(key==="epic"||key==="milestone"?type==="task":key==="epic_member"?type==="epic":key==="milestone_member"?type==="milestone":true));
  const actualKind=choices.includes(kind)?kind:choices[0],targetType:TaskType|undefined=actualKind==="epic"?"epic":actualKind==="milestone"?"milestone":["epic_member","milestone_member"].includes(actualKind)?"task":undefined;
  return <TrackerTaskDialog title="Добавить связь" onClose={onClose} busy={busy}><ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} externalState={{kind:actualKind,target}} savedExternalState={{kind:choices.includes("related")?"related":choices[0],target:""}} onReplaceWithSaved={()=>{setKind(choices.includes("related")?"related":choices[0]);setTarget("");}} onConflict={refresh} submitLabel="Добавить связь"
    onSubmit={async(_,expectedRevision)=>{if(!target)throw Error("Выберите доступную задачу для связи");setBusy(true);try{const saved=await perform(()=>actualKind==="parent"?tasksApi.update(task.task_id,{expected_revision:expectedRevision!,parent_task_id:target}):tasksApi.addLink(task.task_id,{expected_revision:expectedRevision!,target_task_id:target,kind:actualKind}));onClose();return saved;}finally{setBusy(false);}}}>
    <label className={w.field}>Тип связи<select name="relation_kind" value={actualKind} disabled={busy} onChange={event=>{setKind(event.target.value as TaskLinkKind|"parent");setTarget("");}}>{choices.map(key=><option value={key} key={key} disabled={key==="epic"&&hasEpic}>{kindChoices[key]}</option>)}</select></label>
    <TrackerParentSelector key={`${actualKind}:${targetType??"any"}`} value={target} onChange={setTarget} taskId={task.task_id} seasonId={task.season_id} taskType={targetType} label="Связанная задача" disabled={busy}/>
    {hasEpic&&type==="task"&&<p className={s.hint}>У задачи уже выбран эпик. Чтобы заменить его, сначала удалите прежнюю связь.</p>}
  </ActionForm></TrackerTaskDialog>;
}
