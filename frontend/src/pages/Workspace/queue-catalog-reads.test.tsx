// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCreateForm } from "./TaskCreateForm";
import { TaskQueuesPage } from "./TaskQueuePages";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, settle, change, field, submit } from "../../test/workspace";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { directoryApi } from "../../utils/api/directory.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const createButton = () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Создать задачу")!;

it("lists lightweight queues without fetching any queue editor candidates", async () => {
  mock = installMockTransport("leader", { delay: 0 });
  const detail = vi.spyOn(taskQueuesApi, "get"), contacts = vi.spyOn(directoryApi, "contacts");
  const catalog = await taskQueuesApi.catalog();expect(catalog.items.length).toBeGreaterThan(0);
  expect(catalog.items.every(queue => !Object.hasOwn(queue, "assignable_users"))).toBe(true);
  page = await mountWorkspace(<TaskQueuesPage />, { role: "leader" });await waitForPage(page);
  expect(page.container.querySelector('table[aria-label="Список очередей"]')).not.toBeNull();
  expect(detail).not.toHaveBeenCalled();expect(contacts).not.toHaveBeenCalled();
});

it("fetches only the selected queue when creating from all tasks and keeps the draft on switch", async () => {
  mock = installMockTransport("leader", { delay: 0 });
  const first = mock.state.queues[0], second = { ...first, queue_id: "selected-second", key: "SECOND", name: "Вторая очередь" };
  mock.state.queues.push(second);
  const detail = vi.spyOn(taskQueuesApi, "get"), contacts = vi.spyOn(directoryApi, "contacts");
  page = await mountWorkspace(<TaskCreateForm />, { role: "leader" });await waitForPage(page);
  expect(detail.mock.calls.map(call => call[0])).toEqual([first.queue_id]);
  await change(field(page.container, "title"), "Не потерять название");await change(field(page.container, "description"), "Черновик **текста**");
  await change(field(page.container, "queue"), second.queue_id);await waitForPage(page);
  expect(detail.mock.calls.map(call => call[0])).toEqual([first.queue_id, second.queue_id]);
  expect(field(page.container, "title").value).toBe("Не потерять название");expect(field(page.container, "description").value).toContain("Черновик");
  expect(contacts).not.toHaveBeenCalled();
});

it("does not submit while selected detail is loading and never replaces an explicit unavailable queue", async () => {
  mock = installMockTransport("leader", { delay: 0 });const queue = mock.state.queues[0];
  const create = vi.spyOn(tasksApi, "create");let resolve!: (value: typeof queue) => void;
  vi.spyOn(taskQueuesApi, "get").mockImplementation(() => new Promise(done => { resolve = done; }));
  page = await mountWorkspace(<TaskCreateForm queueId={queue.queue_id} />, { role: "leader" });
  for (let attempt = 0; attempt < 20 && !page.container.querySelector("form"); attempt++) await settle();
  expect(page.container.querySelector("form")).not.toBeNull();
  expect(createButton().disabled).toBe(true);
  await change(field(page.container, "title"), "Дождаться прав");await change(field(page.container, "deadline"), "2026-11-01T18:00");
  await submit(page.container.querySelector("form")!);expect(create).not.toHaveBeenCalled();
  await act(async () => resolve({ ...queue, access: "granted", capabilities: ["create_task"], assignable_users: [] }));await waitForPage(page);
  expect(createButton().disabled).toBe(false);
  await page.cleanup();page = undefined;
  page = await mountWorkspace(<TaskCreateForm queueId="unavailable-explicit" />, { role: "leader" });await waitForPage(page);
  expect(page.container.querySelector("form")).toBeNull();expect(page.container.textContent).toContain("Нет доступной очереди");
});

it("closes cached candidates and disables submit after queue access is revoked", async () => {
  mock = installMockTransport("leader", { delay: 0 });const queue = mock.state.queues[0];
  const candidate = { user_id: 89123, display_name: "Скрываемый кандидат", avatar_url: null };
  const detail = vi.spyOn(taskQueuesApi, "get").mockResolvedValue({ ...queue, access: "granted", capabilities: ["create_task", "assign_task_others"], assignable_users: [candidate] });
  const contacts = vi.spyOn(directoryApi, "contacts"), create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<TaskCreateForm queueId={queue.queue_id} />, { role: "leader" });await waitForPage(page);
  const input = page.container.querySelector<HTMLInputElement>('[data-field-name="users"] [role="combobox"]')!;
  await act(async () => input.click());await waitForPage(page);
  expect(document.querySelector('[data-entity-picker-popup]')?.textContent).toContain(candidate.display_name);
  await change(field(page.container, "title"), "Сохраняем черновик");
  detail.mockRejectedValue(new ApiError("Нет доступа к очереди", 403, "queue_access_required"));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["tasks", "queues", queue.queue_id] }); });await waitForPage(page);
  expect(page.container.querySelector('[data-field-name="users"] [role="combobox"]')).toBeNull();
  expect(document.querySelector('[data-entity-picker-popup]')).toBeNull();expect(page.container.textContent).not.toContain(candidate.display_name);
  expect(createButton().disabled).toBe(true);expect(field(page.container, "title").value).toBe("Сохраняем черновик");
  expect(contacts).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
});
