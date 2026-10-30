// @vitest-environment jsdom
import { Route, Routes } from 'react-router-dom';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { liveLogin,liveParticipant,liveCloseSeasons,CLOSES_SEASONS_TIMEOUT } from '../../test/liveApi';
import { mountWorkspace,change,submit,waitForPage } from '../../test/workspace';
import { eventsApi } from '../../utils/api/events.api';
import { seasonsApi } from '../../utils/api/seasons.api';
import { tasksApi } from '../../utils/api/tasks.api';
import { kkrApi } from '../../utils/api/kkr.api';
import { emptyCriteria,richText } from '../../utils/api/contract';
import { TrackerTaskPage } from './TrackerTaskDetail';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;});
async function readApi<T>(command:()=>Promise<T>){let result!:T;await act(async()=>{result=await command();});return result;}
const input=(label:string,name:string)=>page!.container.querySelector<HTMLInputElement|HTMLSelectElement>(`[aria-label="${label}: ${name}"]`)!;
it('saves all assignees atomically after public closure, versions closed corrections and keeps private inputs out of public workflow',async()=>{
 const people=[];for(let index=0;index<3;index++)people.push(await liveParticipant(`kkr-state-${index}`));
 const session=await liveLogin();let season=(await seasonsApi.list()).items.find(item=>item.state==='open');
 if(!season){const planned=(await seasonsApi.list()).items.find(item=>item.state==='planned')??await seasonsApi.create({title:'Учёт задачи',type:'autumn_winter',starts_at:new Date(Date.now()-86400000).toISOString(),ends_at:new Date(Date.now()+30*86400000).toISOString()});const opened=await seasonsApi.command(planned.season_id,'open',{expected_revision:planned.revision});season='season'in opened?opened.season:opened;}
 const event=await eventsApi.create({season_id:season.season_id,title:'Атомарное оценивание ККР',description:richText()});let sub=await eventsApi.createSubevent(event.event_id,{title:'Команда учёта',description:richText()});sub=await eventsApi.organizers(sub.subevent_id,people.map(person=>person.user_id),{expected_revision:sub.revision});
 let task=await tasksApi.create({season_id:season.season_id,scope:{kind:'subevent',id:sub.subevent_id},title:'Общая задача, индивидуальный ККР',description:richText('Сдать общий результат'),deadline_at:new Date(Date.now()+86400000).toISOString(),criteria:emptyCriteria(),assignees:people.map((person,index)=>({user_id:person.user_id,hours:index+2}))});
 await expect(kkrApi.batch(task.task_id)).rejects.toMatchObject({status:409});
 await liveLogin(people[0].email);task=await tasksApi.submitResult(task.task_id,{expected_revision:task.revision,text:richText('Наблюдаемая фактическая сдача'),file_ids:[],links:[]});await liveLogin();task=await tasksApi.changeStatus(task.task_id,{expected_revision:task.revision,status:'closed'});
 const publicBefore=await tasksApi.get(task.task_id);expect(publicBefore.closed_at).toBeTruthy();const [first,second,third]=task.assignments;
 const before=await kkrApi.batch(task.task_id);const stale={expected_public_revision:before.public_revision,expected_revision:before.revision,criteria:before.criteria,assignments:before.assignments.map((row,index)=>({assignment_id:row.assignment_id,expected_revision:row.revision+(index===1?1:0),hours:99,evaluation:1 as const,excluded:false}))};
 await expect(kkrApi.saveBatch(task.task_id,stale)).rejects.toMatchObject({status:409});expect(await kkrApi.batch(task.task_id)).toEqual(before);
 page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}?assignment_id=${first.assignment_id}`,session});await waitForPage(page,()=>!!page!.container.querySelector('dialog table'));
 await change(input('Часы',first.assignee.display_name),'5');await change(input('Оценка',first.assignee.display_name),'1');await change(input('Оценка',second.assignee.display_name),'0');
 const excluded=[...page.container.querySelectorAll('tbody tr')].find(row=>row.textContent?.includes(third.assignee.display_name))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;await act(async()=>excluded.click());await submit(page.container.querySelector('form:has(table)')!);await waitForPage(page,()=>!!page!.container.textContent?.includes('ККР сохранён'));
 const accepted=await readApi(()=>tasksApi.assessment(first.assignment_id));expect([accepted.hours,accepted.evaluation,accepted.workflow_status]).toEqual([5,1,'accepted']);expect(accepted.effective_completed_at).toBe(publicBefore.closed_at);
 expect((await readApi(()=>tasksApi.assessment(second.assignment_id))).workflow_status).toBe('not_completed');expect((await readApi(()=>tasksApi.assessment(third.assignment_id))).workflow_status).toBe('cancelled');expect(await readApi(()=>tasksApi.get(task.task_id))).toEqual(publicBefore);
 await page.cleanup();page=undefined;await liveCloseSeasons();const closedSummary=await seasonsApi.summary(season.season_id),closedPublic=await tasksApi.get(task.task_id);
 page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}?assignment_id=${first.assignment_id}`,session:await liveLogin()});await waitForPage(page,()=>!!page!.container.querySelector('dialog table'));
 expect(page.container.textContent).toContain('Закрытый сезон');await change(input('Часы',first.assignee.display_name),'6');await change(page.container.querySelector('form:has(table) textarea')!,'Подтверждённые часы после закрытия');await submit(page.container.querySelector('form:has(table)')!);await waitForPage(page,()=>!!page!.container.textContent?.includes('ККР сохранён'));
 const corrected=await readApi(()=>tasksApi.assessment(first.assignment_id));expect([corrected.hours,corrected.evaluation,corrected.workflow_status]).toEqual([6,1,'accepted']);expect((await readApi(()=>seasonsApi.summary(season.season_id))).version).toBeGreaterThan(closedSummary.version);expect(await readApi(()=>tasksApi.get(task.task_id))).toEqual(closedPublic);
 await page.cleanup();page=undefined;const workerSession=await liveLogin(people[0].email);page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}`,session:workerSession});await waitForPage(page);expect(page.container.querySelector('section[aria-label="Учёт работы и ККР"]')).toBeNull();await expect(readApi(()=>tasksApi.assessment(first.assignment_id))).rejects.toMatchObject({status:403});expect((await readApi(()=>tasksApi.history(task.task_id))).items.flatMap(item=>item.changes??[]).some(change=>['hours','evaluation','workflow_status'].includes(change.field))).toBe(false);
},CLOSES_SEASONS_TIMEOUT);
