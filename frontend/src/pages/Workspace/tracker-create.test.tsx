// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { filesApi } from "../../utils/api/files.api";
import { richText, type FileRef } from "../../utils/api/contract";
import { TaskCreateForm, TrackerTaskCreatePage } from "./TaskCreateForm";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
async function chooseParent(title: string) {
  const input = page!.container.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => input.focus());await change(input, title);await waitForPage(page!, () => !!page!.container.querySelector('[role="option"]'));
  const option = [...page!.container.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent?.includes(title))!;
  expect(option).toBeDefined();await act(async () => option.click());await waitForPage(page!);
}
it("opens a blank task-like editor with parameters, permits no assignees and omits accounting fields", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const queue = { ...mock.state.queues[0], queue_id: "independent", name: "Самостоятельная очередь", key: "IND", scope: null, capabilities: ["create_task"] };mock.state.queues.push(queue);
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: "/tasks/new?queue_id=independent" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));const form = page.container.querySelector("form")!;
  expect(field(form, "title").value).toBe("");expect(field(form, "description").value).toBe("");expect(field(form, "queue").value).toBe(queue.queue_id);
  expect(form.querySelector('[name="hours"]')).toBeNull();expect(form.querySelector('[name="creative"]')).toBeNull();expect(form.querySelector('[aria-label="Параметры новой задачи"]')).not.toBeNull();
  await change(field(form, "title"), "Новая свободная задача");await change(field(form, "deadline"), "2026-10-29T18:00");await submit(form);await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача") || !!page!.container.querySelector('[role="alert"]'));expect(page!.container.textContent).toContain("Созданная задача");
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ queue_id: queue.queue_id, assignees: [], watcher_user_ids: [], file_ids: [], description: richText("") }));expect(create.mock.calls[0][0]).not.toHaveProperty("scope");
});
it("keeps typed Markdown when selecting another queue and has one searchable parent selector", async () => {
  mock = installMockTransport("chair", { delay: 0 });mock.state.queues.push({ ...mock.state.queues[0], queue_id: "extra", name: "Другая очередь", key: "EXTRA" });
  page = await mountWorkspace(<TaskCreateForm queueId={mock.state.queues[0].queue_id} />);await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!;await change(field(form, "description"), "Черновик $x^2$\n\n| A | B |\n| - | - |");await change(field(form, "queue"), "extra");await waitForPage(page);
  expect(field(form, "description").value).toContain("Черновик $x^2$");expect(page.container.querySelectorAll('[role="combobox"]')).toHaveLength(1);expect(page.container.textContent).not.toContain("Поиск родительской задачи");
});
it("binds an unbound attachment and a parent from another queue when creating", async () => {
  mock = installMockTransport("chair", { delay: 0 });mock.state.queues.push({ ...mock.state.queues[0], queue_id: "extra", name: "Подготовка", key: "PREP" });
  const parent = mock.state.tasks[0], file: FileRef = { file_id: "draft-file", name: "plan.txt", mime_type: "text/plain", size_bytes: 5 };
  const upload = vi.spyOn(filesApi, "upload").mockResolvedValue(file), create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/new" element={<TaskCreateForm queueId="extra" />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: "/new" });await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!;await change(field(form, "title"), "Проверить план");await change(field(form, "deadline"), "2026-10-29T18:00");await chooseParent(parent.title);
  const input = form.querySelector<HTMLInputElement>('input[type="file"]')!, blob = new File(["draft"], "plan.txt", { type: "text/plain" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [blob] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page);
  expect(upload).toHaveBeenCalledWith(blob, { owner_kind: "task", owner_id: undefined, purpose: "attachment" }, expect.any(Function));
  await submit(form);await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача") || !!page!.container.querySelector('[role="alert"]'));expect(page!.container.textContent).toContain("Созданная задача");expect(create).toHaveBeenCalledWith(expect.objectContaining({ queue_id: "extra", parent_task_id: parent.task_id, file_ids: [file.file_id] }));
});
it("clears a chosen parent when the creation season changes", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const season = mock.state.seasons.find(item => item.state === "open")!, block = mock.state.blocks.find(item => item.capabilities.includes("create_task"))!;
  const parent = { ...mock.state.tasks[0], task_id: "block-parent", season_id: season.season_id, scope: { kind: "block" as const, id: block.block_id }, title: "Родитель блока" };mock.state.tasks.push(parent);
  mock.state.seasons.push({ ...season, season_id: "another-open", title: "Следующий сезон" });
  page = await mountWorkspace(<TaskCreateForm scope={parent.scope} />);await waitForPage(page, () => !!page!.container.querySelector("form"));await chooseParent(parent.title);
  expect(field(page.container, "parent_task_id").value).toBe(parent.task_id);await change(field(page.container, "season"), "another-open");await waitForPage(page);
  expect(field(page.container, "parent_task_id").value).toBe("");
});
