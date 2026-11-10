import { test, expect } from "./fixtures";
import { createFixtures } from "../src/mocks/fixtures";
import type { TaskChatContext } from "../src/utils/api/taskChat.types";

test("task chat switch fits the current form, scopes mentions and preserves the draft", async ({ page, baseURL, external }, info) => {
  const fixture = createFixtures("chair");
  const scope = { kind: "block" as const, id: fixture.blocks[0].block_id };
  const people = fixture.people.map(person => ({ ...person, avatar_url: null }));
  const queue = { ...fixture.queues[0], queue_id: "chat-queue", name: "Задачи IT", key: "IT", scope, scope_title: "IT", access: "granted", capabilities: ["create_task", "assign_task_others"], assignable_users: people, task_creation: { available: true, reason: null } };
  const otherQueue = { ...queue, queue_id: "no-chat-queue", name: "Без беседы", key: "OTHER", scope: { ...scope, id: "no-chat-block" } };
  const binding = { binding_id: "binding-synthetic", revision: 2, provider: "vk" as const, bot_identity: 900001, peer_id: 2000000001, title: "IT · команда", state: "linked" as const, confirmed_at: "2026-11-10T10:00:00Z", observed_at: "2026-11-10T10:00:00Z" };
  const submitted: Record<string, unknown>[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.context().addCookies([{ name: "access_token", value: "synthetic-visual-only", url: baseURL! }]);
  const empty = { items: [], next_cursor: null };
  await page.route(/\/api\//, async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace(/^\/api/, "");
    if (path === "/tasks/chat-context") {
      const selected = !!url.searchParams.get("assignee_user_ids"), noChat = url.searchParams.get("queue_id") === otherQueue.queue_id;
      const data: TaskChatContext = { scope: noChat ? otherQueue.scope : scope, binding: noChat ? null : binding, available: !noChat, reason: noChat ? "no_chat" : null, can_manage: true, bot_online: false, recipient_mode: selected ? "assignees" : "all", missing_vk_user_ids: [] };
      return route.fulfill({ json: data });
    }
    if (path === "/tasks" && route.request().method() === "POST") {
      submitted.push(route.request().postDataJSON());
      // The mutation is intentionally refused: verify the request and keep the draft visible.
      return route.fulfill({ status: 409, json: { detail: { code: "chat_binding_changed", message: "Привязка изменилась", fields: {} } } });
    }
    const data: Record<string, unknown> = {
      "/session": fixture.session, "/profile/me": fixture.profile,
      "/task-queues": { ...empty, items: [queue, otherQueue] },
      [`/task-queues/${queue.queue_id}`]: queue, [`/task-queues/${otherQueue.queue_id}`]: otherQueue,
      "/seasons": { ...empty, items: fixture.seasons.filter(season => season.season_id === "season-1").map(season => ({ ...season, state: "open", ends_at: "2027-01-31T20:59:59Z" })) }, "/blocks": fixture.blocks,
      "/notifications/unread-count": { count: 0 }, "/notifications": empty,
      "/events": empty, "/block-requests": empty, "/tasks": empty,
    };
    return route.fulfill({ json: data[path] ?? empty });
  });
  await page.goto(`/tasks/new?queue_id=${queue.queue_id}`);
  await page.getByRole("textbox", { name: "Название задачи" }).fill("Подготовить страницу мероприятия");
  await page.locator('textarea[name="description"]').fill("Описание останется на сайте.");
  const toggle = page.getByRole("switch", { name: "Уведомить чат VK" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const card = page.getByRole("region", { name: "Рассылка в чат VK" });
  await expect(card).toContainText("Упомянем всех участников чата");
  await expect(card).toContainText("Бот временно не в сети");
  await card.getByText("Предпросмотр сообщения", { exact: true }).click();
  await expect(card).toContainText("Подготовить страницу мероприятия");
  await card.screenshot({ path: info.outputPath("task-chat-all.png") });
  const assignee = people.find(person => person.user_id !== fixture.session.user_id)!;
  await page.locator('input[role="combobox"][name="users__query"]').fill(assignee.display_name);
  await page.getByRole("option", { name: new RegExp(assignee.display_name) }).click();
  await expect(card).toContainText(`Упомянем: ${assignee.display_name}`);
  await expect(card).not.toContainText("Упомянем всех участников чата");
  await page.getByRole("heading", { name: "Параметры", exact: true }).click();
  await page.screenshot({ path: info.outputPath("task-chat-form.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0].chat_announcement).toEqual({ enabled: true, binding_revision: binding.revision });
  expect(submitted[0].assignees).toEqual([{ user_id: assignee.user_id, hours: 0 }]);
  expect(typeof submitted[0].idempotency_key).toBe("string");
  await expect(page.getByRole("textbox", { name: "Название задачи" })).toHaveValue("Подготовить страницу мероприятия");
  await page.locator('select[name="queue"]').selectOption(otherQueue.queue_id);
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(card.getByRole("link", { name: "Настроить чат" })).toBeVisible();
  await expect(page.locator('textarea[name="description"]')).toHaveValue("Описание останется на сайте.");
  await card.screenshot({ path: info.outputPath("task-chat-no-binding.png") });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("block chat settings issue a code, observe confirmation and confirm unlink", async ({ page, baseURL, external }, info) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") browserErrors.push(entry.text()); });
  const fixture = createFixtures("chair"), block = { ...fixture.blocks[0], capabilities: ["manage_chat"] };
  if (block.master) block.master = { ...block.master, deputies: fixture.people.filter(person => block.master!.deputy_user_ids.includes(person.user_id!)) };
  const scope = { kind: "block" as const, id: block.block_id };
  const binding = { binding_id: "settings-binding", revision: 1, provider: "vk" as const, bot_identity: 900001, peer_id: 2000000001, title: "IT · команда", state: "linked" as const, confirmed_at: "2026-11-10T10:00:00Z", observed_at: "2026-11-10T10:00:00Z" };
  let linked = false, revision = 0, issued = 0, deleted = 0;
  const empty = { items: [], next_cursor: null }, path = `/scopes/block/${block.block_id}/chat`;
  const settings = () => ({ scope, revision, binding: linked ? binding : null, capabilities: ["manage_chat", "link_chat", ...(linked ? ["unlink_chat"] : [])] });
  await page.context().addCookies([{ name: "access_token", value: "synthetic-visual-only", url: baseURL! }]);
  await page.route(/\/api\//, async route => {
    const requestPath = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (requestPath === path + "/link-code") {
      expect(route.request().postDataJSON()).toEqual({ expected_revision: 0 });issued++;
      return route.fulfill({ json: { code: "ABCDE-FGHJK", command: "/site_bind ABCDE-FGHJK", expires_at: new Date(Date.now() + 600000).toISOString(), revision: 0 } });
    }
    if (requestPath === path) {
      if (route.request().method() === "DELETE") {
        expect(route.request().postDataJSON()).toEqual({ expected_revision: 1 });deleted++;linked = false;revision = 2;
      }
      return route.fulfill({ json: settings() });
    }
    const data: Record<string, unknown> = {
      "/session": fixture.session, "/profile/me": fixture.profile, [`/blocks/${block.block_id}`]: block,
      "/blocks": [block], "/block-requests": empty, "/notifications/unread-count": { count: 0 },
      "/notifications": empty, "/events": empty, "/seasons": { ...empty, items: fixture.seasons },
    };
    return route.fulfill({ json: data[requestPath] ?? empty });
  });
  await page.goto(`/blocks/${block.block_id}`);
  await expect(page.getByRole("heading", { name: block.name, exact: true })).toBeVisible().catch(error => { throw Error(`${error}\n${browserErrors.join("\n")}`); });
  await page.getByRole("button", { name: "Настройки чата" }).click();
  const dialog = page.getByRole("dialog", { name: "Чат команды в VK" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Получить код подключения", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Команда подключения чата" })).toHaveValue("/site_bind ABCDE-FGHJK");
  expect(issued).toBe(1);
  await page.screenshot({ path: info.outputPath("chat-settings-code.png"), fullPage: true });
  linked = true;revision = 1;
  await expect(dialog.getByRole("heading", { name: binding.title })).toBeVisible({ timeout: 10000 });
  await expect(dialog.getByRole("textbox", { name: "Команда подключения чата" })).toHaveCount(0);
  await expect(dialog).toContainText("Привязка чата обновлена");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("chat-settings-linked.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Отключить чат…", exact: true }).click();
  expect(deleted).toBe(0);
  await dialog.getByRole("button", { name: "Отключить чат", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Чат не подключён" })).toBeVisible();
  expect(deleted).toBe(1);
  expect(browserErrors).toEqual([]);
  expect(external).toEqual([]);
});
