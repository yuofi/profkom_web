// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, waitForPage, change, submit } from "../../test/workspace";
import { wireIssues } from "../../test/wireContract";
import { seasonsApi } from "../../utils/api/seasons.api";
import { eventsApi } from "../../utils/api/events.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { taskCollaborationApi } from "../../utils/api/taskCollaboration.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async()=>{await page?.cleanup();page=undefined;vi.restoreAllMocks();});

it("posts a real mention chip through the comment footer without bypassing outsider approval or revocation",async()=>{
  const author=await liveParticipant('comment-author'),target=await liveParticipant('comment-target');await liveLogin();
  const season=(await seasonsApi.list()).items.find(item=>['open','planned'].includes(item.state))??await seasonsApi.create({title:'Comment test',type:'autumn_winter',starts_at:new Date(Date.now()-86400000).toISOString(),ends_at:new Date(Date.now()+30*86400000).toISOString()});
  const event=await eventsApi.create({season_id:season.season_id,title:'Синтетическая команда комментариев',description:richText()});
  await eventsApi.leaders('events',event.event_id,[author.user_id],{expected_revision:event.revision});
  const authorSession=await liveLogin(author.email);
  const queue=await taskQueuesApi.create({scope:{kind:'event',id:event.event_id},name:'Проверка комментариев',key:`CMT${crypto.randomUUID().replace(/[^a-f]/g,'').slice(0,10).toUpperCase()}`,is_private:true});
  const task=await tasksApi.create({queue_id:queue.queue_id,season_id:season.season_id,title:'Комментарий с согласованным призывом',description:richText('Не предоставляет доступ по одной только ссылке'),deadline_at:null,assignees:[]});
  page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}`,session:authorSession});await waitForPage(page);
  const frame=page.container.querySelector('[data-markdown-editor="comment"]')!;
  await change(frame.querySelector('textarea')!,'Проверь, пожалуйста: ');
  await act(async()=>frame.querySelector<HTMLButtonElement>('[data-editor-footer] [aria-haspopup="dialog"]')!.click());await waitForPage(page);
  const option=document.querySelector<HTMLButtonElement>(`[data-anchored-popover] [data-option-value="${target.user_id}"]`)!;expect(option?.querySelector('img')).not.toBeNull();
  await act(async()=>option.click());
  await submit(frame.closest('form')!);await waitForPage(page,()=>!!page!.container.querySelector(`article a[href="/contacts/${target.user_id}"]`));
  const comment=(await tasksApi.comments(task.task_id)).items[0];expect(wireIssues('Comment',comment)).toEqual([]);expect(comment.mentioned_users?.map(person=>person.user_id)).toEqual([target.user_id]);
  const rendered=page.container.querySelector<HTMLAnchorElement>(`article a[href="/contacts/${target.user_id}"]`)!;expect(rendered.querySelector('img')).not.toBeNull();expect(rendered.textContent).toBe(comment.mentioned_users![0].display_name);
  const pending=(await taskCollaborationApi.mentions(task.task_id)).items.find(row=>row.target?.user_id===target.user_id)!;expect(pending.status).toBe('pending');
  await page.cleanup();page=undefined;
  await liveLogin(target.email);await expect(tasksApi.get(task.task_id)).rejects.toMatchObject({status:404});
  await liveLogin(author.email);await taskCollaborationApi.decide(task.task_id,pending.request_id,true,{expected_revision:pending.revision});
  const targetSession=await liveLogin(target.email);const readable=await tasksApi.get(task.task_id);expect(readable.capabilities).not.toContain('edit_task_description');
  page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage/>}/></Routes>,{path:`/tasks/${task.task_id}`,session:targetSession});await waitForPage(page);
  expect(page.container.querySelector('[data-editor-footer] [aria-label="Прикрепить файлы к задаче"]')).toBeNull();
  const edit=[...page.container.querySelectorAll<HTMLButtonElement>('article button')].find(button=>button.textContent==='Редактировать')!;expect(edit).toBeDefined();
  await act(async()=>edit.click());const editor=page.container.querySelector('article [data-markdown-editor="comment"]')!;await change(editor.querySelector('textarea')!,'Правка читателя без потери доступа');await submit(editor.closest('form')!);await waitForPage(page,()=>page!.container.textContent!.includes('Правка читателя без потери доступа'));
  await page.cleanup();page=undefined;
  await liveLogin(author.email);await taskCollaborationApi.revoke(task.task_id,target.user_id);await liveLogin(target.email);await expect(tasksApi.comments(task.task_id)).rejects.toMatchObject({status:404});
});
