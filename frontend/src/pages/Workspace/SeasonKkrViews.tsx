import { useState, useRef, useMemo } from 'react';
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
  return <section className={u.stack}><div className={u.chartModes}><button type="button" aria-pressed={tab==='block'} onClick={()=>guard(()=>{setActive(null);setTab('block');})}>Блоки</button><button type="button" aria-pressed={tab==='event'} onClick={()=>guard(()=>{setActive(null);setTab('event');})}>Мероприятия</button></div><QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}><div className={u.summaryWrap}><table className={`${u.summaryTable} ${u.statisticsTable}`}><thead><tr>{['Источник','Коэффициент','Задач','Организаторов','Задач / организатора','Средний ККР','Часов / задачу'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row=>{const key=row.source_kind+':'+row.source_id;return <tr key={key}><td>{row.title}{row.parent_title&&<small className={u.statisticsParent}>{row.parent_title}</small>}</td><td>{row.capabilities.includes('edit_coefficient')?<CoefficientInput row={row} seasonId={seasonId} summary={summary} closed={query.data?.preliminary===false} open={active===key} onOpen={()=>active&&active!==key?guard(()=>setActive(key)):setActive(key)} onClose={()=>setActive(null)}/>:n(row.value)}</td><td>{n(row.task_count)}</td><td>{n(row.people_count)}</td><td>{n(row.tasks_per_person)}</td><td>{n(row.mean_kkr)}</td><td>{n(row.mean_person_hours)}</td></tr>;})}</tbody></table></div></QueryState></section>;
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
  // The field keeps what is typed (it may be empty for a moment); a valid number applies on blur or Enter.
  const [countText,setCountText]=useState('4');
  const applyCount=()=>{const value=Number(countText);if(countText.trim()&&Number.isInteger(value)&&value>=1&&value<=24)setCount(value);else setCountText(String(count));};
  // One read per season count; name, course and current block filter the loaded rows (PB-29).
  const query=useQuery({queryKey:['kkr-history',count],queryFn:()=>kkrApi.history({count}),staleTime:60_000});
  const currentBlocks=useQuery({queryKey:['workspaceBlocks'],queryFn:membershipApi.blocks});
  const blocks=currentBlocks.data??[];
  const rows=useMemo(()=>{
    const selected=block?currentBlocks.data?.find(item=>item.block_id===block):undefined;
    const team=selected&&new Set([selected.master?.user.user_id,...selected.master?.deputy_user_ids??[],...selected.members.map(member=>member.user.user_id)].filter(id=>id!=null));
    const text=search.toLocaleLowerCase('ru');
    return query.data?.rows.filter(row=>(!search||`${row.user.display_name} ${row.group_number??''}`.toLocaleLowerCase('ru').includes(text))
      &&(!course||!!row.group_number&&row.group_number.startsWith(course))&&(!block||!!team&&row.user.user_id!==null&&team.has(row.user.user_id)));
  },[query.data,currentBlocks.data,search,course,block]);
  return <section className={u.stack}><div className={u.toolbar}><label>Имя или группа<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label><EntityPicker name="history-block" label="Текущий блок" value={block} onChange={setBlock} loading={currentBlocks.isLoading} placeholder="Все блоки" options={[{value:'',label:'Все блоки'},...blocks.map(item=>({value:item.block_id,label:item.name,block:item}))]}/><label>Курс<select value={course} onChange={e=>setCourse(e.target.value)}><option value="">Все курсы</option>{[1,2,3,4,5,6].map(v=><option key={v}>{v}</option>)}</select></label><label>Последних сезонов<input type="number" min="1" max="24" value={countText} onChange={e=>setCountText(e.target.value)} onBlur={applyCount} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();applyCount();}}}/></label></div><QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}><div className={u.summaryWrap}><table className={u.summaryTable}><thead><tr><th>Участник</th>{query.data?.seasons.map(season=><th key={season.season_id}>{season.title}{season.state!=='closed'&&<small>Предварительно</small>}</th>)}</tr></thead><tbody>{rows?.map(row=><tr key={row.participant_id}><td><UserChip user={row.user}/><small>{row.group_number}</small></td>{row.cells.map(cell=><td key={cell.season_id}>{cell.total_score===null?<span aria-label="Не участвовал в сезоне">—</span>:<><strong>{n(cell.total_score)}</strong>{cell.rank!==null&&<small>место {cell.rank}</small>}{cell.decisions.length>0&&<DecisionBadges values={cell.decisions}/>}</>}</td>)}</tr>)}</tbody></table></div></QueryState><p className={u.note}>Фильтры используют текущий состав. Числа закрытых сезонов сохранены в утверждённых версиях.</p></section>;
}

/** `closed`: the season is closed, so its control epics are finished rather than waiting for the end. */
export function SeasonKkrControl({seasonId,closed=false}:{seasonId:string;closed?:boolean}) {
  const query=useQuery({queryKey:['kkr-control',seasonId],queryFn:()=>kkrApi.controls(seasonId)});
  return <section className={u.stack}><div className={u.panelHeader}><h2>Заполнение ККР</h2></div><QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}>{query.data?.items.map(item=><section className={u.panel} key={item.control_id}><div className={u.panelHeader}><Link to={`/tasks/${encodeURIComponent(item.task_id)}`}>{item.title}</Link><strong>{item.missing_count} без ККР</strong></div><div className={w.row}>{item.responsibles.map(user=><UserChip key={user.user_id} user={user}/>)}</div>{item.missing_tasks.length?<ul className={u.detailList}>{item.missing_tasks.map(task=><li key={task.task_id}><Link to={`/tasks/${encodeURIComponent(task.task_id)}?kkr=1`}>{task.task_key} · {task.title}</Link><div className={w.row}>{task.missing_assignees.map(user=><UserChip key={user.user_id} user={user}/>)}</div></li>)}</ul>:<p className={u.note}>{closed||item.status==='closed'?'Контроль завершён вместе с сезоном.':'Все закрытые задачи заполнены. Контроль остаётся открытым до конца сезона.'}</p>}</section>)}{query.data?.items.length===0&&<Empty>Контрольные эпики ещё не созданы. Они формируются при настройке открытого сезона и его команд.</Empty>}</QueryState></section>;
}

/** Rendered by the season's remind_kkr capability; the control list loads only on its own tab. */
export function SeasonKkrSummon({seasonId}:{seasonId:string}) {
  const client=useQueryClient();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false);const saving=useRef(false);
  return <div className={u.summon}><button type="button" className={u.primary} disabled={busy} aria-busy={busy} onClick={()=>{if(saving.current)return;saving.current=true;setBusy(true);setMessage('');setFailed(false);void kkrApi.remind(seasonId).then(async result=>{setMessage(`Призывов отправлено: ${result.comments_created}`);await client.invalidateQueries({queryKey:['kkr-control',seasonId]});}).catch(error=>{setFailed(true);setMessage(userMessage(error));}).finally(()=>{saving.current=false;setBusy(false);});}}><Glyph name="notifications"/>Призвать на заполнение</button>{message&&<p role={failed?'alert':'status'}>{message}</p>}</div>;
}
