import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Task, Criteria } from '../../utils/api/contract';
import { kkrApi, type AccountingBatch } from '../../utils/api/kkr.api';
import { userMessage } from '../../utils/api/messages';
import { can } from '../../utils/session';
import { displayDate } from '../../utils/dates';
import { profileFeaturesApi, type TemplateSelection } from '../../utils/api/profileFeatures.api';
import { tasksApi } from '../../utils/api/tasks.api';
import { moscowInput, toUtc } from '../../utils/dates';
import { ActionForm } from './ActionForm';
import { text } from './formValues';
import { useUnsavedChanges, useGuardedAction } from './unsavedChangesHooks';
import { UserChip } from './UserChip';
import { QueryState, Empty } from './WorkspaceUI';
import s from './AssessmentPanel.module.css';
import w from './Workspace.module.css';

const criteriaNames: Record<keyof Criteria, string> = { unique:'Уникальная задача', creative:'Творческий подход', external_communication:'Общение вне вуза', in_person:'Очное присутствие', fixed_time:'В определённое время' };
export function UnifiedKkrEditor({task,onClose}: {task:Task; onClose?:()=>void}) {
  const query=useQuery({queryKey:['accounting-batch',task.task_id],queryFn:()=>kkrApi.batch(task.task_id),enabled:can(task,'view_assessment_inputs')});
  if (!can(task,'view_assessment_inputs')) return <Empty>Учёт ККР доступен уполномоченным руководителям.</Empty>;
  return <QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}>{query.data&&<BatchEditor taskId={task.task_id} saved={query.data} onClose={onClose}/>}</QueryState>;
}
function BatchEditor({taskId,saved,onClose}:{taskId:string;saved:AccountingBatch;onClose?:()=>void}) {
  const leave=useGuardedAction();const client=useQueryClient();const [template,setTemplate]=useState<TemplateSelection|null>(null);const templates=useQuery({queryKey:['kkr-templates'],queryFn:profileFeaturesApi.templates,enabled:can(saved,'edit_assessment_inputs')});const [draft,setDraft]=useState(saved),[baseline,setBaseline]=useState(saved),[reason,setReason]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const editable=can(saved,'edit_assessment_inputs');const dirty=JSON.stringify(draft)!==JSON.stringify(baseline)||!!reason||!!template;
  const stale=saved.revision!==baseline.revision||saved.public_revision!==baseline.public_revision||saved.assignments.some(row=>baseline.assignments.find(old=>old.assignment_id===row.assignment_id)?.revision!==row.revision);
  if(stale&&!dirty&&!busy){setDraft(saved);setBaseline(saved);}
  const save=async()=>{
    if(busy||!editable||stale)return false;
    setError('');setNotice('');setBusy(true);
    try {
      const value=await kkrApi.saveBatch(taskId,{expected_public_revision:baseline.public_revision,expected_revision:baseline.revision,criteria:draft.criteria,reason:reason||undefined,...(template?{template_selection:template}:{}),assignments:draft.assignments.map(row=>({assignment_id:row.assignment_id,expected_revision:row.revision,hours:row.hours,evaluation:row.evaluation,excluded:row.excluded}))});
      setDraft(value);setBaseline(value);setReason('');setTemplate(null);client.setQueryData(['accounting-batch',taskId],value);
      await Promise.all([client.invalidateQueries({queryKey:['summary']}),client.invalidateQueries({queryKey:['assessments']}),client.invalidateQueries({queryKey:['season-statistics']}),client.invalidateQueries({queryKey:['kkr-control']}),client.invalidateQueries({queryKey:['kkr-history']})]);
      setNotice('ККР сохранён');return true;
    } catch(e){setError(userMessage(e));return false;} finally {setBusy(false);}
  };
  useUnsavedChanges({dirty,busy,label:'ККР задачи',save,discard:()=>{setDraft(saved);setBaseline(saved);setReason('');setTemplate(null);}});
  const patch=(id:string,values:Partial<AccountingBatch['assignments'][number]>)=>setDraft(value=>({...value,assignments:value.assignments.map(row=>row.assignment_id===id?{...row,...values}:row)}));
  return <section><form className={s.unified} onSubmit={event=>{event.preventDefault();void save();}}>
    <p className={w.muted}>Дата выполнения для ККР: {displayDate(saved.closed_at)}{!saved.closed_at?' · У прежней закрытой задачи дата закрытия не зафиксирована. Сохраняется известная расчётная дата.':''}</p>
    {saved.season_closed&&<p className={w.warning}>Закрытый сезон: исправление создаст новую версию итогов. Укажите причину.</p>}
    {stale&&<p className={w.warning}>Данные изменились. <button type="button" onClick={()=>{setDraft(saved);setBaseline(saved);setReason('');}}>Загрузить сохранённые</button></p>}
    {editable&&templates.data?.items.some(item=>!item.archived)&&<label>Применить шаблон<select aria-label="Шаблон ККР" value={template?.template_id??''} disabled={busy||stale} onChange={event=>{const chosen=templates.data?.items.find(item=>item.template_id===event.target.value);if(!chosen){setTemplate(null);return;}setBusy(true);void profileFeaturesApi.prepare(chosen).then(result=>{setTemplate(result.selection);setDraft(value=>({...value,criteria:result.values.criteria,assignments:value.assignments.map(row=>({...row,hours:result.values.hours,evaluation:result.values.evaluation}))}));}).catch(e=>setError(userMessage(e))).finally(()=>setBusy(false));}}><option value="">Выберите шаблон</option>{templates.data.items.filter(item=>!item.archived).map(item=><option key={item.template_id} value={item.template_id}>{item.values.title}</option>)}</select></label>}
    <fieldset disabled={!editable||busy||stale}><legend>Общие признаки задачи</legend><div className={s.criteria}>{Object.entries(criteriaNames).map(([key,label])=><label key={key}><input type="checkbox" checked={draft.criteria[key as keyof Criteria]} onChange={event=>setDraft(value=>({...value,criteria:{...value.criteria,[key]:event.target.checked}}))}/>{label}</label>)}</div></fieldset>
    <div className={s.accountingTableWrap}><table className={s.accountingTable}><thead><tr><th>Исполнитель</th><th>Часы</th><th>Оценка</th><th>Учёт</th></tr></thead><tbody>{draft.assignments.map(row=><tr key={row.assignment_id}><td><UserChip user={row.assignee}/>{!row.is_current&&<small>Прежний исполнитель</small>}</td><td><input aria-label={`Часы: ${row.assignee.display_name}`} type="number" step="any" min="0" required={!row.excluded} disabled={!editable||busy||stale||row.excluded} value={row.hours??''} onChange={event=>patch(row.assignment_id,{hours:event.target.value===''?null:Number(event.target.value)})}/></td><td><select aria-label={`Оценка: ${row.assignee.display_name}`} required={!row.excluded} disabled={!editable||busy||stale||row.excluded} value={row.evaluation??''} onChange={event=>patch(row.assignment_id,{evaluation:event.target.value===''?null:Number(event.target.value) as -1|0|1|1.5})}><option value="">Выберите</option><option value="-1">−1 · Не выполнено</option><option value="0">0 · Не выполнено</option><option value="1">1 · Зачтено</option><option value="1.5">1,5 · Зачтено</option></select></td><td><label><input type="checkbox" disabled={!editable||busy||stale} checked={row.excluded} onChange={event=>patch(row.assignment_id,{excluded:event.target.checked})}/>Исключить</label></td></tr>)}</tbody></table></div>
    {saved.season_closed&&editable&&<label>Причина исправления<textarea required value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>}
    {notice&&<p role="status">{notice}</p>}
    {error&&<p className={w.error} role="alert">{error}</p>}
    <div className={w.row}>{editable&&<button type="submit" disabled={busy||stale}>{busy?'Сохраняем…':'Сохранить ККР'}</button>}{onClose&&<button type="button" disabled={busy} onClick={()=>leave(onClose)}>Позже</button>}</div>
  </form>{can(saved,'edit_assessment_dates')&&<AccountingDates taskId={taskId}/>}</section>;
}

function AccountingDates({taskId}:{taskId:string}) {
  const [open,setOpen]=useState(false);const client=useQueryClient();
  const query=useQuery({queryKey:['assessments','task',taskId],queryFn:()=>tasksApi.inputs(taskId),enabled:open});
  return <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>Изменить даты задачи</summary>{open&&<QueryState loading={query.isLoading} error={query.error}>{query.data&&<ActionForm revision={query.data.revision} record={`task-inputs:${taskId}`} onConflict={()=>void query.refetch()} fields={[{name:'assigned',label:'Дата выдачи, МСК',type:'datetime-local',required:true,value:moscowInput(query.data.assigned_at)},{name:'deadline',label:'Дедлайн, МСК',type:'datetime-local',value:query.data.deadline_at?moscowInput(query.data.deadline_at):''},{name:'reason',label:'Причина изменения дат',required:true}]} onSubmit={async(values,revision)=>{const saved=await tasksApi.updateInputs(taskId,{expected_revision:revision!,...(text(values,'assigned')!==moscowInput(query.data!.assigned_at)?{assigned_at:toUtc(text(values,'assigned'))}:{}),...(text(values,'deadline')&&text(values,'deadline')!==(query.data!.deadline_at?moscowInput(query.data!.deadline_at):'')?{deadline_at:toUtc(text(values,'deadline'))}:{}),reason:text(values,'reason')});client.setQueryData(['assessments','task',taskId],saved);await Promise.all([client.invalidateQueries({queryKey:['accounting-batch',taskId]}),client.invalidateQueries({queryKey:['tasks']})]);return saved;}}/>}</QueryState>}</details>;
}
