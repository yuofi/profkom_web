import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getContactRoute } from '../../utils/routes';
import { can } from '../../utils/session';
import type { Task, UserRef } from '../../utils/api/contract';
import { taskCollaborationApi } from '../../utils/api/taskCollaboration.api';
import { AnchoredPopover } from '../../components/Workspace/AnchoredPopover';
import { useSession } from '../../utils/session';
import { canRetainData } from '../../utils/api/request';
import p from './TrackerTaskMentions.module.css';
import { UserChip } from '../../components/Workspace/UserChip';
import { QueryState } from '../../components/Workspace/WorkspaceUI';
import { useWorkspaceActions } from '../../utils/hooks/useWorkspace';
import { userMessage } from '../../utils/api/messages';
import w from '../../components/Workspace/Workspace.module.css';
import s from './TrackerTaskDetail.module.css';
export function TaskMentionPicker({taskId,value,onChange,onMentionText,onMentionUser}:{taskId:string;value:number[];onChange:(ids:number[])=>void;onMentionText?:(text:string)=>void;onMentionUser?:(user:UserRef)=>void}) {
  const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[active,setActive]=useState(0);
  const trigger=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null),listId=useId();
  const {session}=useSession();
  const query=useQuery({queryKey:['taskMentionCandidates',taskId],queryFn:()=>taskCollaborationApi.candidates(taskId),enabled:open});
  const normalize=(text:string)=>text.toLocaleLowerCase('ru').replace(/ё/g,'е').trim();
  const candidates=query.error&&!canRetainData(query.error)?[]:query.data?.items??[];
  const options=candidates.filter(user=>user.user_id!==null&&normalize(user.display_name).includes(normalize(search)));
  const current=Math.min(active,Math.max(0,options.length-1));
  const close=()=>setOpen(false);
  const select=(user:UserRef)=>{
    if(user.user_id===null)return;
    if(!value.includes(user.user_id)){
      onChange([...value,user.user_id]);onMentionUser?.(user);
      onMentionText?.(`[${user.display_name.replace(/[[\]\\]/g,"\\$&")}](${getContactRoute(user.user_id)})`);
    } else onChange(value.filter(uid=>uid!==user.user_id));
    close();
  };
  return <span className={p.anchor}><button ref={trigger} type="button" data-comment-mention-trigger className={p.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{setSearch('');setActive(0);setOpen(!open);}}><span aria-hidden="true">@</span> Призвать{value.length?` · ${value.length}`:''}</button>
    <AnchoredPopover open={open} anchorRef={trigger} initialFocusRef={input} label="Призвать человека" onRequestClose={close} className={p.popup} width={440}>
      <div className={p.searchRow}><input ref={input} className={p.search} type="search" role="combobox" aria-label="Поиск участника для призыва" aria-expanded={open} aria-autocomplete="list" aria-controls={listId} aria-activedescendant={options.length?`${listId}-${options[current].user_id}`:undefined} value={search} placeholder="Имя участника" onChange={event=>{setSearch(event.target.value);setActive(0);}} onKeyDown={event=>{
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&options.length){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:(current+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;setActive(next);document.getElementById(`${listId}-${options[next].user_id}`)?.scrollIntoView?.({block:'nearest'});}
        if(event.key==='Enter'){event.preventDefault();if(options[current])select(options[current]);}
      }}/>{candidates.some(person=>person.user_id===session?.user_id)&&<button className={p.self} type="button" aria-label="Призвать себя" onClick={()=>select(candidates.find(person=>person.user_id===session!.user_id)!)}>Я</button>}</div>
      <QueryState loading={query.isLoading} error={query.error} keepDataOnError={canRetainData(query.error)} retry={()=>void query.refetch()}>
        <div id={listId} className={p.options} role="listbox" aria-label="Участники для призыва">{options.map((user,index)=><button id={`${listId}-${user.user_id}`} key={user.user_id} type="button" role="option" aria-selected={value.includes(user.user_id!)} data-active={index===current||undefined} data-option-value={user.user_id} className={p.option} tabIndex={-1} onPointerMove={()=>setActive(index)} onClick={()=>select(user)}><UserChip className={p.choiceIdentity} user={user} interactive={false}/>{value.includes(user.user_id!)&&<span className={p.selected}>Выбран</span>}</button>)}</div>
        {!query.isLoading&&!options.length&&<p className={p.empty}>Участники не найдены</p>}
      </QueryState>
      <p className={p.note}>Если у человека нет доступа, призыв согласует автор задачи или владелец очереди.</p>
    </AnchoredPopover>
  </span>;
}
export function TaskMentionApprovals({task}:{task:Task}) {
  const query=useQuery({queryKey:['taskMentions',task.task_id],queryFn:()=>taskCollaborationApi.mentions(task.task_id),enabled:can(task,"manage_task_access")});
  const {perform}=useWorkspaceActions();const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const rows=(query.data?.items??[]).filter(row=>row.capabilities.length);
  if(!rows.length&&!query.error)return null;
  const act=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await perform(action);await query.refetch();}catch(e){setError(userMessage(e));}finally{setBusy(false);}};
  return <section className={s.description} aria-label="Призывы и доступ"><h2>Призывы и доступ</h2><QueryState loading={query.isLoading} error={query.error}>{rows.map(row=><div className={s.submission} key={row.request_id}><div className={w.row}>{row.target&&<UserChip user={row.target}/>}<span>{row.status==='pending'?'Ожидает согласования':row.status==='approved'?'Доступ согласован':'Призыв отклонён'}</span></div>{row.requested_by&&<p>Призвал: <UserChip user={row.requested_by}/></p>}<div className={w.row}>{row.capabilities.includes('approve_task_mention')&&<button type="button" disabled={busy} onClick={()=>void act(()=>taskCollaborationApi.decide(task.task_id,row.request_id,true,{expected_revision:row.revision}))}>Разрешить доступ</button>}{row.capabilities.includes('reject_task_mention')&&<button type="button" disabled={busy} onClick={()=>void act(()=>taskCollaborationApi.decide(task.task_id,row.request_id,false,{expected_revision:row.revision}))}>Отклонить</button>}{row.target?.user_id&&row.capabilities.includes('revoke_task_access')&&<button type="button" disabled={busy} onClick={()=>void act(()=>taskCollaborationApi.revoke(task.task_id,row.target!.user_id!))}>Забрать доступ</button>}</div></div>)}</QueryState>{error&&<p role="alert" className={w.error}>{error}</p>}</section>;
}
