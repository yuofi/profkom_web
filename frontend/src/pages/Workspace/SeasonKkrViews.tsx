import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { membershipApi } from '../../utils/api/membership.api';
import { kkrApi, type AccountingStatistic } from '../../utils/api/kkr.api';
import type { SeasonSummary } from '../../utils/api/contract';
import { userMessage } from '../../utils/api/messages';
import { normalizeApiError } from '../../utils/api/request';
import { AnchoredPopover } from '../../components/Workspace/AnchoredPopover';
import { useUnsavedChanges, useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { EntityPicker } from '../../components/Workspace/EntityPicker';
import { UserChip } from '../../components/Workspace/UserChip';
import { QueryState, Empty, Glyph } from '../../components/Workspace/WorkspaceUI';
import { DecisionBadges } from './SummaryTable';
import u from './SeasonWorkspace.module.css';
import w from '../../components/Workspace/Workspace.module.css';
const n=(value:number|null)=>value===null?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value);

export function SeasonStatistics({seasonId,summary}:{seasonId:string;summary?:SeasonSummary}) {
  const query=useQuery({queryKey:['season-statistics',seasonId],queryFn:()=>kkrApi.statistics(seasonId)});
  const [tab,setTab]=useState('block'),[active,setActive]=useState<string|null>(null);const guard=useGuardedAction();
  const rows=query.data?.items.filter(row=>tab==='block'?['block','chair','chair_merit'].includes(row.source_kind):['event','subevent','head_merit'].includes(row.source_kind))??[];
  return <section className={u.stack}><div className={u.chartModes}><button type="button" aria-pressed={tab==='block'} onClick={()=>guard(()=>{setActive(null);setTab('block');})}>Блоки</button><button type="button" aria-pressed={tab==='event'} onClick={()=>guard(()=>{setActive(null);setTab('event');})}>Мероприятия</button></div><QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}><div className={u.summaryWrap}><table className={`${u.summaryTable} ${u.statisticsTable}`}><thead><tr>{['Источник','Задач','Организаторов','Задач / организатора','Средний ККР','Часов / задачу','Коэффициент'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row=>{const key=row.source_kind+':'+row.source_id;return <tr key={key}><td>{row.title}{row.parent_title&&<small className={u.statisticsParent}>{row.parent_title}</small>}</td><td>{n(row.task_count)}</td><td>{n(row.people_count)}</td><td>{n(row.tasks_per_person)}</td><td>{n(row.mean_kkr)}</td><td>{n(row.mean_person_hours)}</td><td>{row.capabilities.includes('edit_coefficient')?<CoefficientInput row={row} seasonId={seasonId} summary={summary} closed={query.data?.preliminary===false} open={active===key} onOpen={()=>active&&active!==key?guard(()=>setActive(key)):setActive(key)} onClose={()=>setActive(null)}/>:n(row.value)}</td></tr>;})}</tbody></table></div></QueryState></section>;
}
type CoefficientDraft={value:string;revision:number;baseline:number;summaryVersion?:number};
function CoefficientInput({row,seasonId,summary,closed,open,onOpen,onClose}:{row:AccountingStatistic;seasonId:string;summary?:SeasonSummary;closed:boolean;open:boolean;onOpen:()=>void;onClose:()=>void}) {
  const client=useQueryClient(),leave=useGuardedAction(),anchor=useRef<HTMLInputElement>(null),saving=useRef(false),skipBlur=useRef(false);
  const [draft,setDraft]=useState<CoefficientDraft|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[conflict,setConflict]=useState(false);
  const stale=!!draft&&(draft.revision!==row.revision||(closed&&draft.summaryVersion!==summary?.version));
  const dirty=!!draft&&(draft.value!==String(draft.baseline)||!!reason);
  const refresh=()=>Promise.all([client.invalidateQueries({queryKey:['summary',seasonId]}),client.invalidateQueries({queryKey:['season-statistics',seasonId]})]);
  const discard=()=>{setDraft(null);setReason('');setError('');setConflict(false);onClose();};
  const save=async(selected=draft,adopt=false):Promise<boolean>=>{
    if(saving.current||!selected)return false;
    if(!selected.value.trim()||!Number.isFinite(Number(selected.value))||Number(selected.value)<0){setError('Введите конечный неотрицательный коэффициент');return false;}
    if(Number(selected.value)===selected.baseline&&!reason){setDraft(null);setError('');return true;}
    if(!adopt&&(stale||conflict)){setConflict(true);setError('Коэффициент или итоги изменились. Проверьте актуальное значение перед повторным сохранением.');return false;}
    if(closed&&!summary){setError('Дождитесь загрузки версии итогов');return false;}
    if(closed&&!reason.trim()){onOpen();return false;}
    saving.current=true;setBusy(true);setError('');
    try {
      const saved=await kkrApi.coefficient(seasonId,{source_kind:row.source_kind,source_id:row.source_id,value:Number(selected.value),expected_revision:adopt?row.revision:selected.revision,...(closed?{reason:reason.trim(),expected_summary_version:adopt?summary!.version:selected.summaryVersion}:{})});
      client.setQueryData<Awaited<ReturnType<typeof kkrApi.statistics>>>(['season-statistics',seasonId],old=>old?{...old,items:old.items.map(item=>item.source_kind===saved.source_kind&&item.source_id===saved.source_id?{...item,...saved}:item)}:old);
      setDraft(null);setReason('');setConflict(false);onClose();
      await Promise.all([refresh(),client.invalidateQueries({queryKey:['kkr-history']}),client.invalidateQueries({queryKey:['masterBonuses',seasonId]})]);return true;
    }catch(e){setError(userMessage(e));if(normalizeApiError(e).code==='revision_conflict'){setConflict(true);await refresh();}return false;}
    finally{saving.current=false;setBusy(false);}
  };
  useUnsavedChanges({dirty,busy,label:`Коэффициент: ${row.title}`,save,discard});
  const conflictActions=(conflict||stale)&&<div className={u.coefficientConflict}><span>Актуальное значение: {n(row.value)}</span><button type="button" disabled={busy} onClick={()=>void refresh()}>Обновить данные</button><button type="button" disabled={busy} onClick={()=>void save(draft,true)}>Сохранить мой ввод с обновлённой версией</button></div>;
  return <div className={u.coefficientField}><input ref={anchor} type="number" min="0" step="any" inputMode="decimal" aria-label={`Коэффициент: ${row.title}`} aria-invalid={!!error} aria-busy={busy} value={draft?.value??String(row.value)} disabled={busy} onChange={event=>{setError('');setDraft(previous=>({...previous??{revision:row.revision,baseline:row.value,summaryVersion:summary?.version},value:event.target.value}));}} onBlur={()=>{if(skipBlur.current){skipBlur.current=false;return;}if(!open)void save();}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void save();}if(event.key==='Escape'){event.preventDefault();skipBlur.current=true;discard();anchor.current?.blur();}}}/>{!open&&error&&<p role="alert" className={w.error}>{error}</p>}{!open&&conflictActions}
    <AnchoredPopover open={open} anchorRef={anchor} label={`Коэффициент: ${row.title}`} busy={busy} width={340} onRequestClose={()=>leave(discard)}><form className={u.coefficientCorrection} onSubmit={event=>{event.preventDefault();void save();}}><p>Новое значение: <strong>{draft?.value}</strong></p><label>Причина исправления<input required value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>{error&&<p role="alert" className={w.error}>{error}</p>}{conflictActions}<div className={w.row}><button disabled={busy} type="submit">Сохранить коэффициент</button><button disabled={busy} type="button" onClick={()=>leave(discard)}>Отмена</button></div></form></AnchoredPopover>
  </div>;
}

export function SeasonKkrHistory() {
  const [count,setCount]=useState(4),[search,setSearch]=useState(''),[block,setBlock]=useState(''),[course,setCourse]=useState('');
  const [appliedSearch,setAppliedSearch]=useState(search);useEffect(()=>{const timer=setTimeout(()=>setAppliedSearch(search),250);return()=>clearTimeout(timer);},[search]);
  const query=useQuery({queryKey:['kkr-history',count,appliedSearch,block,course],queryFn:()=>kkrApi.history({count,search:appliedSearch,block_id:block||undefined,course:course||undefined})});
  const currentBlocks=useQuery({queryKey:['blocks'],queryFn:membershipApi.blocks});
  const blocks=currentBlocks.data??[];
  return <section className={u.stack}><div className={u.toolbar}><label>Имя или группа<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label><EntityPicker name="history-block" label="Текущий блок" value={block} onChange={setBlock} loading={currentBlocks.isLoading} placeholder="Все блоки" options={[{value:'',label:'Все блоки'},...blocks.map(item=>({value:item.block_id,label:item.name,block:item}))]}/><label>Курс<select value={course} onChange={e=>setCourse(e.target.value)}><option value="">Все курсы</option>{[1,2,3,4,5,6].map(v=><option key={v}>{v}</option>)}</select></label><label>Последних сезонов<input type="number" min="1" max="24" value={count} onChange={e=>setCount(Math.max(1,Math.min(24,Number(e.target.value)||4)))}/></label></div><QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}><div className={u.summaryWrap}><table className={u.summaryTable}><thead><tr><th>Участник</th>{query.data?.seasons.map(season=><th key={season.season_id}>{season.title}{season.state!=='closed'&&<small>Предварительно</small>}</th>)}</tr></thead><tbody>{query.data?.rows.map(row=><tr key={row.participant_id}><td><UserChip user={row.user}/><small>{row.group_number}</small></td>{row.cells.map(cell=><td key={cell.season_id}><strong>{n(cell.total_score)}</strong>{cell.rank!==null&&<small> · место {cell.rank}</small>}<DecisionBadges values={cell.decisions}/></td>)}</tr>)}</tbody></table></div></QueryState><p className={u.note}>Фильтры используют текущий состав. Числа закрытых сезонов сохранены в утверждённых версиях.</p></section>;
}

export function SeasonKkrControl({seasonId}:{seasonId:string}) {
  const query=useQuery({queryKey:['kkr-control',seasonId],queryFn:()=>kkrApi.controls(seasonId)});
  return <section className={u.stack}><div className={u.panelHeader}><h2>Заполнение ККР</h2></div><QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}>{query.data?.items.map(item=><section className={u.panel} key={item.control_id}><div className={u.panelHeader}><Link to={`/tasks/${encodeURIComponent(item.task_id)}`}>{item.title}</Link><strong>{item.missing_count} без ККР</strong></div><div className={w.row}>{item.responsibles.map(user=><UserChip key={user.user_id} user={user}/>)}</div>{item.missing_tasks.length?<ul className={u.detailList}>{item.missing_tasks.map(task=><li key={task.task_id}><Link to={`/tasks/${encodeURIComponent(task.task_id)}?kkr=1`}>{task.task_key} · {task.title}</Link><div className={w.row}>{task.missing_assignees.map(user=><UserChip key={user.user_id} user={user}/>)}</div></li>)}</ul>:<p className={u.note}>Все закрытые задачи заполнены. Контроль остаётся открытым до конца сезона.</p>}</section>)}{query.data?.items.length===0&&<Empty>Контрольные эпики ещё не созданы. Они формируются при настройке открытого сезона и его команд.</Empty>}</QueryState></section>;
}

export function SeasonKkrSummon({seasonId}:{seasonId:string}) {
  const client=useQueryClient(),query=useQuery({queryKey:['kkr-control',seasonId],queryFn:()=>kkrApi.controls(seasonId)});
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false);const saving=useRef(false);
  if(!query.data?.capabilities.includes('remind_kkr'))return null;
  return <div className={u.summon}><button type="button" className={u.primary} disabled={busy} aria-busy={busy} onClick={()=>{if(saving.current)return;saving.current=true;setBusy(true);setMessage('');setFailed(false);void kkrApi.remind(seasonId).then(async result=>{setMessage(`Призывов отправлено: ${result.comments_created}`);await client.invalidateQueries({queryKey:['kkr-control',seasonId]});}).catch(error=>{setFailed(true);setMessage(userMessage(error));}).finally(()=>{saving.current=false;setBusy(false);});}}><Glyph name="notifications"/>Призвать на заполнение</button>{message&&<p role={failed?'alert':'status'}>{message}</p>}</div>;
}
