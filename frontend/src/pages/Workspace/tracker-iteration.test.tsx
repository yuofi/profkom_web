// @vitest-environment jsdom
import {useState,act} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {mountWorkspace,waitForPage,settle} from '../../test/workspace';
import {createFixtures,people} from '../../mocks/fixtures';
import {tasksApi} from '../../utils/api/tasks.api';
import {taskCollaborationApi,type TaskMentionRequest} from '../../utils/api/taskCollaboration.api';
import {TaskMentionPicker,TaskMentionApprovals} from './TrackerTaskMentions';
import {TaskStatusMenu} from './TaskStatusMenu';
import {TrackerTaskRelations} from './TrackerTaskRelations';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();});
it('a reader receives four statuses with close disabled and no accounting requests',async()=>{
 const task={...createFixtures('chair').tasks[0],capabilities:['change_task_status'],allowed_statuses:['open','in_progress','completed'] as ('open'|'in_progress'|'completed')[]};
 const accounting=vi.spyOn(tasksApi,'inputs');page=await mountWorkspace(<TaskStatusMenu task={task}/>);
 await act(async()=>page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await settle();
 const options=[...page.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];expect(options).toHaveLength(4);expect(options.find(option=>option.textContent?.includes('Закрыта'))?.disabled).toBe(true);expect(accounting).not.toHaveBeenCalled();
});
it('mention search loads lazily and inserts the selected profile link',async()=>{
 const target=people[1];const candidates=vi.spyOn(taskCollaborationApi,'candidates').mockResolvedValue({items:[{...target,can_assign:true}],next_cursor:null});const text=vi.fn();
 function Probe(){const [ids,setIds]=useState<number[]>([]);return <TaskMentionPicker taskId="task-1" value={ids} onChange={setIds} onMentionText={text}/>;}
 page=await mountWorkspace(<Probe/>);expect(candidates).not.toHaveBeenCalled();await act(async()=>page!.container.querySelector<HTMLButtonElement>('button')!.click());await waitForPage(page);
 await act(async()=>document.querySelector<HTMLInputElement>('[role="combobox"]')!.focus());await settle();
 await act(async()=>document.querySelector<HTMLElement>(`[data-option-value="${target.user_id}"]`)!.click());await settle();
 expect(text).toHaveBeenCalledWith(`[${target.display_name}](/contacts/${target.user_id})`);expect(page.container.textContent).toContain('Призвать · 1');
});
it('support tickets and control epics promise no access approval in the mention picker',async()=>{
 vi.spyOn(taskCollaborationApi,'candidates').mockResolvedValue({items:[{...people[1],can_assign:true}],next_cursor:null});
 page=await mountWorkspace(<><TaskMentionPicker taskId="task-1" value={[]} onChange={()=>undefined} readersOnly/></>);
 await act(async()=>page!.container.querySelector<HTMLButtonElement>('button')!.click());await waitForPage(page);
 expect(document.body.textContent).toContain('Призвать можно только тех, кто уже видит эту задачу.');expect(document.body.textContent).not.toContain('согласует автор');
});
it('the author approves with request revision and explicitly revokes the task-only access',async()=>{
 const task={...createFixtures('chair').tasks[0],capabilities:['manage_task_access']};let row:TaskMentionRequest={request_id:'request-1',task_id:task.task_id,task_key:'TEST-1',target:people[1],requested_by:people[0],comment_id:'comment-1',status:'pending',created_at:'2026-10-30T00:00:00Z',revision:1,capabilities:['approve_task_mention','reject_task_mention']};
 vi.spyOn(taskCollaborationApi,'mentions').mockImplementation(async()=>({items:[structuredClone(row)],next_cursor:null}));
 const decide=vi.spyOn(taskCollaborationApi,'decide').mockImplementation(async()=>{row={...row,status:'approved',revision:2,capabilities:['revoke_task_access']};return row;});
 const revoke=vi.spyOn(taskCollaborationApi,'revoke').mockImplementation(async()=>{row={...row,capabilities:[]};return {revoked:true};});
 page=await mountWorkspace(<TaskMentionApprovals task={task}/>);await waitForPage(page);
 const click=async(label:string)=>{await act(async()=>[...page!.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label)!.click());await waitForPage(page!);};
 await click('Разрешить доступ');expect(decide).toHaveBeenCalledWith(task.task_id,'request-1',true,{expected_revision:1});await click('Забрать доступ');expect(revoke).toHaveBeenCalledWith(task.task_id,people[1].user_id);
});

it('a support ticket author without manage_task_access asks for no mentions and sees no access section',async()=>{
 // GL-22: the server no longer gives a non-staff ticket author the sharing right; executor actions stay.
 const task={...createFixtures('organizer').tasks[0],capabilities:['change_task_status','join_task','take_task','submit_task_result']};
 const mentions=vi.spyOn(taskCollaborationApi,'mentions');
 page=await mountWorkspace(<TaskMentionApprovals task={task}/>);await settle();
 expect(mentions).not.toHaveBeenCalled();expect(page.container.querySelector('[aria-label="Призывы и доступ"]')).toBeNull();
});

it('managed control links stay readable while only ordinary links expose removal',async()=>{
 const task={...createFixtures('chair').tasks[0],capabilities:['manage_task_links','edit_task'],links:[
   {link_id:'managed-link',kind:'related' as const,managed:true,task:{task_id:'control',task_key:'KKR-1',title:'Контроль ККР',status:'open' as const,task_type:'epic' as const,deadline_at:null,starts_at:null}},
   {link_id:'ordinary-link',kind:'related' as const,managed:false,task:{task_id:'ordinary',task_key:'IT-2',title:'Обычная связь',status:'open' as const,task_type:'task' as const,deadline_at:null,starts_at:null}},
 ]};
 page=await mountWorkspace(<TrackerTaskRelations task={task} onEditParent={()=>{}}/>);
 expect(page.container.querySelector('a[href="/tasks/control"]')).not.toBeNull();expect(page.container.querySelector('[aria-label="Удалить связь: KKR-1"]')).toBeNull();expect(page.container.querySelector('[aria-label="Удалить связь: IT-2"]')).not.toBeNull();
});
