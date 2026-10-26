// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, field, pick, submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { TaskCreateForm } from "./TaskCreateForm";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
it("creates in the selected same-scope queue with a parent from another readable queue", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const scope = mock.state.tasks[0].scope, parent = mock.state.tasks[0];
  mock.state.queues.push({ ...mock.state.queues[0], queue_id: "queue-extra", name: "Подготовка", key: "PREP" });
  mock.state.queues.push({ ...mock.state.queues[0], queue_id: "queue-locked", name: "Закрытая", key: "LOCK", access: "locked", capabilities: [] });
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/new" element={<TaskCreateForm scope={scope} />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: "/new" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!;
  const queue = field(form, "queue") as HTMLSelectElement;expect(queue.textContent).not.toContain("Закрытая");
  await change(queue, "queue-extra");await change(field(form, "title"), "Новая совместная задача");await change(field(form, "description"), "Проверить документы");await change(field(form, "deadline"), "2026-10-28T18:00");await change(field(form, "hours"), "3");
  const user = form.querySelector<HTMLInputElement>('input[name="users"]')!;expect(user).not.toBeNull();await pick(form, "users", user.value);
  await waitForPage(page, () => !!page!.container.querySelector('select[name="parent_task_id"] option[value="task-1"]'));
  await change(form.querySelector<HTMLSelectElement>('select[name="parent_task_id"]')!, parent.task_id);
  await waitForPage(page);await submit(form);await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача"));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ queue_id: "queue-extra", parent_task_id: parent.task_id, scope, title: "Новая совместная задача" }));
  expect(mock.state.tasks.at(-1)?.queue?.key).toBe("PREP");expect(mock.state.tasks.at(-1)?.parent_task?.task_id).toBe(parent.task_id);
});
it("queue pages pin task creation to their queue", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const queue = mock.state.queues[0];mock.state.queues.push({ ...queue, queue_id: "other", name: "Другая", key: "OTHER" });
  page = await mountWorkspace(<TaskCreateForm scope={queue.scope!} queueId={queue.queue_id} />);await waitForPage(page, () => !!page!.container.querySelector("form"));
  const select = field(page.container, "queue") as HTMLSelectElement;
  expect(select.value).toBe(queue.queue_id);expect([...select.options].filter(option => !!option.value).map(option => option.value)).toEqual([queue.queue_id]);
});
it("changing the creation season resets a parent rather than linking across seasons", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const block = mock.state.blocks.find(item => item.capabilities.includes("create_task"))!;expect(block).toBeDefined();
  const season = mock.state.seasons.find(item => item.state === "open")!;
  const parent = { ...mock.state.tasks[0], task_id: "block-parent", season_id: season.season_id, scope: { kind: "block" as const, id: block.block_id }, title: "Родитель блока" };mock.state.tasks.push(parent);
  const nextSeason = { ...season, season_id: "another-open", title: "Следующий сезон" };mock.state.seasons.push(nextSeason);
  page = await mountWorkspace(<TaskCreateForm scope={parent.scope} />);await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!;await change(field(form, "season"), season.season_id);await waitForPage(page);
  const select = form.querySelector<HTMLSelectElement>('select[name="parent_task_id"]')!;await change(select, parent.task_id);expect(select.value).toBe(parent.task_id);
  await act(async () => { await change(field(form, "season"), nextSeason.season_id); });await waitForPage(page);
  expect(form.querySelector<HTMLSelectElement>('select[name="parent_task_id"]')!.value).toBe("");
});
