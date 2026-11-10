// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TaskQueuePage, TaskQueuesPage } from "./TaskQueuePages";
import { installMockTransport } from "../../mocks/transport";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { ApiError } from "../../utils/api/request";
import { mountWorkspace, waitForPage, submit } from "../../test/workspace";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page=undefined;transport?.restore();transport=undefined;vi.restoreAllMocks(); });
const button = (label: string) => [...page!.container.querySelectorAll("button")].find(item => item.textContent?.trim()===label)!;
async function mount(capability: boolean, deleted = false) {
  transport=installMockTransport("leader",{delay:0});
  const original=taskQueuesApi.get;
  vi.spyOn(taskQueuesApi,"get").mockImplementation(async id => { const queue=await original(id);return {...queue,...(deleted ? {deleted_at:"2026-11-10T10:00:00Z",task_creation:null} : {}),capabilities: deleted ? ["view_queue_requests"] : capability ? ["delete_queue"] : []}; });
  page=await mountWorkspace(<Routes><Route path="/tasks/queues/:id" element={<TaskQueuePage />} /><Route path="/tasks/queues" element={<TaskQueuesPage />} /></Routes>,{path:"/tasks/queues/queue-tasks",role:"leader"});
  await waitForPage(page);
}
it("shows deletion independently of owner-only settings, confirms consequences and returns to the catalogue",async () => {
  const remove=vi.spyOn(taskQueuesApi,"delete").mockResolvedValue({deleted:true,revision:2});
  await mount(true);
  expect(page!.container.textContent).toContain("Задачи, ККР и история сохранятся");
  expect(page!.container.textContent).not.toContain("Параметры очереди");
  await submit(button("Удалить очередь").closest("form")!);await waitForPage(page!);
  expect(remove).not.toHaveBeenCalled();expect(page!.container.textContent).toContain("Ожидающие запросы будут отменены");
  await act(async () => button("Да, удалить очередь").click());await waitForPage(page!);
  expect(remove).toHaveBeenCalledWith("queue-tasks",1);
  expect(page!.container.querySelector("h1")?.textContent).toBe("Очереди");
});
it("does not offer deletion without server capability",async () => {
  await mount(false);expect(button("Удалить очередь")).toBeUndefined();
});
it("keeps old private access revocable on a deleted queue without creation or editing",async () => {
  const revoke=vi.spyOn(taskQueuesApi,"revoke").mockResolvedValue({request_id:"req",revision:3,user:{user_id:102,display_name:"Участник",avatar_url:null},message:"",status:"revoked",created_at:"2026-11-09T10:00:00Z",capabilities:[]});
  vi.spyOn(taskQueuesApi,"requests").mockResolvedValue({items:[{request_id:"req",revision:2,user:{user_id:102,display_name:"Участник",avatar_url:null},message:"",status:"approved",created_at:"2026-11-09T10:00:00Z",capabilities:["revoke_queue_access"]}],next_cursor:null});
  await mount(false,true);
  expect(page!.container.textContent).toContain("Очередь удалена");
  expect(button("Удалить очередь")).toBeUndefined();expect(button("Сохранить очередь")).toBeUndefined();
  expect(page!.container.querySelector('a[title="Создать задачу"]')).toBeNull();
  await submit(button("Отозвать доступ").closest("form")!);await waitForPage(page!);
  expect(revoke).toHaveBeenCalledWith("queue-tasks",102,2);
});
it("retains the queue and reports a stale decision without blindly repeating it",async () => {
  const remove=vi.spyOn(taskQueuesApi,"delete").mockRejectedValue(new ApiError("Конфликт версии",409,"revision_conflict"));
  await mount(true);await submit(button("Удалить очередь").closest("form")!);await waitForPage(page!);
  await act(async () => button("Да, удалить очередь").click());await waitForPage(page!);
  expect(remove).toHaveBeenCalledTimes(1);expect(page!.container.querySelector("h1")?.textContent).toBe("Задачи встречи");
  expect(page!.container.querySelector('[role="alert"]')).not.toBeNull();
});
