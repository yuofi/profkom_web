// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, waitForPage, change, field, pick, submit } from "../../test/workspace";
import { installMockTransport } from "../../mocks/transport";
import { taskChatApi, type ChatBinding, type ChatSettings, type TaskChatContext } from "../../utils/api/taskChat.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { ApiError } from "../../utils/api/request";
import { TaskChatToggle, TaskChatDelivery } from "./TaskChatAnnouncement";
import { TaskChatSettings } from "./TaskChatSettings";
import { TrackerTaskCreatePage } from "./TaskCreateForm";
import type { Task, UserRef } from "../../utils/api/contract";

const scope = { kind: "block" as const, id: "block-it" };
const binding: ChatBinding = { binding_id: "binding-1", revision: 7, provider: "vk", bot_identity: 987654, peer_id: 2000000001, title: "IT · команда", state: "linked", confirmed_at: "2026-11-10T10:00:00Z", observed_at: "2026-11-10T10:00:00Z" };
const context: TaskChatContext = { scope, binding, available: true, reason: null, can_manage: true, bot_online: true, recipient_mode: "all", missing_vk_user_ids: [] };
const user: UserRef = { user_id: 101, display_name: "Анна Смирнова", avatar_url: null };
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!;
const toggle = () => page!.container.querySelector<HTMLInputElement>('[role="switch"]')!;
function Card({ data = context, error = false, initiallyEnabled = false }: { data?: TaskChatContext; error?: boolean; initiallyEnabled?: boolean }) {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  return <TaskChatToggle context={data} loading={false} error={error} retry={() => {}} enabled={enabled} onChange={setEnabled} title="Подготовить макет" teamTitle="IT" assignees={[user]} />;
}
it("starts off and previews only public message fields, mentioning all without selected assignees", async () => {
  page = await mountWorkspace(<Card />);
  expect(toggle().checked).toBe(false);
  expect(page.container.textContent).toContain("Создадим задачу без сообщения в чате");
  await act(async () => toggle().click());
  expect(page.container.textContent).toContain("Упомянем всех участников чата");
  const details = page.container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("Подготовить макет");
  expect(details.textContent).toContain("Описание и вложения останутся на сайте");
});
it("shows selected people instead of all and permits queued delivery while the bot is offline", async () => {
  page = await mountWorkspace(<Card data={{ ...context, recipient_mode: "assignees", bot_online: false }} initiallyEnabled />);
  expect(page.container.textContent).toContain("Упомянем: Анна Смирнова.");
  expect(page.container.textContent).not.toContain("Упомянем всех");
  expect(page.container.textContent).toContain("Сообщение подождёт его возвращения");
});
it.each([
  ["unsupported_scope", "Для этой очереди рассылка в чат недоступна."],
  ["private_queue", "Задачи из закрытой очереди нельзя отправлять в общий чат."],
  ["forbidden", "У вас нет права отправлять сообщения в чат этой команды."],
  ["no_chat", "К этой команде ещё не привязан чат."],
  ["chat_unavailable", "Боту недоступен чат."],
  ["bot_offline", "Бот временно не в сети."],
  ["bot_unavailable", "Связь с ботом выключена."],
  ["missing_vk", "Не у всех исполнителей привязан VK."],
])("explains unavailable context %s without silently enabling all mentions", async (reason, message) => {
  page = await mountWorkspace(<Card data={{ ...context, available: false, binding: null, reason, can_manage: false }} />);
  expect(toggle().disabled).toBe(true);
  expect(page.container.textContent).toContain(message);
  expect(page.container.querySelector('a')).toBeNull();
});
it("offers the scoped settings link only to an authorized manager", async () => {
  page = await mountWorkspace(<Card data={{ ...context, available: false, binding: null, reason: "no_chat" }} />);
  expect(page.container.querySelector('a')?.getAttribute("href")).toBe("/blocks/block-it?chat=settings");
});
it.each(["missing_vk", "network"])("can turn an enabled switch OFF after context becomes %s", async failure => {
  page = await mountWorkspace(<Card initiallyEnabled data={{ ...context, available: false, reason: "missing_vk", missing_vk_user_ids: [101] }} error={failure === "network"} />);
  expect(toggle().checked).toBe(true);expect(toggle().disabled).toBe(false);
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(false);expect(toggle().disabled).toBe(true);
});

async function createPage(readContext: () => Promise<TaskChatContext> = async () => context) {
  mock = installMockTransport("chair", { delay: 0 });
  const queue = { ...mock.state.queues[0], queue_id: "chat-queue", name: "IT", key: "IT", scope, access: "granted" as const, capabilities: ["create_task", "assign_task_others"], assignable_users: [user] };
  mock.state.queues.push(queue);
  vi.spyOn(taskQueuesApi, "get").mockImplementation(async id => ({ ...queue, queue_id: id }));
  vi.spyOn(taskChatApi, "context").mockImplementation(readContext);
  const created = vi.spyOn(tasksApi, "create").mockResolvedValue(mock.state.tasks[0]);
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /><Route path="/tasks/:id" element={<p>Задача создана</p>} /></Routes>, { path: "/tasks/new?queue_id=chat-queue" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));
  return created;
}
it("fits the actual form between assignees and watchers, and omits announcement by default", async () => {
  const create = await createPage();
  const side = page!.container.querySelector('[aria-label="Параметры новой задачи"]')!.textContent!;
  expect(side.indexOf("Уведомить чат VK")).toBeGreaterThan(side.indexOf("Исполнители"));
  expect(side.indexOf("Уведомить чат VK")).toBeLessThan(side.indexOf("Наблюдатели"));
  await change(field(page!.container, "title"), "Задача без рассылки");
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create).toHaveBeenCalledOnce();expect(create.mock.calls[0][0]).not.toHaveProperty("chat_announcement");
});
it("keeps opt-in in the task idempotency payload and reuses the key after a lost response", async () => {
  const create = await createPage();
  create.mockRejectedValueOnce(new ApiError("lost response", 0, "network_error"));
  await change(field(page!.container, "title"), "Одна задача и одно сообщение");
  await act(async () => toggle().click());
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create).toHaveBeenCalledTimes(2);
  const [first, second] = create.mock.calls.map(call => call[0]);
  expect(first.chat_announcement).toEqual({ enabled: true, binding_revision: 7 });
  expect(second.idempotency_key).toBe(first.idempotency_key);
  expect(page!.container.textContent).toContain("Задача создана");
});
it("resets the choice when changing queues and keeps the draft title", async () => {
  const create = await createPage();
  await change(field(page!.container, "title"), "Сохранённый черновик");
  await act(async () => toggle().click());
  await change(field(page!.container, "queue"), mock!.state.queues[0].queue_id);await waitForPage(page!);
  expect(toggle().checked).toBe(false);expect(field(page!.container, "title").value).toBe("Сохранённый черновик");
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create.mock.calls[0][0]).not.toHaveProperty("chat_announcement");
});
it.each(["missing_vk", "network"])("preserves the draft and permits creation without announcement after %s", async failure => {
  let bad = false;
  const create = await createPage(async () => {
    if (bad && failure === "network") throw new ApiError("offline", 0, "network_error");
    return bad ? { ...context, available: false, recipient_mode: "assignees", reason: "missing_vk", missing_vk_user_ids: [101] } : context;
  });
  await change(field(page!.container, "title"), "Сохраним без рассылки");
  await act(async () => toggle().click());bad = true;
  await pick(page!.container, "users", "101");await waitForPage(page!);
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create).not.toHaveBeenCalled();expect(toggle().disabled).toBe(false);
  await act(async () => toggle().click());await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create.mock.calls[0][0]).not.toHaveProperty("chat_announcement");
  expect(create.mock.calls[0][0].assignees).toEqual([{ user_id: 101, hours: 0 }]);
});
it("refuses a changed binding until the author reviews and opts into the new revision", async () => {
  let revision = 7;
  const create = await createPage(async () => ({ ...context, binding: { ...binding, revision } }));
  await change(field(page!.container, "title"), "Проверяем другой чат");await act(async () => toggle().click());
  revision = 8;await act(async () => { await page!.client.invalidateQueries({ queryKey: ["tasks", "chat-context"] }); });await waitForPage(page!);
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create).not.toHaveBeenCalled();expect(page!.container.textContent).toContain("Привязка чата изменилась");
  await act(async () => toggle().click());await act(async () => toggle().click());
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create.mock.calls[0][0].chat_announcement).toEqual({ enabled: true, binding_revision: 8 });
});

it("gets a one-use command with the current revision, then hides it after bot confirmation", async () => {
  let settings: ChatSettings = { scope, revision: 0, binding: null, capabilities: ["manage_chat", "link_chat"] };
  vi.spyOn(taskChatApi, "settings").mockImplementation(async () => settings);
  const issue = vi.spyOn(taskChatApi, "linkCode").mockResolvedValue({ code: "ABCDE-FGHJK", command: "/site_bind ABCDE-FGHJK", expires_at: new Date(Date.now() + 600000).toISOString(), revision: 0 });
  page = await mountWorkspace(<TaskChatSettings scope={scope} />);await waitForPage(page);
  await act(async () => button("Получить код подключения").click());await waitForPage(page);
  expect(issue).toHaveBeenCalledWith(scope, { expected_revision: 0 });
  expect(page.container.querySelector<HTMLInputElement>('input[aria-label="Команда подключения чата"]')?.value).toBe("/site_bind ABCDE-FGHJK");
  settings = { scope, revision: 7, binding, capabilities: ["manage_chat", "link_chat", "unlink_chat"] };
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["tasks", "chat-settings"] }); });await waitForPage(page!);
  expect(page.container.querySelector('input[aria-label="Команда подключения чата"]')).toBeNull();
  expect(page.container.textContent).toContain("Привязка чата обновлена");
});
it("service-style capabilities permit confirmed unlink but never issuing an identity code", async () => {
  const settings: ChatSettings = { scope, revision: 7, binding, capabilities: ["manage_chat", "unlink_chat"] };
  vi.spyOn(taskChatApi, "settings").mockResolvedValue(settings);
  const issue = vi.spyOn(taskChatApi, "linkCode");
  const unlink = vi.spyOn(taskChatApi, "unlink").mockResolvedValue({ ...settings, revision: 8, binding: null, capabilities: ["manage_chat"] });
  page = await mountWorkspace(<TaskChatSettings scope={scope} />);await waitForPage(page);
  expect(page.container.textContent).not.toContain("Получить код");
  await act(async () => button("Отключить чат…").click());expect(unlink).not.toHaveBeenCalled();
  await act(async () => button("Отключить чат").click());await waitForPage(page);
  expect(unlink).toHaveBeenCalledWith(scope, { expected_revision: 7 });expect(issue).not.toHaveBeenCalled();
  expect(page.container.textContent).toContain("Чат не подключён");
});
it("clears the challenge and protected data after permission revocation", async () => {
  const read = vi.spyOn(taskChatApi, "settings").mockResolvedValue({ scope, revision: 7, binding, capabilities: ["manage_chat", "link_chat"] });
  vi.spyOn(taskChatApi, "linkCode").mockResolvedValue({ code: "ABCDE-FGHJK", command: "/site_bind ABCDE-FGHJK", expires_at: new Date(Date.now() + 600000).toISOString(), revision: 7 });
  page = await mountWorkspace(<TaskChatSettings scope={scope} />);await waitForPage(page);
  await act(async () => button("Подключить другой чат").click());await waitForPage(page);
  read.mockRejectedValue(new ApiError("refused", 403, "forbidden"));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["tasks", "chat-settings"] }); });await waitForPage(page!);
  expect(page.container.textContent).not.toContain(binding.title);
  expect(page.container.querySelector('input')).toBeNull();
});
it("retries delivery with its own revision and does not recreate the task", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const task: Task = { ...mock.state.tasks[0], chat_announcement: { announcement_id: "job-1", revision: 4, state: "failed", error_code: "chat_unavailable", created_at: "2026-11-10T10:00:00Z", created_by: user, sent_at: null, capabilities: ["retry_chat_announcement"] } };
  const retry = vi.spyOn(taskChatApi, "retry").mockResolvedValue({ ...task.chat_announcement!, state: "pending", revision: 5, capabilities: [] });
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<TaskChatDelivery task={task} />);page.client.setQueryData(["tasks", task.task_id], task);
  await act(async () => button("Повторить отправку").click());await waitForPage(page);
  expect(retry).toHaveBeenCalledWith(task.task_id, { expected_revision: 4 });expect(create).not.toHaveBeenCalled();
  expect(page.client.getQueryData<Task>(["tasks", task.task_id])?.chat_announcement?.state).toBe("pending");
});
