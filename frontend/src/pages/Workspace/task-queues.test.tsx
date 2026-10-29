// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TaskQueuePage, TaskQueuesPage } from "./TaskQueuePages";
import { TrackerListPage } from "./TrackerList";
import { createFixtures, type MockRole } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import type { TaskQueueAccessRequest } from "../../utils/api/contract";
import { mountWorkspace, waitForPage, change, submit } from "../../test/workspace";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
async function mount(path: string, role: MockRole = "leader") {
  page = await mountWorkspace(<Routes><Route path="/tasks" element={<TrackerListPage />} /><Route path="/tasks/queues" element={<TaskQueuesPage />} /><Route path="/tasks/queues/:id" element={<TaskQueuePage />} /></Routes>, { path, role });
  await waitForPage(page);
}
function button(label: string) { return [...page!.container.querySelectorAll("button")].find(p => p.textContent?.trim() === label)!; }
it("shows a locked queue in the directory without its owner or scope", async () => {
  transport = installMockTransport("organizer", { delay: 0 });transport.state.queues[0].is_private = true;transport.state.queues[0].owner = transport.state.people[3];
  await mount("/tasks/queues", "organizer");
  const card = page!.container.querySelector<HTMLAnchorElement>('a[href="/tasks/queues/queue-tasks"]')!.closest('tr')!;
  expect(card.textContent).toContain("TASK");expect(card.textContent).toContain("Нет доступа");expect(card.textContent).not.toContain(transport.state.people[3].display_name);expect(card.querySelector("img")).toBeNull();
});
it("persists an access request from the denied screen without loading tasks", async () => {
  transport = installMockTransport("organizer", { delay: 0 });transport.state.queues[0].is_private = true;transport.state.queues[0].owner = transport.state.people[3];
  const list = vi.spyOn(tasksApi, "listPage");await mount("/tasks/queues/queue-tasks", "organizer");
  expect(page!.container.querySelector("h1")?.textContent).toBe("Нет доступа к очереди");expect(list).not.toHaveBeenCalled();
  const request = vi.spyOn(taskQueuesApi, "requestAccess");await change(page!.container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')!, "Хочу помочь с задачами");
  await submit(button("Запросить доступ").closest("form")!);await waitForPage(page!);
  expect(request).toHaveBeenCalledWith("queue-tasks", "Хочу помочь с задачами");expect(page!.container.textContent).toContain("Ваш запрос ожидает решения владельца");expect(page!.container.querySelector("table")).toBeNull();
});
it("pins a queue on its page while clearing optional filters", async () => {
  transport = installMockTransport("leader", { delay: 0 });const list = vi.spyOn(tasksApi, "listPage");
  await mount("/tasks/queues/queue-tasks?mine=true&status=assigned&q=материалы");
  expect(page!.container.querySelector("h1")?.textContent).toBe("Задачи встречи");expect(page!.container.querySelector('[aria-label="Навигация очереди"]')?.textContent).toContain("Очереди");expect(list).toHaveBeenCalledWith(expect.objectContaining({ queue_id: "queue-tasks", q: "материалы", status: "assigned" }), expect.any(AbortSignal));
  await act(async () => button("Сбросить все").click());await waitForPage(page!);
  const queueCall = list.mock.calls.filter(([params]) => params && "queue_id" in params).at(-1)![0];expect(queueCall).toMatchObject({ queue_id: "queue-tasks" });expect(queueCall).not.toHaveProperty("q");expect(page!.container.querySelectorAll("h1")).toHaveLength(1);expect(page!.container.querySelector('[aria-label="Очередь"]')).toBeNull();
});
it("sends the owner's exact request revision and hides controls for participants", async () => {
  transport = installMockTransport("leader", { delay: 0 });const fixture = createFixtures("leader");
  const item: TaskQueueAccessRequest = { request_id: "request-local", user: fixture.people[0], message: "Совместная работа", status: "pending", created_at: "2026-10-27T12:00:00Z", revision: 4, capabilities: ["approve_queue_access", "reject_queue_access"] };
  vi.spyOn(taskQueuesApi, "requests").mockImplementation(async () => ({ items: [{ ...item }], next_cursor: null }));
  const decide = vi.spyOn(taskQueuesApi, "decide").mockImplementation(async () => { item.status = "approved";item.revision++;item.capabilities = ["revoke_queue_access"];return { ...item }; });
  await mount("/tasks/queues/queue-tasks");await submit(button("Одобрить доступ").closest("form")!);await waitForPage(page!);
  expect(decide).toHaveBeenCalledWith("queue-tasks", "request-local", "approve", 4);expect(page!.container.textContent).toContain("Доступ одобрен");expect(button("Отозвать доступ")).toBeDefined();
  await page!.cleanup();page = undefined;transport.restore();transport = undefined;vi.restoreAllMocks();transport = installMockTransport("organizer", { delay: 0 });await mount("/tasks/queues/queue-tasks", "organizer");expect(page!.container.textContent).not.toContain("Настройки очереди и доступ");
});
it("validates an uppercase-only key before creating a named queue", async () => {
  transport = installMockTransport("leader", { delay: 0 });await mount("/tasks/queues");await act(async () => button("Создать очередь").click());await waitForPage(page!);const create = vi.spyOn(taskQueuesApi, "create");
  await change(page!.container.querySelector<HTMLInputElement>('input[name="name"]')!, "Веб-сайт");await change(page!.container.querySelector<HTMLInputElement>('input[name="key"]')!, "IT WEB-2");await submit(page!.container.querySelector<HTMLFormElement>('dialog form')!);await waitForPage(page!);
  expect(create).not.toHaveBeenCalled();expect(page!.container.textContent).toContain("только заглавные английские буквы");
  await change(page!.container.querySelector<HTMLInputElement>('input[name="key"]')!, "ITWEB");await submit(page!.container.querySelector<HTMLFormElement>('dialog form')!);await waitForPage(page!);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Веб-сайт", key: "ITWEB", is_private: false }));expect(page!.container.textContent).toContain("Открыть ITWEB");
  const wire = transport!.adapter.history.post.find(request => request.url?.endsWith("/task-queues"))!;
  const body = JSON.parse(wire.data);expect(body.scope).toBeNull();
  expect(transport!.state.queues.find(q => q.key === "ITWEB")?.owner?.user_id).toBe(transport!.state.session.user_id);
});
it("removes only the queue filter in the global task list", async () => {
  transport = installMockTransport("leader", { delay: 0 });const list = vi.spyOn(tasksApi, "listPage");await mount("/tasks?queue_id=queue-tasks&mine=true");
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ queue_id: "queue-tasks", mine: "true" }), expect.any(AbortSignal));await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Убрать фильтр: Очередь"]')!.click());await waitForPage(page!);
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("queue_id");expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ mine: "true" }), expect.any(AbortSignal));
});

it("renders the three requested queue columns and permits an ordinary user to create without a team", async () => {
  transport = installMockTransport("organizer", { delay: 0 });await mount("/tasks/queues", "organizer");
  expect([...page!.container.querySelectorAll("thead th")].map(node => node.textContent)).toEqual(["Имя очереди", "Ключ очереди", "Владелец очереди"]);
  expect(page!.container.querySelector('tr a[href^="/contacts/"] img')).not.toBeNull();
  await act(async () => button("Создать очередь").click());await waitForPage(page!);
  await change(page!.container.querySelector<HTMLInputElement>('input[name="name"]')!, "Своя очередь");await change(page!.container.querySelector<HTMLInputElement>('input[name="key"]')!, "SELFQUEUE");
  await submit(page!.container.querySelector<HTMLFormElement>("dialog form")!);await waitForPage(page!);
  const queue = transport!.state.queues.find(q => q.key === "SELFQUEUE")!;expect(queue.scope).toBeNull();expect(queue.owner?.user_id).toBe(transport!.state.session.user_id);expect(page!.container.textContent).toContain("Открыть SELFQUEUE");
});
