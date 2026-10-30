// @vitest-environment jsdom
import { act } from 'react';
import { Routes,Route } from 'react-router-dom';
import { afterEach,it,expect,vi } from 'vitest';
import { TrackerTaskPage } from './TrackerTaskDetail';
import { createFixtures,people } from '../../mocks/fixtures';
import { tasksApi } from '../../utils/api/tasks.api';
import { filesApi } from '../../utils/api/files.api';
import { seasonsApi } from '../../utils/api/seasons.api';
import { historyApi } from '../../utils/api/history.api';
import { ApiError } from '../../utils/api/request';
import { richText,type Comment,type FileRef } from '../../utils/api/contract';
import { mountWorkspace,waitForPage,change,settle,submit } from '../../test/workspace';
let page:Awaited<ReturnType<typeof mountWorkspace>>|undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();});
const file:FileRef={file_id:'comment-file',name:'comment-notes.txt',mime_type:'text/plain',size_bytes:18};
async function setup(){
 const fixture=createFixtures('chair'),task={...fixture.tasks[0],capabilities:['comment_task'],status:'open' as const};let comments:Comment[]=[];
 vi.spyOn(tasksApi,'get').mockResolvedValue(task);const read=vi.spyOn(tasksApi,'comments').mockImplementation(async()=>({items:structuredClone(comments),next_cursor:null}));vi.spyOn(seasonsApi,'list').mockResolvedValue({items:fixture.seasons,next_cursor:null});vi.spyOn(historyApi,'list').mockResolvedValue({items:[],next_cursor:null});
 const save=vi.spyOn(tasksApi,'comment').mockImplementation(async(id,content,_mentions,ids)=>{const comment:Comment={comment_id:'persisted-comment',task_id:id,author:people[1],content,attachments:(ids??[]).map(()=>file),created_at:'2026-10-30T12:00:00Z',updated_at:null,capabilities:['edit_comment']};comments=[comment];return structuredClone(comment);});
 const edit=vi.spyOn(tasksApi,'editComment').mockImplementation(async(_id,content,_mentions,ids)=>{comments=[{...comments[0],content,attachments:ids===undefined?comments[0].attachments:ids.map(()=>file)}];return structuredClone(comments[0]);});
 const taskEdit=vi.spyOn(tasksApi,'update');
 const mount=async()=>{page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}`});await waitForPage(page);};await mount();return{task,save,edit,taskEdit,mount,read};
}
async function upload(chosenFile=file){
 const frame=page!.container.querySelector('[data-markdown-editor="comment"]')!;
 await act(async()=>frame.querySelector<HTMLButtonElement>('[aria-label="Прикрепить файлы к комментарию"]')!.click());await settle();
 const popup=document.querySelector('[data-anchored-popover]')!,input=popup.querySelector<HTMLInputElement>('input[type="file"]')!;
 const blob=new File(['synthetic comment'],chosenFile.name,{type:chosenFile.mime_type});
 await act(async()=>{Object.defineProperty(input,'files',{configurable:true,value:[blob]});input.dispatchEvent(new Event('change',{bubbles:true}));});
 return{frame,popup,blob};
}
it('upload stays in the comment draft, POST binds it, reread renders it and shared editing preserves or explicitly removes it',async()=>{
 const {task,save,edit,taskEdit,mount,read}=await setup();const transfer=vi.spyOn(filesApi,'upload').mockResolvedValue(file);
 const {frame,popup,blob}=await upload();await waitForPage(page!);
 expect(transfer).toHaveBeenCalledWith(blob,{owner_kind:'task',owner_id:task.task_id,purpose:'comment'},expect.any(Function));expect(taskEdit).not.toHaveBeenCalled();
 expect(save).not.toHaveBeenCalled();expect(page!.container.querySelector('[aria-label="Файлы в черновике комментария"]')?.textContent).toContain(file.name);
 await act(async()=>popup.querySelector<HTMLButtonElement>('[aria-label="Закрыть окно"]')!.click());expect(document.querySelector('[data-anchored-popover]')).toBeNull();
 await change(frame.querySelector('textarea')!,'Комментарий с файлом');save.mockRejectedValueOnce(new ApiError('Попробуйте снова',503,'server_error'));
 await submit(frame.closest('form')!);await waitForPage(page!);expect(frame.querySelector('textarea')!.value).toBe('Комментарий с файлом');expect(page!.container.querySelector('[aria-label="Файлы в черновике комментария"]')?.textContent).toContain(file.name);
 await submit(frame.closest('form')!);await waitForPage(page!,()=>!!page!.container.querySelector('article [aria-label="Вложения комментария"]'));
 expect(save).toHaveBeenLastCalledWith(task.task_id,richText('Комментарий с файлом'),[],[file.file_id]);expect(page!.container.querySelector('[aria-label="Файлы в черновике комментария"]')).toBeNull();
 await page!.cleanup();page=undefined;await mount();
 let article=page!.container.querySelector('article')!;expect(article.querySelector('[aria-label="Вложения комментария"]')?.textContent).toContain(file.name);
 const reads=read.mock.calls.length;await act(async()=>[...page!.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button=>button.textContent==='Вложения')!.click());await waitForPage(page!);
 expect(page!.container.querySelector('[aria-label="Файлы из комментариев"]')?.textContent).toContain(file.name);expect(read).toHaveBeenCalledTimes(reads);
 await act(async()=>[...page!.container.querySelectorAll<HTMLButtonElement>('[aria-label="Файлы из комментариев"] button')].find(button=>button.textContent==='К комментарию')!.click());await settle();expect(page!.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Комментарии');

 const openEdit=async()=>{await act(async()=>[...article.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Редактировать')!.click());await settle();return article.querySelector('[data-markdown-editor="comment"]')!;};
 let editor=await openEdit();await change(editor.querySelector('textarea')!,'Правка другим читателем');await submit(editor.closest('form')!);await waitForPage(page!,()=>!article.querySelector('form'));
 expect(edit).toHaveBeenLastCalledWith('persisted-comment',richText('Правка другим читателем'),[],[file.file_id]);
 article=page!.container.querySelector('article')!;editor=await openEdit();await act(async()=>article.querySelector<HTMLButtonElement>(`[aria-label="Убрать файл из комментария: ${file.name}"]`)!.click());await submit(editor.closest('form')!);await waitForPage(page!,()=>!article.querySelector('form'));
 expect(edit).toHaveBeenLastCalledWith('persisted-comment',richText('Правка другим читателем'),[],[]);expect(article.querySelector('[aria-label="Вложения комментария"]')).toBeNull();
});
it('a file-only comment is allowed and cannot be sent before the upload finishes',async()=>{
 const {task,save}=await setup();let complete!:(value:FileRef)=>void;vi.spyOn(filesApi,'upload').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
 const {frame}=await upload();const button=[...page!.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Добавить комментарий')!;
 expect(button.matches(':disabled')).toBe(true);expect(save).not.toHaveBeenCalled();await act(async()=>complete(file));await waitForPage(page!);expect(button.matches(':disabled')).toBe(false);
 await submit(frame.closest('form')!);await waitForPage(page!,()=>!!page!.container.querySelector('article [aria-label="Вложения комментария"]'));
 expect(save).toHaveBeenCalledWith(task.task_id,richText(''),[],[file.file_id]);
});
