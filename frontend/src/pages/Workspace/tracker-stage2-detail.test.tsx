// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { TrackerParentSelector } from "./TrackerParentSelector";
import { act, useState } from "react";
import { afterEach,expect,it,vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace,waitForPage,change,submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";
import type { Task,TaskLink } from "../../utils/api/contract";
import { TaskPlanningEditor } from "./TrackerTaskPlanning";
import { TrackerTaskChecklist } from "./TrackerTaskChecklist";
import { TrackerTaskRelations } from "./TrackerTaskRelations";
import { TrackerTaskHistoryDiff } from "./TrackerTaskHistoryDiff";
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();});
const task=():Task=>({...createFixtures("chair").tasks[0],task_type:"task",priority:"normal",starts_at:"2026-10-20T09:00:00Z",deadline_at:"2026-10-30T09:00:00Z",checklist:[{item_id:"first",text:"Первый шаг",checked:false},{item_id:"second",text:"Второй шаг",checked:true}],links:[],children:[],revision:7,capabilities:["edit_task_metadata","edit_task_checklist","toggle_task_checklist","manage_task_links","edit_task"]});
const button=(text:string)=>[...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
it("milestone editing clears planned start and submits only public planning with the original revision",async()=>{
 const original=task(),write=vi.spyOn(tasksApi,"update").mockResolvedValue({...original,task_type:"milestone",priority:"urgent",starts_at:null,revision:8});
 page=await mountWorkspace(<TaskPlanningEditor task={original} onClose={()=>{}}/>);await change(page.container.querySelector<HTMLSelectElement>('[name="task_type"]')!,"milestone");await change(page.container.querySelector<HTMLSelectElement>('[name="priority"]')!,"urgent");expect(page.container.querySelector('[name="starts_at"]')).toBeNull();expect(page.container.textContent).not.toContain("Цели");
 await submit(page.container.querySelector("form")!);await waitForPage(page);expect(write).toHaveBeenCalledExactlyOnceWith(original.task_id,{expected_revision:7,task_type:"milestone",priority:"urgent",starts_at:null});
});
it("a stale planning edit keeps its values and does not silently rebase",async()=>{
 const original=task(),write=vi.spyOn(tasksApi,"update").mockRejectedValue(new ApiError("Изменения другого участника",409,"revision_conflict"));
 page=await mountWorkspace(<TaskPlanningEditor task={original} onClose={()=>{}}/>);await change(page.container.querySelector<HTMLSelectElement>('[name="priority"]')!,"high");await submit(page.container.querySelector("form")!);await waitForPage(page);expect(page.container.querySelector<HTMLSelectElement>('[name="priority"]')!.value).toBe("high");expect(write.mock.calls[0][1].expected_revision).toBe(7);expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
});
it("checklist toggling preserves stable IDs/order and uses the public task revision",async()=>{
 const original=task(),write=vi.spyOn(tasksApi,"toggleChecklist").mockResolvedValue({...original,checklist:original.checklist!.map(i=>({...i,checked:true})),revision:8});
 page=await mountWorkspace(<TrackerTaskChecklist task={original}/>);await act(async()=>page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await waitForPage(page);
 expect(write).toHaveBeenCalledExactlyOnceWith(original.task_id,"first",{expected_revision:7,checked:true});expect(page.client.getQueryData(["tasks",original.task_id])).toMatchObject({revision:8});
});
it("a refused checklist toggle keeps the old state and reports the conflict",async()=>{
 const original=task();vi.spyOn(tasksApi,"toggleChecklist").mockRejectedValue(new ApiError("Версия устарела",409));page=await mountWorkspace(<TrackerTaskChecklist task={original}/>);await act(async()=>page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await waitForPage(page);expect(page.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Версия устарела");
});
it("readers without checklist capability cannot toggle or edit its items",async()=>{
 const original={...task(),capabilities:[]},write=vi.spyOn(tasksApi,"update");page=await mountWorkspace(<TrackerTaskChecklist task={original}/>);expect([...page.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(i=>i.disabled)).toBe(true);expect(page.container.querySelector("button")).toBeNull();expect(write).not.toHaveBeenCalled();
});
it("checklist reordering submits existing IDs without recreating them",async()=>{
 const original=task(),write=vi.spyOn(tasksApi,"update").mockResolvedValue({...original,revision:8});page=await mountWorkspace(<TrackerTaskChecklist task={original}/>);await act(async()=>button("Изменить пункты").click());await act(async()=>page!.container.querySelector<HTMLButtonElement>('[aria-label="Опустить пункт 1"]')!.click());await submit(page.container.querySelector("form")!);await waitForPage(page);expect(write.mock.calls[0][1].checklist?.map(i=>i.item_id)).toEqual(["second","first"]);
});
it("relations show one epic and multiple milestones independently from the parent and expose inverse children",async()=>{
 const original=task();original.parent_task={task_id:"parent",task_key:"WEB-1",title:"Родитель"};const ref=(id:string,type:"task"|"milestone"|"epic")=>({task_id:id,task_key:id.toUpperCase(),title:id,status:"open" as const,starts_at:null,deadline_at:original.deadline_at,task_type:type});original.links=[{link_id:"e",kind:"epic",task:ref("epic","epic")},{link_id:"m1",kind:"milestone",task:ref("release","milestone")},{link_id:"m2",kind:"milestone",task:ref("design","milestone")}];original.children=[ref("child","task")];page=await mountWorkspace(<TrackerTaskRelations task={original} onEditParent={()=>{}}/>);expect(page.container.textContent).toContain("Входит в эпик");expect(page.container.textContent).toContain("Входит в вехи");expect(page.container.querySelector('a[href="/tasks/release"]')).not.toBeNull();expect(page.container.querySelector('a[href="/tasks/design"]')).not.toBeNull();expect(page.container.querySelector('a[href="/tasks/parent"]')).not.toBeNull();expect(page.container.querySelector('a[href="/tasks/child"]')).not.toBeNull();
});
it("removing a relation sends its link ID with current public revision",async()=>{
 const original=task(),link:TaskLink={link_id:"link-1",kind:"related",task:{task_id:"other",task_key:"WEB-2",title:"Другая",status:"open",deadline_at:original.deadline_at,starts_at:null,task_type:"task"}};original.links=[link];const remove=vi.spyOn(tasksApi,"removeLink").mockResolvedValue({...original,links:[],revision:8});page=await mountWorkspace(<TrackerTaskRelations task={original} onEditParent={()=>{}}/>);await act(async()=>page!.container.querySelector<HTMLButtonElement>('[aria-label="Удалить связь: WEB-2"]')!.click());await waitForPage(page);expect(remove).toHaveBeenCalledExactlyOnceWith(original.task_id,"link-1",{expected_revision:7});
});
it("new public planning and checklist fields have readable history diffs",async()=>{
 page=await mountWorkspace(<TrackerTaskHistoryDiff changes={[{field:"task_type",before:"task",after:"milestone"},{field:"priority",before:"normal",after:"urgent"},{field:"checklist",before:["[ ] Первый"],after:["[x] Первый"]}]}/>);expect(page.container.textContent).toContain("Веха");expect(page.container.textContent).toContain("Срочный");expect(page.container.textContent).toContain("[x] Первый");
});

it("a revoked selected relation hides its cached title even while Query retains old data",async()=>{
 const target={...task(),task_id:"hidden-target",task_key:"PRIVATE-4",title:"Скрытая цель"};const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});client.setQueryData(["tasks",target.task_id],target);vi.spyOn(tasksApi,"get").mockRejectedValue(new ApiError("Нет доступа",403));
 page=await mountWorkspace(<TrackerParentSelector value={target.task_id} onChange={()=>{}} initialParent={target} label="Связанная задача"/>,{client});expect(page.container.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toContain("Скрытая цель");await act(async()=>{await client.invalidateQueries({queryKey:["tasks",target.task_id]});});await waitForPage(page);expect(page.container.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe("Недоступная задача");expect(page.container.textContent).not.toContain("Скрытая цель");
});
it("a denied relation search removes cached options",async()=>{
 const target={...task(),task_id:"hidden-option",task_key:"PRIVATE-5",title:"Скрытый вариант"};const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}}),key=["tasks","parent-combobox","","","",""];client.setQueryData(key,{items:[target],next_cursor:null});vi.spyOn(tasksApi,"listPage").mockRejectedValue(new ApiError("Нет доступа",403));
 page=await mountWorkspace(<TrackerParentSelector value="" onChange={()=>{}} label="Связанная задача"/>,{client});await act(async()=>page!.container.querySelector<HTMLInputElement>('[role="combobox"]')!.focus());await waitForPage(page);expect(page.container.textContent).toContain("Скрытый вариант");await act(async()=>{await client.invalidateQueries({queryKey:key});});await waitForPage(page);expect(page.container.querySelectorAll('[role="option"]')).toHaveLength(0);expect(page.container.textContent).not.toContain("Скрытый вариант");
});

it("a saved new checklist closes and reopens with accepted server IDs",async()=>{
 let setCurrent:((task:Task)=>void)|undefined;const original={...task(),checklist:[]};function Wrapper(){const[current,set]=useState<Task>(original);setCurrent=set;return <TrackerTaskChecklist task={current}/>;}
 const write=vi.spyOn(tasksApi,"update").mockImplementation(async(_,data)=>{const saved:Task={...original,revision:data.expected_revision+1,checklist:(data.checklist??[]).map(item=>({...item,item_id:item.item_id??"server-item"}))};setCurrent!(saved);return saved;});
 page=await mountWorkspace(<Wrapper/>);await act(async()=>button("+ Добавить чеклист").click());await act(async()=>button("+ Добавить пункт").click());await change(page.container.querySelector<HTMLInputElement>('[aria-label="Пункт чеклиста 1"]')!,"Новый пункт");await submit(page.container.querySelector("form")!);await waitForPage(page);expect(page.container.querySelector("dialog")).toBeNull();await act(async()=>button("Изменить пункты").click());await change(page.container.querySelector<HTMLInputElement>('[aria-label="Пункт чеклиста 1"]')!,"Другая формулировка");await submit(page.container.querySelector("form")!);await waitForPage(page);expect(write.mock.calls[1][1]).toMatchObject({expected_revision:8,checklist:[{item_id:"server-item",text:"Другая формулировка",checked:false}]});
});

it("a reader may tick existing items without gaining checklist text editing",async()=>{
 const original={...task(),capabilities:["toggle_task_checklist"]},toggle=vi.spyOn(tasksApi,"toggleChecklist").mockResolvedValue({...task(),revision:8}),edit=vi.spyOn(tasksApi,"update");page=await mountWorkspace(<TrackerTaskChecklist task={original}/>);const checkbox=page.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;expect(checkbox.disabled).toBe(false);expect(page.container.querySelector("button")).toBeNull();await act(async()=>checkbox.click());await waitForPage(page);expect(toggle).toHaveBeenCalledExactlyOnceWith(original.task_id,"first",{expected_revision:7,checked:true});expect(edit).not.toHaveBeenCalled();
});
