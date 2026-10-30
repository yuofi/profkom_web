import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getContactRoute } from '../../utils/routes';
import { can } from '../../utils/session';
import type { Task } from '../../utils/api/contract';
import { taskCollaborationApi } from '../../utils/api/taskCollaboration.api';
import { EntityPicker } from '../../components/Workspace/EntityPicker';
import { UserChip } from '../../components/Workspace/UserChip';
import { QueryState } from '../../components/Workspace/WorkspaceUI';
import { useWorkspaceActions } from '../../utils/hooks/useWorkspace';
import { userMessage } from '../../utils/api/messages';
import w from '../../components/Workspace/Workspace.module.css';
import s from './TrackerTaskDetail.module.css';
export function TaskMentionPicker({taskId,value,onChange,onMentionText}:{taskId:string;value:number[];onChange:(ids:number[])=>void;onMentionText?:(text:string)=>void}) {
  const [open,setOpen]=useState(false);
  const query=useQuery({queryKey:['taskMentionCandidates',taskId],queryFn:()=>taskCollaborationApi.candidates(taskId),enabled:open});
  return <div><button type="button" className={s.subtleButton} onClick={()=>setOpen(!open)}>@ Призвать человека{value.length?` · ${value.length}`:''}</button>{open&&<><QueryState loading={query.isLoading} error={query.error}><EntityPicker label="Кого призвать" entity="person" multiple value={value.map(String)} options={(query.data?.items??[]).flatMap(user=>user.user_id===null?[]:[{value:String(user.user_id),label:user.display_name,user}])} onChange={ids=>{const next=ids.map(Number);const added=(query.data?.items??[]).filter(user=>user.user_id!==null&&next.includes(user.user_id)&&!value.includes(user.user_id));if(added.length)onMentionText?.(added.map(user=>`[${user.display_name.replace(/[[\]\\]/g,"\\$&")}](${getContactRoute(user.user_id!)})`).join(" "));onChange(next);}}/></QueryState><p className={w.muted}>Если у человека нет доступа, автор задачи или владелец очереди согласует призыв.</p></>}</div>;
}
export function TaskMentionApprovals({task}:{task:Task}) {
  const query=useQuery({queryKey:['taskMentions',task.task_id],queryFn:()=>taskCollaborationApi.mentions(task.task_id),enabled:can(task,"manage_task_access")});
  const {perform}=useWorkspaceActions();const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const rows=(query.data?.items??[]).filter(row=>row.capabilities.length);
  if(!rows.length&&!query.error)return null;
  const act=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await perform(action);await query.refetch();}catch(e){setError(userMessage(e));}finally{setBusy(false);}};
  return <section className={s.description} aria-label="Призывы и доступ"><h2>Призывы и доступ</h2><QueryState loading={query.isLoading} error={query.error}>{rows.map(row=><div className={s.submission} key={row.request_id}><div className={w.row}>{row.target&&<UserChip user={row.target}/>}<span>{row.status==='pending'?'Ожидает согласования':row.status==='approved'?'Доступ согласован':'Призыв отклонён'}</span></div>{row.requested_by&&<p>Призвал: <UserChip user={row.requested_by}/></p>}<div className={w.row}>{row.capabilities.includes('approve_task_mention')&&<button type="button" disabled={busy} onClick={()=>void act(()=>taskCollaborationApi.decide(task.task_id,row.request_id,true,{expected_revision:row.revision}))}>Разрешить доступ</button>}{row.capabilities.includes('reject_task_mention')&&<button type="button" disabled={busy} onClick={()=>void act(()=>taskCollaborationApi.decide(task.task_id,row.request_id,false,{expected_revision:row.revision}))}>Отклонить</button>}{row.target?.user_id&&row.capabilities.includes('revoke_task_access')&&<button type="button" disabled={busy} onClick={()=>void act(()=>taskCollaborationApi.revoke(task.task_id,row.target!.user_id!))}>Забрать доступ</button>}</div></div>)}</QueryState>{error&&<p role="alert" className={w.error}>{error}</p>}</section>;
}
