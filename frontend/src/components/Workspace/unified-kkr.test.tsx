// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { SessionContext } from '../../utils/session';
import { UnsavedChangesProvider, UnsavedChangesScope } from './UnsavedChanges';
import { TrackerTaskDialog } from '../../pages/Workspace/TrackerTaskDialog';
import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { mountWorkspace, change, submit, waitForPage } from '../../test/workspace';
import { createFixtures } from '../../mocks/fixtures';
import { installMockTransport } from '../../mocks/transport';
import { kkrApi, type AccountingBatch } from '../../utils/api/kkr.api';
import { ApiError } from '../../utils/api/request';
import { UnifiedKkrEditor } from './UnifiedKkrEditor';
import { profileFeaturesApi, type KkrTemplate } from '../../utils/api/profileFeatures.api';
import { emptyCriteria } from '../../utils/api/contract';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
let transport:ReturnType<typeof installMockTransport>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;transport?.restore();transport=undefined;vi.restoreAllMocks();});
function fixture():AccountingBatch {
 const state=createFixtures('chair');return {task_id:state.tasks[0].task_id,public_revision:4,revision:2,criteria:state.inputs.criteria,closed_at:'2026-10-30T02:00:00Z',season_closed:false,assigned_at:state.inputs.assigned_at,deadline_at:state.inputs.deadline_at,capabilities:['edit_assessment_inputs'],assignments:state.tasks[0].assignments.map((a,index)=>({assignment_id:a.assignment_id,assignee:a.assignee,hours:index+2,evaluation:null,excluded:false,effective_completed_at:null,revision:index+5,is_current:true}))};
}
async function mount(saved=fixture()) {
 transport=installMockTransport('chair',{delay:0});vi.spyOn(kkrApi,'batch').mockResolvedValue(saved);
 const task={...transport.state.tasks[0],status:'closed' as const,closed_at:saved.closed_at};
 // As on the task page: the window's ✕, Escape and backdrop close it through the guard.
 function Harness(){const [open,setOpen]=useState(true);return open?<UnsavedChangesScope><TrackerTaskDialog title="Учёт работы и ККР" onClose={()=>setOpen(false)}><UnifiedKkrEditor task={task}/></TrackerTaskDialog></UnsavedChangesScope>:<p>Окно закрыто</p>;}
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity,staleTime:Infinity}}});const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const router=createMemoryRouter([{path:'/',element:<UnsavedChangesProvider><Harness/></UnsavedChangesProvider>}]);
 await act(async()=>root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{session:transport!.state.session,loading:false,error:null,refresh:()=>{}}}><RouterProvider router={router}/></SessionContext.Provider></QueryClientProvider>));
 page={client,container,cleanup:async()=>{await act(async()=>root.unmount());router.dispose();client.clear();container.remove();}};await waitForPage(page,()=>!!page!.container.querySelector('table'));
 return saved;
}
function buttons(text:string){return [...page!.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text)!;}
const prompt=()=>[...page!.container.querySelectorAll('dialog')].find(d=>d.textContent?.includes('Есть несохранённые изменения'));
async function click(text:string){await act(async()=>buttons(text).click());await waitForPage(page!);}
async function fill(){for(const field of page!.container.querySelectorAll<HTMLSelectElement>('select[aria-label^="Оценка:"]'))await change(field,'1');}
it('saves shared criteria and every assignee atomically with their own captured revisions, accepting zero',async()=>{
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(async(_id,data)=>({...saved,criteria:data.criteria,assignments:saved.assignments.map((row,i)=>({...row,...data.assignments[i],revision:row.revision+1}))}));
 await fill();const first=page!.container.querySelector<HTMLInputElement>('input[aria-label^="Часы:"]')!;await change(first,'0');const evaluation=page!.container.querySelector<HTMLSelectElement>('select[aria-label^="Оценка:"]')!;await change(evaluation,'0');
 await submit(page!.container.querySelector('form')!);await waitForPage(page!);
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][1]).toMatchObject({expected_public_revision:4,expected_revision:2,assignments:saved.assignments.map((row,index)=>({assignment_id:row.assignment_id,expected_revision:row.revision,hours:index===0?0:row.hours,evaluation:index===0?0:1,excluded:false}))});
});
it('has no «Позже»: the window closes with ✕ at once while nothing is typed',async()=>{
 await mount();expect([...page!.container.querySelectorAll('button')].map(b=>b.textContent)).not.toContain('Позже');
 await click('Закрыть окно');expect(prompt()).toBeUndefined();expect(page!.container.textContent).toContain('Окно закрыто');
});
it('✕ protects a dirty batch and save-and-leave actually saves before closing',async()=>{
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockResolvedValue({...saved,assignments:saved.assignments.map(row=>({...row,evaluation:1,revision:row.revision+1}))});
 await fill();await click('Закрыть окно');expect(prompt()).toBeDefined();expect(save).not.toHaveBeenCalled();
 await click('Сохранить и перейти');expect(save).toHaveBeenCalledTimes(1);expect(page!.container.textContent).toContain('Окно закрыто');
});
it('Escape asks the same question before a dirty batch is closed',async()=>{
 await mount();await fill();const window_=page!.container.querySelector('dialog')!;
 await act(async()=>{window_.dispatchEvent(new Event('cancel',{cancelable:true}));});await waitForPage(page!);
 expect(prompt()).toBeDefined();await click('Остаться');expect(page!.container.querySelector<HTMLSelectElement>('select[aria-label^="Оценка:"]')?.value).toBe('1');
 await click('Закрыть окно');await click('Уйти без сохранения');expect(page!.container.textContent).toContain('Окно закрыто');
});
it('a failed save-and-leave keeps the complete draft and dialog open',async()=>{
 await mount();vi.spyOn(kkrApi,'saveBatch').mockRejectedValue(new ApiError('Синтетический отказ',409,'revision_conflict'));
 await fill();await click('Закрыть окно');await click('Сохранить и перейти');expect(page!.container.querySelector('table')).not.toBeNull();expect(page!.container.querySelector<HTMLSelectElement>('select[aria-label^="Оценка:"]')?.value).toBe('1');expect(page!.container.textContent).toContain('Изменения не сохранены');
});
it('background changes preserve input and block an overwrite until saved values are explicitly loaded',async()=>{
 const saved=await mount();await fill();const fresh={...saved,public_revision:5,criteria:{...saved.criteria,creative:true}};vi.mocked(kkrApi.batch).mockResolvedValue(fresh);
 await act(async()=>{await page!.client.invalidateQueries({queryKey:['accounting-batch',saved.task_id]});});await waitForPage(page!);
 expect(page!.container.textContent).toContain('Данные изменились');expect(buttons('Сохранить ККР').disabled).toBe(true);expect(page!.container.querySelector<HTMLSelectElement>('select[aria-label^="Оценка:"]')?.value).toBe('1');
 await click('Загрузить сохранённые');expect(buttons('Сохранить ККР').disabled).toBe(false);
});
it('a forbidden refetch removes accounting inputs instead of showing stale private cached values',async()=>{
 const saved=await mount();vi.mocked(kkrApi.batch).mockRejectedValue(new ApiError('Доступ отозван',403));await act(async()=>{await page!.client.invalidateQueries({queryKey:['accounting-batch',saved.task_id]});});await waitForPage(page!);
 expect(page!.container.querySelector('table')).toBeNull();expect(page!.container.textContent).toContain('Доступ отозван');
});
const owner={user_id:101,display_name:'Анна Смирнова',avatar_url:null};
const template:KkrTemplate={template_id:'personal-kkr',visibility:'personal',scope:null,revision:3,archived:false,values:{title:'Обычная смена',description:'',hours:4,evaluation:1,criteria:emptyCriteria()},author:owner,updated_by:owner};
async function useTemplate(){const select=page!.container.querySelector<HTMLSelectElement>('select[aria-label="Шаблон ККР"]')!;await change(select,template.template_id);await waitForPage(page!);}
it('a save refused for its template goes on without it; there is no «Отвязать шаблон»',async()=>{
 vi.spyOn(profileFeaturesApi,'templates').mockResolvedValue({items:[template]});vi.spyOn(profileFeaturesApi,'prepare').mockResolvedValue({selection:{template_id:template.template_id,revision:3},values:template.values});
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(async(_id,data)=>{if(data.template_selection)throw new ApiError('Шаблон недоступен',404,'template_unavailable');return {...saved,assignments:saved.assignments.map((row,i)=>({...row,...data.assignments[i],revision:row.revision+1}))};});
 await useTemplate();expect(buttons('Отвязать шаблон')).toBeUndefined();expect(page!.container.querySelector<HTMLInputElement>('input[aria-label^="Часы:"]')!.value).toBe('4');
 await submit(page!.container.querySelector('form')!);await waitForPage(page!);
 expect(page!.container.querySelector('[role="alert"]')?.textContent).toContain('Шаблон вам больше недоступен');expect(buttons('Подставить заново')).toBeUndefined();
 await click('Сохранить без шаблона');
 expect(save).toHaveBeenCalledTimes(2);expect(save.mock.calls[1][1].template_selection).toBeUndefined();expect(save.mock.calls[1][1].assignments.map(row=>row.hours)).toEqual(save.mock.calls[0][1].assignments.map(row=>row.hours));
 expect(page!.container.textContent).toContain('ККР сохранён');
});
it('a template edited after «Подставить» is applied again on request and saved with its new version',async()=>{
 const templates=vi.spyOn(profileFeaturesApi,'templates').mockResolvedValue({items:[template]});vi.spyOn(profileFeaturesApi,'prepare').mockImplementation(async row=>({selection:{template_id:row.template_id,revision:row.revision},values:row.values}));
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(async(_id,data)=>{if(data.template_selection?.revision===3)throw new ApiError('Шаблон изменён',409,'template_changed');return {...saved,assignments:saved.assignments.map((row,i)=>({...row,...data.assignments[i],revision:row.revision+1}))};});
 await useTemplate();templates.mockResolvedValue({items:[{...template,revision:4,values:{...template.values,hours:6}}]});
 await submit(page!.container.querySelector('form')!);await waitForPage(page!);
 expect(page!.container.querySelector('[role="alert"]')?.textContent).toContain('Шаблон изменили после того, как вы его подставили');
 await click('Подставить заново');
 expect(page!.container.textContent).toContain('Шаблон подставлен заново');expect(page!.container.querySelector<HTMLInputElement>('input[aria-label^="Часы:"]')!.value).toBe('6');expect(save).toHaveBeenCalledTimes(1);
 await submit(page!.container.querySelector('form')!);await waitForPage(page!);
 expect(save.mock.calls[1][1].template_selection).toEqual({template_id:template.template_id,revision:4});expect(page!.container.textContent).toContain('ККР сохранён');
});
it('offers only templates the server takes for the task team, including its event through the subevent',async()=>{
 const scoped=(id:string,scope:KkrTemplate['scope'],extra:Partial<KkrTemplate>={}):KkrTemplate=>({...template,template_id:id,visibility:'team',scope,values:{...template.values,title:id},...extra});
 vi.spyOn(profileFeaturesApi,'templates').mockResolvedValue({items:[template,scoped('Весь Профком',{kind:'global',id:null,name:'Профком'}),scoped('Своё мероприятие',{kind:'event',id:'event-1',name:'Мероприятие'}),scoped('Своё подмероприятие',{kind:'subevent',id:'subevent-1',name:'Встреча'}),scoped('Чужое мероприятие',{kind:'event',id:'event-other',name:'Другое'}),scoped('Чужой блок',{kind:'block',id:'block-other',name:'Блок'}),scoped('Архивный',{kind:'global',id:null,name:'Профком'},{archived:true})]});
 await mount();await waitForPage(page!,()=>!!page!.container.querySelector('select[aria-label="Шаблон ККР"]'));await waitForPage(page!);
 expect([...page!.container.querySelectorAll('select[aria-label="Шаблон ККР"] option')].map(option=>option.textContent)).toEqual(['Выберите шаблон','Обычная смена','Весь Профком','Своё мероприятие','Своё подмероприятие']);
});
