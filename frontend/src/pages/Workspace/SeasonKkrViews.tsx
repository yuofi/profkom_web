import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { membershipApi } from '../../utils/api/membership.api';
import { kkrApi, type AccountingStatistic } from '../../utils/api/kkr.api';
import type { SeasonSummary } from '../../utils/api/contract';
import { userMessage } from '../../utils/api/messages';
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
  const [tab,setTab]=useState('block');const [edit,setEdit]=useState<AccountingStatistic|null>(null);
  const rows=query.data?.items.filter(row=>tab==='block'?['block','chair','chair_merit'].includes(row.source_kind):['event','subevent','head_merit'].includes(row.source_kind))??[];
  return <section className={u.stack}><div className={u.chartModes}><button type="button" aria-pressed={tab==='block'} onClick={()=>setTab('block')}>Блоки</button><button type="button" aria-pressed={tab==='event'} onClick={()=>setTab('event')}>Мероприятия</button></div><QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}><div className={u.summaryWrap}><table className={u.summaryTable}><thead><tr>{['Источник','Задач','Организаторов','Задач / организатора','Средний ККР','Часов / задачу','Коэффициент'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.source_kind+row.source_id}><td>{row.title}{row.parent_title&&<small className={u.statisticsParent}>{row.parent_title}</small>}</td><td>{n(row.task_count)}</td><td>{n(row.people_count)}</td><td>{n(row.tasks_per_person)}</td><td>{n(row.mean_kkr)}</td><td>{n(row.mean_person_hours)}</td><td>{row.capabilities.includes('edit_coefficient')?<button type="button" onClick={()=>setEdit(row)} aria-label={`Коэффициент: ${row.title}`}>{n(row.value)} <Glyph name="edit"/></button>:n(row.value)}</td></tr>)}</tbody></table></div><p className={u.note}>Закрытые рабочие задачи без служебных эпиков. Средний ККР рассчитан среди ненулевых значений, включая отрицательные; часы — принятые человеко-часы на учтённую задачу. {query.data?.preliminary?'Предварительные данные.':'Сохранённые итоги.'}</p></QueryState>{edit&&<CoefficientEditor key={edit.source_kind+edit.source_id} row={edit} seasonId={seasonId} summary={summary} onClose={()=>setEdit(null)}/>}</section>;
}
function CoefficientEditor({row,seasonId,summary,onClose}:{row:AccountingStatistic;seasonId:string;summary?:SeasonSummary;onClose:()=>void}) {
  const client=useQueryClient(),leave=useGuardedAction();const [value,setValue]=useState(String(row.value)),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const save=async()=>{
    if(busy)return false;setBusy(true);setError('');
    try {
      if(!value||!Number.isFinite(Number(value))||Number(value)<0)throw Error('Введите неотрицательный коэффициент');
      if(summary?.state==='approved'&&!reason.trim())throw Error('Укажите причину исправления');
      await kkrApi.coefficient(seasonId,{source_kind:row.source_kind,source_id:row.source_id,value:Number(value),expected_revision:row.revision,...(summary?.state==='approved'?{reason,expected_summary_version:summary.version}:{})});
      await Promise.all([client.invalidateQueries({queryKey:['summary']}),client.invalidateQueries({queryKey:['season-statistics',seasonId]}),client.invalidateQueries({queryKey:['kkr-history']}),client.invalidateQueries({queryKey:['masterBonuses',seasonId]})]);onClose();return true;
    }catch(e){setError(userMessage(e));return false;}finally{setBusy(false);}
  };
  useUnsavedChanges({dirty:value!==String(row.value)||!!reason,busy,label:'Коэффициент сезона',save,discard:()=>{setValue(String(row.value));setReason('');}});
  return <form className={u.panel} onSubmit={event=>{event.preventDefault();void save();}}><h3>Коэффициент · {row.title}</h3><label>Значение<input type="number" min="0" step="any" required value={value} disabled={busy} onChange={e=>setValue(e.target.value)}/></label>{summary?.state==='approved'&&<label>Причина исправления<input required value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>}{error&&<p role="alert" className={w.error}>{error}</p>}<div className={w.row}><button disabled={busy} type="submit">Сохранить коэффициент</button><button disabled={busy} type="button" onClick={()=>leave(onClose)}>Отмена</button></div></form>;
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
  const client=useQueryClient();const query=useQuery({queryKey:['kkr-control',seasonId],queryFn:()=>kkrApi.controls(seasonId)});const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  return <section className={u.stack}><div className={u.panelHeader}><h2>Заполнение ККР</h2>{query.data?.capabilities.includes('remind_kkr')&&<button type="button" disabled={busy} onClick={()=>{setBusy(true);setMessage('');void kkrApi.remind(seasonId).then(async result=>{setMessage(`Призывов отправлено: ${result.comments_created}`);await client.invalidateQueries({queryKey:['kkr-control',seasonId]});}).catch(e=>setMessage(userMessage(e))).finally(()=>setBusy(false));}}>Призвать на заполнение</button>}</div>{message&&<p role="status">{message}</p>}<QueryState loading={query.isLoading} error={query.error} retry={()=>void query.refetch()}>{query.data?.items.map(item=><section className={u.panel} key={item.control_id}><div className={u.panelHeader}><Link to={`/tasks/${encodeURIComponent(item.task_id)}`}>{item.title}</Link><strong>{item.missing_count} без ККР</strong></div><div className={w.row}>{item.responsibles.map(user=><UserChip key={user.user_id} user={user}/>)}</div>{item.missing_tasks.length?<ul className={u.detailList}>{item.missing_tasks.map(task=><li key={task.task_id}><Link to={`/tasks/${encodeURIComponent(task.task_id)}?kkr=1`}>{task.task_key} · {task.title}</Link><div className={w.row}>{task.missing_assignees.map(user=><UserChip key={user.user_id} user={user}/>)}</div></li>)}</ul>:<p className={u.note}>Все закрытые задачи заполнены. Контроль остаётся открытым до конца сезона.</p>}</section>)}{query.data?.items.length===0&&<Empty>Контрольные эпики ещё не созданы. Они формируются при настройке открытого сезона и его команд.</Empty>}</QueryState></section>;
}
