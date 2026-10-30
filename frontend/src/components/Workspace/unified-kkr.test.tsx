// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { SessionContext } from '../../utils/session';
import { UnsavedChangesProvider } from './UnsavedChanges';
import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { mountWorkspace, change, submit, waitForPage } from '../../test/workspace';
import { createFixtures } from '../../mocks/fixtures';
import { installMockTransport } from '../../mocks/transport';
import { kkrApi, type AccountingBatch } from '../../utils/api/kkr.api';
import { ApiError } from '../../utils/api/request';
import { UnifiedKkrEditor } from './UnifiedKkrEditor';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
let transport:ReturnType<typeof installMockTransport>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;transport?.restore();transport=undefined;vi.restoreAllMocks();});
function fixture():AccountingBatch {
 const state=createFixtures('chair');return {task_id:state.tasks[0].task_id,public_revision:4,revision:2,criteria:state.inputs.criteria,closed_at:'2026-10-30T02:00:00Z',season_closed:false,assigned_at:state.inputs.assigned_at,deadline_at:state.inputs.deadline_at,capabilities:['edit_assessment_inputs'],assignments:state.tasks[0].assignments.map((a,index)=>({assignment_id:a.assignment_id,assignee:a.assignee,hours:index+2,evaluation:null,excluded:false,effective_completed_at:null,revision:index+5,is_current:true}))};
}
async function mount(saved=fixture()) {
 transport=installMockTransport('chair',{delay:0});vi.spyOn(kkrApi,'batch').mockResolvedValue(saved);
 const task={...transport.state.tasks[0],status:'closed' as const,closed_at:saved.closed_at};
 function Harness(){const [open,setOpen]=useState(true);return open?<UnifiedKkrEditor task={task} onClose={()=>setOpen(false)}/>:<p>Окно закрыто</p>;}
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity,staleTime:Infinity}}});const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const router=createMemoryRouter([{path:'/',element:<UnsavedChangesProvider><Harness/></UnsavedChangesProvider>}]);
 await act(async()=>root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{session:transport!.state.session,loading:false,error:null,refresh:()=>{}}}><RouterProvider router={router}/></SessionContext.Provider></QueryClientProvider>));
 page={client,container,cleanup:async()=>{await act(async()=>root.unmount());router.dispose();client.clear();container.remove();}};await waitForPage(page,()=>!!page!.container.querySelector('table'));
 return saved;
}
function buttons(text:string){return [...page!.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!;}
async function click(text:string){await act(async()=>buttons(text).click());await waitForPage(page!);}
async function fill(){for(const field of page!.container.querySelectorAll<HTMLSelectElement>('select[aria-label^="Оценка:"]'))await change(field,'1');}
it('saves shared criteria and every assignee atomically with their own captured revisions, accepting zero',async()=>{
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockImplementation(async(_id,data)=>({...saved,criteria:data.criteria,assignments:saved.assignments.map((row,i)=>({...row,...data.assignments[i],revision:row.revision+1}))}));
 await fill();const first=page!.container.querySelector<HTMLInputElement>('input[aria-label^="Часы:"]')!;await change(first,'0');const evaluation=page!.container.querySelector<HTMLSelectElement>('select[aria-label^="Оценка:"]')!;await change(evaluation,'0');
 await submit(page!.container.querySelector('form')!);await waitForPage(page!);
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][1]).toMatchObject({expected_public_revision:4,expected_revision:2,assignments:saved.assignments.map((row,index)=>({assignment_id:row.assignment_id,expected_revision:row.revision,hours:index===0?0:row.hours,evaluation:index===0?0:1,excluded:false}))});
});
it('Later protects a dirty batch and save-and-leave actually saves before closing',async()=>{
 const saved=await mount();const save=vi.spyOn(kkrApi,'saveBatch').mockResolvedValue({...saved,assignments:saved.assignments.map(row=>({...row,evaluation:1,revision:row.revision+1}))});
 await fill();await click('Позже');expect(page!.container.querySelector('dialog')?.textContent).toContain('Есть несохранённые изменения');expect(save).not.toHaveBeenCalled();
 await click('Сохранить и перейти');expect(save).toHaveBeenCalledTimes(1);expect(page!.container.textContent).toContain('Окно закрыто');
});
it('a failed save-and-leave keeps the complete draft and dialog open',async()=>{
 await mount();vi.spyOn(kkrApi,'saveBatch').mockRejectedValue(new ApiError('Синтетический отказ',409,'revision_conflict'));
 await fill();await click('Позже');await click('Сохранить и перейти');expect(page!.container.querySelector('table')).not.toBeNull();expect(page!.container.querySelector<HTMLSelectElement>('select[aria-label^="Оценка:"]')?.value).toBe('1');expect(page!.container.textContent).toContain('Изменения не сохранены');
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
