import { test, expect } from "./fixtures";
import { createFixtures } from "../src/mocks/fixtures";
import type { Block, Task } from "../src/utils/api/contract";

test("block settings preserve the current layout and require two decisions before the delay", async ({ page, baseURL, external }, info) => {
  const f = createFixtures("chair"), people = f.people.map(p => ({ ...p, avatar_url: null }));
  let block: Block = { ...f.blocks[0], name: "Команда проектов", archived_at: null, deletion_request: null,
    capabilities: ["rename_block", "edit_block", "start_block_deletion"], avatar_url: null };
  if (block.master) block.master = { ...block.master, user: { ...block.master.user, avatar_url: null }, deputies: people.filter(p => block.master!.deputy_user_ids.includes(p.user_id!)) };
  const path = `/blocks/${block.block_id}`, errors: string[] = [], commands: string[] = [];
  const empty = { items: [], next_cursor: null }, at = new Date().toISOString();
  page.on("pageerror", e => errors.push(e.message));
  await page.context().addCookies([{ name: "access_token", value: "synthetic-browser-test", url: baseURL! }]);
  await page.route(/\/api\//, async route => {
    const request = route.request(), requested = new URL(request.url()).pathname.replace(/^\/api/, "");
    if (requested === path && request.method() === "PATCH") {
      const body = request.postDataJSON();expect(body.expected_revision).toBe(block.revision);
      commands.push("rename");block = { ...block, name: body.name, revision: block.revision + 1 };
    }
    if (requested.startsWith(path + "/deletion-request") && request.method() === "POST") {
      const body = request.postDataJSON();expect(body.expected_revision).toBe(block.revision);
      commands.push(requested);
      if (requested.endsWith("/deletion-request")) block = { ...block, revision: block.revision + 1, capabilities: ["rename_block", "edit_block"], deletion_request: {
        request_id: "synthetic-delete", revision: 1, state: "pending", created_at: at, scheduled_at: null,
        delete_after: null, finished_at: null, cancel_reason: null,
        approvals: [{ actor: people[0], at }], capabilities: ["cancel_block_deletion"],
      } };
      else if (requested.endsWith("/approve")) {
        expect(body.request_id).toBe("synthetic-delete");
        block = { ...block, revision: block.revision + 1, deletion_request: { ...block.deletion_request!, revision: 2, state: "scheduled", scheduled_at: at,
          delete_after: new Date(Date.parse(at) + 72 * 3600000).toISOString(), approvals: [...block.deletion_request!.approvals, { actor: people[1], at }], capabilities: ["cancel_block_deletion"] } };
      } else if (requested.endsWith("/cancel")) block = { ...block, revision: block.revision + 1,
        capabilities: ["rename_block", "edit_block", "start_block_deletion"],
        deletion_request: { ...block.deletion_request!, revision: 3, state: "cancelled", finished_at: at, cancel_reason: "cancelled_by_leadership", capabilities: [] } };
      return route.fulfill({ json: block });
    }
    const data: Record<string, unknown> = {
      "/session": f.session, "/profile/me": f.profile, [path]: block, "/blocks": [block],
      "/block-requests": empty, "/notifications": empty, "/notifications/unread-count": { count: 0 },
      "/contacts": [], "/events": empty, "/seasons": { ...empty, items: f.seasons },
    };
    return route.fulfill({ json: data[requested] ?? empty });
  });
  await page.goto(path);
  await expect(page.getByRole("heading", { name: block.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Настройки блока", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Настройки блока" });
  await settings.getByRole("textbox", { name: "Название блока" }).fill("P2B · проекты");
  await settings.getByRole("button", { name: "Сохранить название", exact: true }).click();
  await expect.poll(() => commands).toEqual(["rename"]);
  await expect(page.getByRole("heading", { name: "P2B · проекты", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("block-settings.png"), fullPage: true });
  await settings.getByRole("button", { name: "Запросить удаление блока", exact: true }).click();
  expect(commands).toHaveLength(1);
  await page.getByRole("button", { name: "Подтвердить запрос", exact: true }).click();
  const status = page.getByRole("region", { name: "Удаление блока", exact: true });
  await expect(status).toContainText("Получено 1 из 2 подтверждений");
  await expect(status.getByRole("button", { name: "Подтвердить удаление", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("block-first-approval.png"), fullPage: true });
  // A fresh authenticated view of another authorized human has the server-issued capability.
  block = { ...block, deletion_request: { ...block.deletion_request!, capabilities: ["approve_block_deletion", "cancel_block_deletion"] } };
  await page.reload();
  await status.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
  expect(commands).toHaveLength(2);
  await page.getByRole("button", { name: "Подтвердить и запустить 72 часа", exact: true }).click();
  await expect(status).toContainText("Удаление блока запланировано");
  await expect(status.getByRole("timer")).toContainText("Осталось");
  await page.screenshot({ path: info.outputPath("block-72-hours.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await status.getByRole("button", { name: "Отменить удаление", exact: true }).click();
  await expect(status).toHaveCount(0);
  expect(commands).toHaveLength(4);
  expect(errors).toEqual([]);expect(external).toEqual([]);
});

test("block task can be created without a season and closes through one explicit season command", async ({ page, baseURL, external }, info) => {
  const f = createFixtures("chair"), scope = { kind: "block" as const, id: f.blocks[0].block_id };
  const empty = { items: [], next_cursor: null }, errors: string[] = [], posted: Record<string, unknown>[] = [], statuses: Record<string, unknown>[] = [];
  const season = { ...f.seasons.find(s => s.season_id === "season-1")!, state: "open", ends_at: "2027-03-01T20:59:59Z" };
  const queue = { ...f.queues[0], queue_id: "year-round", name: "Задачи блока", key: "YEAR", scope, scope_title: "IT", season: null,
    access: "granted", capabilities: ["create_task", "assign_task_others"], assignable_users: [], task_creation: { available: true, reason: null } };
  let task: Task = { ...f.tasks[0], task_id: "year-round-task", task_key: "YEAR-1", title: "Подготовить встречу команды", scope, scope_title: "IT",
    season_id: null, deadline_at: null, starts_at: null, created_by: f.people[0], status: "open", revision: 1,
    assignments: [], assignees: [], watchers: [], links: [], children: [], parent_task: null, checklist: [],
    queue: { queue_id: queue.queue_id, key: queue.key, name: queue.name, readable: true },
    capabilities: ["assign_season", "change_task_status", "close_task"], allowed_statuses: ["open", "in_progress", "completed", "closed"], chat_announcement: null };
  page.on("pageerror", e => errors.push(e.message));
  await page.context().addCookies([{ name: "access_token", value: "synthetic-browser-test", url: baseURL! }]);
  await page.route(/\/api\//, async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, "");
    if (path === "/tasks" && request.method() === "POST") { posted.push(request.postDataJSON());return route.fulfill({ json: task }); }
    if (path === `/tasks/${task.task_id}/status` && request.method() === "POST") {
      const body = request.postDataJSON();statuses.push(body);
      task = { ...task, season_id: body.season_id, status: "closed", revision: 2, capabilities: ["change_task_status"], allowed_statuses: ["open"] };
      return route.fulfill({ json: task });
    }
    const data: Record<string, unknown> = {
      "/session": f.session, "/profile/me": f.profile, "/task-queues": { ...empty, items: [queue] },
      [`/task-queues/${queue.queue_id}`]: queue, [`/tasks/${task.task_id}`]: task,
      "/seasons": { ...empty, items: [season] }, "/blocks": f.blocks,
      "/notifications": empty, "/notifications/unread-count": { count: 0 }, "/contacts": [],
      "/events": empty, "/tasks": empty, "/block-requests": empty,
      "/tasks/chat-context": { scope, binding: null, available: false, reason: "no_chat", can_manage: true, bot_online: false, recipient_mode: "all", missing_vk_user_ids: [] },
    };
    return route.fulfill({ json: data[path] ?? empty });
  });
  await page.goto(`/tasks/new?queue_id=${queue.queue_id}`);
  await page.getByRole("textbox", { name: "Название задачи" }).fill(task.title);
  await page.locator('select[name="season"]').selectOption("");
  await expect(page.locator('select[name="season"]')).toHaveValue("");
  await page.screenshot({ path: info.outputPath("task-optional-season.png"), fullPage: true });
  await page.getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].season_id).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.task_id}$`));
  const parameters = page.locator('details').filter({ has: page.locator("summary", { hasText: "Параметры" }) });
  if (!await parameters.getAttribute("open").then(v => v !== null)) await parameters.locator("summary").click();
  await expect(page.getByText("Укажите сезон до закрытия", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("task-missing-season.png"), fullPage: true });
  const openClose = async () => {
    await page.getByRole("button", { name: "Статус задачи: Открыта", exact: true }).click();
    await page.getByRole("menuitem", { name: "Закрыта", exact: true }).click();
  };
  await openClose();
  const dialog = page.getByRole("dialog", { name: "Сезон перед закрытием задачи" });
  await expect(dialog).toBeVisible();
  expect(statuses).toHaveLength(0);
  await dialog.getByRole("button", { name: "Закрыть окно", exact: true }).click();
  expect(statuses).toHaveLength(0);
  await openClose();
  await dialog.locator('select[name="season_id"]').selectOption(season.season_id);
  await page.screenshot({ path: info.outputPath("task-close-with-season.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Указать сезон и закрыть", exact: true }).click();
  await expect.poll(() => statuses.length).toBe(1);
  expect(statuses[0]).toEqual({ expected_revision: 1, status: "closed", season_id: season.season_id });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Укажите сезон до закрытия", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);expect(external).toEqual([]);
});
