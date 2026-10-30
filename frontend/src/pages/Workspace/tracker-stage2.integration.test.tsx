// @vitest-environment jsdom
import { act } from "react";
import { Route,Routes } from "react-router-dom";
import { afterEach,expect,it } from "vitest";
import { liveLogin,liveParticipant } from "../../test/liveApi";
import { mountWorkspace,waitForPage,change,submit } from "../../test/workspace";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { eventsApi } from "../../utils/api/events.api";
import { richText,type Task,type TaskLinkKind } from "../../utils/api/contract";
import { moscowInput } from "../../utils/dates";
import { TrackerTaskPage } from "./TrackerTaskDetail";
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;});
async function api<T>(fn:()=>Promise<T>){let result!:T;await act(async()=>{result=await fn();});return result;}
const dialog=(title:string)=>[...page!.container.querySelectorAll<HTMLDialogElement>("dialog")].find(el=>el.querySelector("h2")?.textContent===title)!;
const click=async(root:ParentNode,text:string)=>{const b=[...root.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text);expect(b).toBeDefined();await act(async()=>b!.click());await waitForPage(page!);};
async function openSeason() {
 const seasons=(await seasonsApi.list()).items;
 let season=seasons.find(item=>item.state==='open')??seasons.find(item=>item.state==='planned')??await seasonsApi.create({title:'Stage2 UI',type:'autumn_winter',starts_at:new Date(Date.now()-86400000).toISOString(),ends_at:new Date(Date.now()+30*86400000).toISOString()});
 if(season.state==='planned') {const opened=await seasonsApi.command(season.season_id,'open',{expected_revision:season.revision});season='season' in opened?opened.season:opened;}
 expect(season.state).toBe('open');return season;
}
async function addLink(kind:TaskLinkKind,target:Task){
 await act(async()=>page!.container.querySelector<HTMLButtonElement>('[aria-label="Добавить связь"]')!.click());await waitForPage(page!);let modal=dialog("Добавить связь");expect(modal).toBeDefined();await change(modal.querySelector<HTMLSelectElement>('[name="relation_kind"]')!,kind);
 modal=dialog("Добавить связь");const box=modal.querySelector<HTMLInputElement>('[role="combobox"]')!;await act(async()=>box.focus());await waitForPage(page!,()=>!![...modal.querySelectorAll('[role="option"]')].find(el=>el.querySelector("strong")?.textContent===target.task_key));const option=[...modal.querySelectorAll<HTMLElement>('[role="option"]')].find(el=>el.querySelector("strong")?.textContent===target.task_key)!;await act(async()=>option.click());await submit(modal.querySelector("form")!);await waitForPage(page!,()=>!dialog("Добавить связь"));
}
it("edits real planning/checklists, joins one epic and multiple milestones through +, and renders public diffs over HTTP",async()=>{
 const worker=await liveParticipant("stage2-ui");await liveLogin();const season=await openSeason();
 const event=await eventsApi.create({season_id:season.season_id,title:"Stage2 source",description:richText()});await eventsApi.leaders("events",event.event_id,[worker.user_id],{expected_revision:event.revision});
 const session=await liveLogin(worker.email),queue=await taskQueuesApi.create({scope:{kind:"event",id:event.event_id},name:"Второй этап: UI",key:`SUI${crypto.randomUUID().replace(/[^a-f]/g,"").slice(0,10).toUpperCase()}`,is_private:false});
 const base={queue_id:queue.queue_id,season_id:season.season_id,description:richText("Синтетическая публичная работа"),deadline_at:new Date(Date.parse(season.ends_at)-3600000).toISOString(),assignees:[]};
 const epic=await tasksApi.create({...base,title:"Опубликовать полезный результат",task_type:"epic"}),mile1=await tasksApi.create({...base,title:"Готов дизайн",task_type:"milestone"}),mile2=await tasksApi.create({...base,title:"Релиз",task_type:"milestone"});let task=await tasksApi.create({...base,title:"Сверстать страницу результата"});
 page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}`,session});await waitForPage(page);expect(page.container.textContent).not.toContain("Цели");
 await click(page.container,"Изменить параметры");let modal=dialog("Планирование задачи");await change(modal.querySelector<HTMLSelectElement>('[name="priority"]')!,"urgent");const starts=moscowInput(new Date(Date.parse(base.deadline_at)-86400000).toISOString());await change(modal.querySelector<HTMLInputElement>('[name="starts_at"]')!,starts);await submit(modal.querySelector("form")!);await waitForPage(page);await act(async()=>modal.querySelector<HTMLButtonElement>('[aria-label="Закрыть окно"]')!.click());
 task=await api(()=>tasksApi.get(task.task_id));expect(task.priority).toBe("urgent");expect(task.starts_at).not.toBeNull();
 await click(page.container,"+ Добавить чеклист");modal=dialog("Чеклист задачи");await click(modal,"+ Добавить пункт");await change(modal.querySelector<HTMLInputElement>('[aria-label="Пункт чеклиста 1"]')!,"Подготовить данные");await click(modal,"+ Добавить пункт");await change(modal.querySelector<HTMLInputElement>('[aria-label="Пункт чеклиста 2"]')!,"Проверить страницу");await submit(modal.querySelector("form")!);await waitForPage(page,()=>!dialog("Чеклист задачи"));
 const firstId=(await api(()=>tasksApi.get(task.task_id))).checklist![0].item_id;const checks=page.container.querySelectorAll<HTMLInputElement>('section[aria-label="Чеклист задачи"] input[type="checkbox"]');expect(checks).toHaveLength(2);await act(async()=>checks[0].click());await waitForPage(page);expect((await api(()=>tasksApi.get(task.task_id))).checklist![0]).toMatchObject({item_id:firstId,checked:true});
 await addLink("epic",epic);await addLink("milestone",mile1);await addLink("milestone",mile2);task=await api(()=>tasksApi.get(task.task_id));expect(task.links?.filter(l=>l.kind==="epic").map(l=>l.task.task_id)).toEqual([epic.task_id]);expect(task.links?.filter(l=>l.kind==="milestone").map(l=>l.task.task_id).sort()).toEqual([mile1.task_id,mile2.task_id].sort());expect(page.container.querySelector(`a[href="/tasks/${mile1.task_id}"]`)).not.toBeNull();expect(page.container.querySelector(`a[href="/tasks/${mile2.task_id}"]`)).not.toBeNull();
 expect((await api(()=>tasksApi.get(epic.task_id))).links).toEqual(expect.arrayContaining([expect.objectContaining({kind:"epic_member",task:expect.objectContaining({task_id:task.task_id})})]));
 const revision=task.revision,updated=task.updated_at;const star=page.container.querySelector<HTMLButtonElement>('[aria-label^="Добавить в избранное:"]')!;expect(star).not.toBeNull();await act(async()=>star.click());await waitForPage(page);task=await api(()=>tasksApi.get(task.task_id));expect(task.is_favorite).toBe(true);expect(task.revision).toBe(revision);expect(task.updated_at).toBe(updated);
 const history=await api(()=>tasksApi.history(task.task_id));expect(history.items.some(e=>e.changes?.some(c=>c.field==="priority"))).toBe(true);expect(history.items.some(e=>e.changes?.some(c=>c.field==="checklist"))).toBe(true);expect(history.items.some(e=>e.changes?.some(c=>c.field==="links"))).toBe(true);expect((await api(()=>tasksApi.inputs(task.task_id))).task_id).toBe(task.task_id);
 await page.cleanup();page=undefined;await liveLogin();expect((await tasksApi.get(task.task_id)).is_favorite).toBe(false);
});
it("one milestone includes tasks from different epics and queues without changing their accounting",async()=>{
 await liveLogin();const season=await openSeason();const suffix=()=>crypto.randomUUID().replace(/[^a-f]/g,"").slice(0,10).toUpperCase();const q1=await taskQueuesApi.create({scope:{kind:"chair",id:"chair"},name:"Группировка первая",key:`GRA${suffix()}`,is_private:false}),q2=await taskQueuesApi.create({scope:{kind:"chair",id:"chair"},name:"Группировка вторая",key:`GRB${suffix()}`,is_private:false});
 const seed={season_id:season.season_id,description:richText(""),deadline_at:new Date(Date.parse(season.ends_at)-3600000).toISOString(),assignees:[]};const epic1=await tasksApi.create({...seed,queue_id:q1.queue_id,title:"Первый результат",task_type:"epic"}),epic2=await tasksApi.create({...seed,queue_id:q2.queue_id,title:"Второй результат",task_type:"epic"}),milestone=await tasksApi.create({...seed,queue_id:q1.queue_id,title:"Общий релиз",task_type:"milestone"});let one=await tasksApi.create({...seed,queue_id:q1.queue_id,title:"Работа первого эпика"}),two=await tasksApi.create({...seed,queue_id:q2.queue_id,title:"Работа второго эпика"});
 one=await tasksApi.addLink(one.task_id,{expected_revision:one.revision,target_task_id:epic1.task_id,kind:"epic"});one=await tasksApi.addLink(one.task_id,{expected_revision:one.revision,target_task_id:milestone.task_id,kind:"milestone"});two=await tasksApi.addLink(two.task_id,{expected_revision:two.revision,target_task_id:epic2.task_id,kind:"epic"});two=await tasksApi.addLink(two.task_id,{expected_revision:two.revision,target_task_id:milestone.task_id,kind:"milestone"});const result=await tasksApi.get(milestone.task_id);expect(result.links?.filter(l=>l.kind==="milestone_member").map(l=>l.task.task_id).sort()).toEqual([one.task_id,two.task_id].sort());
 await expect(tasksApi.addLink(one.task_id,{expected_revision:one.revision,target_task_id:epic2.task_id,kind:"epic"})).rejects.toMatchObject({status:409,code:"task_epic_conflict"});expect((await tasksApi.get(one.task_id)).links?.find(l=>l.kind==="epic")?.task.task_id).toBe(epic1.task_id);
 await expect(tasksApi.update(milestone.task_id,{expected_revision:result.revision,task_type:"task"})).rejects.toMatchObject({status:422});expect((await tasksApi.inputs(one.task_id)).task_id).toBe(one.task_id);expect((await tasksApi.inputs(two.task_id)).task_id).toBe(two.task_id);
 const start=new Date(Date.parse(seed.deadline_at)-3600000).toISOString();one=await tasksApi.update(one.task_id,{expected_revision:(await tasksApi.get(one.task_id)).revision,priority:"urgent",starts_at:start});const filtered=await tasksApi.listPage({queue_id:q1.queue_id,priority:"urgent",task_type:"task",date_from:start,date_to:seed.deadline_at,sort:"priority"});expect(filtered.items.map(t=>t.task_id)).toEqual([one.task_id]);
});
