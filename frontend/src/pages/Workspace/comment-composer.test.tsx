// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { TrackerTaskPage } from "./TrackerTaskDetail";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { historyApi } from "../../utils/api/history.api";
import { afterEach, expect, it, vi } from "vitest";
import { TaskMentionPicker } from "./TrackerTaskMentions";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import { createFixtures, people } from "../../mocks/fixtures";
import { taskCollaborationApi } from "../../utils/api/taskCollaboration.api";
import { richText } from "../../utils/api/contract";
import { mountWorkspace, waitForPage, change, settle, submit } from "../../test/workspace";
import { wireIssues } from "../../test/wireContract";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page=undefined;vi.restoreAllMocks(); });

it("comment frame keeps formatting, preview and footer together without help or templates", async () => {
  const user=people[1],source=`| Что | Часы |\n| --- | --- |\n| Работа | 2 |\n\n$x^2$ [неверное имя](/contacts/${user.user_id})`;
  const attach=vi.fn();
  function Editor() { const [value,setValue]=useState(source);return <MarkdownEditor context="comment" variant="comment" value={value} onChange={setValue} label="Новый комментарий" mentionUsers={[user]} footer={<button type="button" onClick={attach}>Прикрепить файлы</button>}/>; }
  page=await mountWorkspace(<Editor/>);
  const frame=page.container.querySelector('[data-markdown-editor="comment"]')!;
  const controls=[...frame.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')];expect(controls.at(-1)?.getAttribute('aria-label')).toBe('Предпросмотр');
  expect(frame.querySelector('[data-editor-footer]')?.textContent).toContain('Прикрепить файлы');
  const input=frame.querySelector('textarea')!;input.focus();input.setSelectionRange(2,5);
  await act(async()=>controls.at(-1)!.click());
  expect(frame.querySelector('table')).not.toBeNull();expect(frame.querySelector('.katex')).not.toBeNull();expect(frame.querySelector(`a[href="/contacts/${user.user_id}"]`)?.textContent).toBe(user.display_name);
  await act(async()=>frame.querySelector<HTMLButtonElement>('[aria-label="Редактирование"]')!.click());expect(frame.querySelector('textarea')!.value).toBe(source);expect([frame.querySelector('textarea')!.selectionStart,frame.querySelector('textarea')!.selectionEnd]).toEqual([2,5]);
  expect(attach).not.toHaveBeenCalled();expect(frame.textContent).not.toContain('Шаблоны');expect(frame.textContent).not.toContain('Справка');
});

it("mention popup searches locally, supports keyboard selection and restores focus", async () => {
  const targets=people.slice(0,3), selected=vi.fn(),insert=vi.fn();
  vi.spyOn(taskCollaborationApi,'candidates').mockResolvedValue({items:targets,next_cursor:null});
  page=await mountWorkspace(<TaskMentionPicker taskId="test-task" value={[]} onChange={selected} onMentionText={insert}/>);
  const trigger=page.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
  await act(async()=>{trigger.focus();trigger.click();});await waitForPage(page);
  const popup=document.querySelector('[data-anchored-popover]')!, input=popup.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(document.activeElement).toBe(input);expect(popup.querySelectorAll('[role="option"] img')).toHaveLength(targets.length);
  await change(input,targets[1].display_name.toLocaleUpperCase('ru'));expect(popup.querySelectorAll('[role="option"]')).toHaveLength(1);
  await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));await settle();
  expect(selected).toHaveBeenCalledWith([targets[1].user_id]);expect(insert).toHaveBeenCalledWith(`[${targets[1].display_name}](/contacts/${targets[1].user_id})`);
  expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(document.activeElement).toBe(trigger);
  await act(async()=>trigger.click());await waitForPage(page);
  await act(async()=>document.querySelector<HTMLInputElement>('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));expect(document.querySelector('[data-anchored-popover]')).toBeNull();
});

it("rendered mentions use safe identities while code, foreign links and missing users cannot spoof a chip", async () => {
  const user=people[1];
  page=await mountWorkspace(<MarkdownContent mentionUsers={[user]} body={`[Чужое имя](/contacts/${user.user_id}) [Неизвестный](/contacts/999999) [Внешняя ссылка](https://example.test/contacts/${user.user_id})\n\n\`[Код](/contacts/${user.user_id})\`\n\n\`\`\`text\n[Блок кода](/contacts/${user.user_id})\n\`\`\``}/>);
  expect(page.container.querySelectorAll(`a[href="/contacts/${user.user_id}"]`)).toHaveLength(1);
  expect(page.container.querySelector(`a[href="/contacts/${user.user_id}"]`)?.textContent).toBe(user.display_name);
  expect(page.container.textContent).not.toContain('Чужое имя');expect(page.container.textContent).not.toContain('Неизвестный');expect(page.container.textContent).toContain('Недоступный участник');expect(page.container.querySelector('a[href="/contacts/999999"]')).toBeNull();
  expect(page.container.querySelector('a[href^="https://example.test"]')?.textContent).toBe('Внешняя ссылка');expect(page.container.querySelectorAll('code')).toHaveLength(2);
});

it("comment wire accepts only declared public identity fields",()=>{
  const fixture=createFixtures('chair'),comment={...fixture.comments[0],content:richText(`[Имя](/contacts/${people[1].user_id})`),mentioned_users:[people[1]]};
  expect(wireIssues('Comment',comment)).toEqual([]);
  expect(wireIssues('Comment',{...comment,history:[{content:richText('Раньше'),edited_at:'2026-10-30T12:00:00Z',attachments:[{file_id:'old-file',name:'old.txt',mime_type:'text/plain',size_bytes:3}]}]})).toEqual([]);
  const {attachments: omitted,...withoutAttachments}=comment;void omitted;expect(wireIssues('Comment',withoutAttachments)).toContain('Comment.attachments: expected array');
  expect(wireIssues('Comment',{...comment,attachments:[{file_id:'file-comment',name:'notes.txt',mime_type:'text/plain',size_bytes:2,storage_key:'private'}]})).toContain('Comment.attachments[0].storage_key: unexpected field');
  expect(wireIssues('Comment',{...comment,mentioned_users:[{...people[1],phone:'not-public'}]})).toContain('Comment.mentioned_users: expected UserRef[] | undefined');
});


it("the comment attachment popover preserves its local draft and never opens task editing",async()=>{
  const fixture=createFixtures('chair'),task={...fixture.tasks[0],capabilities:['comment_task'],status:'open' as const};
  vi.spyOn(tasksApi,'get').mockResolvedValue(task);vi.spyOn(tasksApi,'comments').mockResolvedValue({items:[],next_cursor:null});vi.spyOn(seasonsApi,'list').mockResolvedValue({items:fixture.seasons,next_cursor:null});vi.spyOn(historyApi,'list').mockResolvedValue({items:[],next_cursor:null});
  page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}`});await waitForPage(page);
  const frame=page.container.querySelector('[data-markdown-editor="comment"]')!;await change(frame.querySelector('textarea')!,'Не потерять черновик комментария');
  await act(async()=>frame.querySelector<HTMLButtonElement>('[aria-label="Прикрепить файлы к комментарию"]')!.click());await settle();
  const dialog=document.querySelector('[data-anchored-popover]')!;expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
  await act(async()=>dialog.querySelector<HTMLButtonElement>('[aria-label="Закрыть окно"]')!.click());await settle();
  expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(page.container.querySelector('dialog')).toBeNull();expect(frame.querySelector('textarea')!.value).toBe('Не потерять черновик комментария');
});


async function mountDraftTask(existing=false) {
  const fixture=createFixtures('chair'),task={...fixture.tasks[0],capabilities:['comment_task'],status:'open' as const};
  const comment={...fixture.comments[0],task_id:task.task_id,content:richText(`Старый [участник](/contacts/${people[1].user_id})`),mentioned_users:[people[1]],capabilities:['edit_comment']};
  vi.spyOn(tasksApi,'get').mockResolvedValue(task);vi.spyOn(tasksApi,'comments').mockResolvedValue({items:existing?[comment]:[],next_cursor:null});vi.spyOn(seasonsApi,'list').mockResolvedValue({items:fixture.seasons,next_cursor:null});vi.spyOn(historyApi,'list').mockResolvedValue({items:[],next_cursor:null});vi.spyOn(taskCollaborationApi,'candidates').mockResolvedValue({items:people.slice(0,3),next_cursor:null});
  page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}`});await waitForPage(page);return{task,comment};
}
async function chooseDraftPerson(frame:Element,userId:number) {
  await act(async()=>frame.querySelector<HTMLButtonElement>('[data-editor-footer] [data-comment-mention-trigger]')!.click());await waitForPage(page!);
  await act(async()=>document.querySelector<HTMLButtonElement>(`[data-anchored-popover] [data-option-value="${userId}"]`)!.click());await settle();
}
it('correcting a selected person removes the owned token and sends only the replacement recipient',async()=>{
  const {task,comment}=await mountDraftTask(),post=vi.spyOn(tasksApi,'comment').mockResolvedValue(comment);
  const frame=page!.container.querySelector('[data-markdown-editor="comment"]')!,input=frame.querySelector('textarea')!;
  await change(input,'Сохранить этот текст');await chooseDraftPerson(frame,people[1].user_id!);expect(input.value).toContain('/contacts/'+people[1].user_id);
  await chooseDraftPerson(frame,people[1].user_id!);expect(input.value).not.toContain('/contacts/'+people[1].user_id);expect(input.value).toContain('Сохранить этот текст');
  await chooseDraftPerson(frame,people[2].user_id!);await submit(frame.closest('form')!);await waitForPage(page!,()=>post.mock.calls.length===1);
  expect(post).toHaveBeenCalledWith(task.task_id,{format:'markdown',body:expect.stringContaining('/contacts/'+people[2].user_id)},[people[2].user_id],[]);
});
it('deleting an inserted link clears pending recipients while manually typed links stay display-only',async()=>{
  const {task,comment}=await mountDraftTask(),post=vi.spyOn(tasksApi,'comment').mockResolvedValue(comment);
  const frame=page!.container.querySelector('[data-markdown-editor="comment"]')!,input=frame.querySelector('textarea')!;
  await change(input,'Черновик');await chooseDraftPerson(frame,people[1].user_id!);
  const body=`Ручная [ссылка](/contacts/${people[2].user_id}) без призыва`;await change(input,body);
  expect(frame.querySelector('[data-editor-footer]')!.textContent).not.toContain('· 1');await submit(frame.closest('form')!);await waitForPage(page!,()=>post.mock.calls.length===1);
  expect(post).toHaveBeenCalledWith(task.task_id,richText(body),[],[]);
});
it('editing an existing mentioned comment never re-sends its previous recipients',async()=>{
  const {comment}=await mountDraftTask(true),save=vi.spyOn(tasksApi,'editComment').mockResolvedValue(comment);
  await act(async()=>[...page!.container.querySelectorAll<HTMLButtonElement>('article button')].find(button=>button.textContent==='Редактировать')!.click());
  const frame=page!.container.querySelector('article [data-markdown-editor="comment"]')!,body=comment.content.body+' Исправление текста';await change(frame.querySelector('textarea')!,body);await submit(frame.closest('form')!);await waitForPage(page!,()=>save.mock.calls.length===1);
  expect(save).toHaveBeenCalledWith(comment.comment_id,richText(body),[],[]);
});
