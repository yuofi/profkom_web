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
 function Harness(){const [open,setOpen]=useState(true);return open?<UnsavedChangesScope><TrackerTaskDialog title="Учёт работы и ККР" onClose={()=>setOpen(false)}><UnifiedKkrEditor task={task} onClose={()=>setOpen(false)}/></TrackerTaskDialog></UnsavedChangesScope>:<p>Окно закрыто</p>;}
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity,staleTime:Infinity}}});const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const router=createMemoryRouter([{path:'/',element:<UnsavedChangesProvider><Harness/></UnsavedChangesProvider>}]);
 await act(async()=>root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{session:transport!.state.session,loading:false,error:null,refresh:()=>{}}}><RouterProvider router={router}/></SessionContext.Provider></QueryClientProvider>));
 page={client,container,cleanup:async()=>{await act(async()=>root.unmount());router.dispose();client.clear();container.remove();}};await waitForPage(page,()=>!!executors());
 return saved;
}
function buttons(text:string){return [...page!.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text)!;}
const prompt=()=>[...page!.container.querySelectorAll('dialog')].find(d=>d.textContent?.includes('Есть несохранённые изменения'));
async function click(text:string){await act(async()=>buttons(text).click());await waitForPage(page!);}
const executors=()=>page!.container.querySelector('ul[aria-label="Исполнители"]');
const groups=()=>[...page!.container.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label^="Оценка:"]')];
/** The chosen evaluation of a group: the value of its checked radio button, '' when none is. */
const chosen=(group=groups()[0])=>group.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value??'';
async function rate(group:HTMLElement,value:string){const radio=group.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;await act(async()=>radio.click());}
async function fill(){for(const group of groups())await rate(group,'1');}
it('saves shared criteria and every assignee atomically with their own captured revisions, accepting zero',async()=>{
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(async(_id,data)=>({...saved,criteria:data.criteria,assignments:saved.assignments.map((row,i)=>({...row,...data.assignments[i],revision:row.revision+1}))}));
 await fill();const first=page!.container.querySelector<HTMLInputElement>('input[aria-label^="Часы:"]')!;await change(first,'0');await rate(groups()[0],'0');
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
 expect(prompt()).toBeDefined();await click('Остаться');expect(chosen()).toBe('1');
 await click('Закрыть окно');await click('Уйти без сохранения');expect(page!.container.textContent).toContain('Окно закрыто');
});
it('a failed save-and-leave keeps the complete draft and dialog open',async()=>{
 await mount();vi.spyOn(kkrApi,'saveBatch').mockRejectedValue(new ApiError('Синтетический отказ',409,'revision_conflict'));
 await fill();await click('Закрыть окно');await click('Сохранить и перейти');expect(executors()).not.toBeNull();expect(chosen()).toBe('1');expect(page!.container.textContent).toContain('Изменения не сохранены');
});
it('background changes preserve input and block an overwrite until saved values are explicitly loaded',async()=>{
 const saved=await mount();await fill();const fresh={...saved,public_revision:5,criteria:{...saved.criteria,creative:true}};vi.mocked(kkrApi.batch).mockResolvedValue(fresh);
 await act(async()=>{await page!.client.invalidateQueries({queryKey:['accounting-batch',saved.task_id]});});await waitForPage(page!);
 expect(page!.container.textContent).toContain('Данные изменились');expect(buttons('Сохранить ККР').disabled).toBe(true);expect(chosen()).toBe('1');
 await click('Загрузить сохранённые');expect(buttons('Сохранить ККР').disabled).toBe(false);
});
it('a forbidden refetch removes accounting inputs instead of showing stale private cached values',async()=>{
 const saved=await mount();vi.mocked(kkrApi.batch).mockRejectedValue(new ApiError('Доступ отозван',403));await act(async()=>{await page!.client.invalidateQueries({queryKey:['accounting-batch',saved.task_id]});});await waitForPage(page!);
 expect(executors()).toBeNull();expect(page!.container.textContent).toContain('Доступ отозван');
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
const answer=(saved:AccountingBatch)=>async(_id:string,data:Parameters<typeof kkrApi.saveBatch>[1])=>({...saved,criteria:data.criteria,assignments:saved.assignments.map((row,i)=>({...row,...data.assignments[i],revision:row.revision+1}))});
it('each executor has hours in a text field with «ч», the evaluation as one group of four and «Исключить» as a checkbox (owner A2 Д)',async()=>{
 const saved=await mount();const [first,second]=saved.assignments,name=first.assignee.display_name;
 const hours=page!.container.querySelector<HTMLInputElement>(`input[aria-label="Часы: ${name}"]`)!;
 expect(hours.type).toBe('text');expect(hours.inputMode).toBe('decimal');expect(hours.value).toBe('2');expect(hours.closest('label')?.textContent).toBe('ч');
 expect(page!.container.querySelector('input[type="number"]')).toBeNull();expect(page!.container.querySelector('select[aria-label^="Оценка:"]')).toBeNull();
 const group=page!.container.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="Оценка: ${name}"]`)!;expect(group.getAttribute('aria-required')).toBe('true');
 const radios=[...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')],labels=radios.map(radio=>radio.closest('label')!);
 expect(labels.map(label=>label.querySelector('[aria-hidden="true"]')?.textContent)).toEqual(['−1','0','1','1,5']);
 // A screen reader hears what each value means; the captions under the buttons are for the eye.
 expect(labels.map(label=>label.querySelector('span:not([aria-hidden])')?.textContent)).toEqual(['−1, не выполнено','0, не выполнено','1, зачтено','1,5, зачтено']);
 expect([...group.nextElementSibling!.children].map(caption=>caption.textContent)).toEqual(['не выполнено','зачтено']);expect(group.nextElementSibling!.getAttribute('aria-hidden')).toBe('true');
 // Yellow marks a value that counts as done, pink one that does not.
 expect(labels.map(label=>label.hasAttribute('data-done'))).toEqual([false,false,true,true]);
 // Native radio buttons of one name: one choice per executor, arrows and Tab work as in any radio group.
 expect(new Set(radios.map(radio=>radio.name)).size).toBe(1);expect(groups()[1].querySelector<HTMLInputElement>('input[type="radio"]')!.name).not.toBe(radios[0].name);
 expect(chosen(group)).toBe('');await rate(group,'1');expect(radios.filter(radio=>radio.checked).map(radio=>radio.value)).toEqual(['1']);
 await rate(group,'-1');expect(radios.filter(radio=>radio.checked).map(radio=>radio.value)).toEqual(['-1']);expect(chosen(groups()[1])).toBe('');
 const exclude=page!.container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="Исключить: ${second.assignee.display_name}"]`)!;
 expect(exclude.closest('label')?.textContent).toBe('Исключить');
 await act(async()=>exclude.click());
 const secondHours=page!.container.querySelector<HTMLInputElement>(`input[aria-label="Часы: ${second.assignee.display_name}"]`)!;
 expect(secondHours.disabled).toBe(true);expect(secondHours.required).toBe(false);expect([...groups()[1].querySelectorAll<HTMLInputElement>('input')].every(radio=>radio.disabled&&!radio.required)).toBe(true);expect(groups()[1].getAttribute('aria-required')).toBe('false');
 const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(answer(saved));
 await act(async()=>buttons('Сохранить ККР').click());await waitForPage(page!);
 expect(save.mock.calls[0][1].assignments).toMatchObject([{assignment_id:first.assignment_id,hours:2,evaluation:-1,excluded:false},{assignment_id:second.assignment_id,hours:3,evaluation:null,excluded:true}]);
});
it('hours take a comma or a dot and keep what is typed; a lone comma does not let the old hours be sent',async()=>{
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(answer(saved));await fill();
 const hours=page!.container.querySelector<HTMLInputElement>('input[aria-label^="Часы:"]')!;
 await change(hours,'2.5');expect(hours.value).toBe('2,5');await change(hours,'1,2.5ч');expect(hours.value).toBe('1,25');await change(hours,'4,');expect(hours.value).toBe('4,');
 await act(async()=>{hours.dispatchEvent(new FocusEvent('blur'));hours.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));});expect(hours.value).toBe('4');
 await change(hours,',');expect(hours.validity.customError).toBe(true);expect(hours.validationMessage).toBe('Укажите часы числом, например 2,5');
 await act(async()=>buttons('Сохранить ККР').click());await waitForPage(page!);expect(save).not.toHaveBeenCalled();
 await change(hours,'');expect(hours.validity.customError).toBe(false);expect(hours.validity.valueMissing).toBe(true);
 await change(hours,'0,5');await act(async()=>buttons('Сохранить ККР').click());await waitForPage(page!);
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][1].assignments[0].hours).toBe(0.5);
});
it('the bar at the window bottom: «Сохранить ККР» sends the form only when every counted executor is rated, «Закрыть» closes',async()=>{
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(answer(saved));
 const submitButton=buttons('Сохранить ККР');expect(submitButton.type).toBe('submit');expect(submitButton.form).toBe(page!.container.querySelector('form'));expect(submitButton.closest('form')).toBeNull();
 expect([...submitButton.parentElement!.querySelectorAll('button')].map(button=>button.textContent)).toEqual(['Закрыть','Сохранить ККР']);
 await act(async()=>submitButton.click());await waitForPage(page!);expect(save).not.toHaveBeenCalled();
 await fill();await act(async()=>submitButton.click());await waitForPage(page!);
 expect(save).toHaveBeenCalledTimes(1);expect(page!.container.textContent).toContain('ККР сохранён');
 await click('Закрыть');expect(prompt()).toBeUndefined();expect(page!.container.textContent).toContain('Окно закрыто');
});
it('«Закрыть» asks the unsaved-changes question before a dirty batch is closed',async()=>{
 await mount();await fill();await click('Закрыть');expect(prompt()).toBeDefined();
 await click('Остаться');expect(chosen()).toBe('1');
 await click('Закрыть');await click('Уйти без сохранения');expect(page!.container.textContent).toContain('Окно закрыто');
});
