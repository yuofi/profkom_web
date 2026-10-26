// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures, people } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage, settle, change, submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { filesApi } from "../../utils/api/files.api";
import { richText, type Task, type Comment, type FileRef } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { taskStatus, taskTransitions } from "./trackerStatus";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const makeTask = (extra: Partial<Task> = {}): Task => ({ ...createFixtures("chair").tasks[0], status: "in_progress", task_key: "TASK-123", created_at: "2026-10-26T09:00:00Z", updated_at: "2026-10-26T10:00:00Z", created_by: people[0], scope_title: "Команда проверки", attachments: [], submissions: [], capabilities: ["read_task", "comment_task", "request_task_help", "submit_task_result"], ...extra });
async function click(text: string, root: ParentNode = page!.container) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text);
  expect(button, `Missing button ${text}`).toBeDefined();await act(async () => button!.click());await settle();
}
async function mountTask(task: Task, comments: Comment[] = []) {
  vi.spyOn(tasksApi, "get").mockResolvedValue(task);
  vi.spyOn(tasksApi, "comments").mockResolvedValue({ items: comments, next_cursor: null });
  vi.spyOn(tasksApi, "history").mockResolvedValue({ items: [], next_cursor: null });
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}` });
  await waitForPage(page);return page;
}
it("uses the task's common status and genuine transitions instead of an assignee's old outcome", () => {
  const task = makeTask({ status: "submitted", capabilities: ["review_task"] });
  task.assignments[0].status = "cancelled";
  expect(taskStatus(task)).toBe("submitted");expect(taskTransitions(task)).toEqual(["accepted", "needs_revision", "not_completed", "cancelled"]);
  expect(taskTransitions({ ...task, status: "accepted" })).toEqual(["needs_revision"]);
  expect(taskTransitions({ ...task, capabilities: [] })).toEqual([]);
});
it("a status chip owns its click and starts the whole task with the task revision", async () => {
  const task = makeTask({ status: "assigned", revision: 5, capabilities: ["start_task"] });
  const command = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, revision: 6, status: "in_progress" });
  const openRow = vi.fn();page = await mountWorkspace(<div onClick={openRow}><TaskStatusMenu task={task} /></div>);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Статус задачи: Назначена"]')!.click());await settle();
  expect(openRow).not.toHaveBeenCalled();
  const options = [...page.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(options.find(button => button.textContent?.includes("Принята"))?.disabled).toBe(true);
  await act(async () => options.find(button => button.textContent?.trim() === "В работе")!.click());await waitForPage(page);
  expect(command).toHaveBeenCalledWith(task.task_id, { expected_revision: 5, status: "in_progress" });expect(openRow).not.toHaveBeenCalled();
});
it("status menu supports arrow keys, Home/End and restores focus on Escape", async () => {
  const task = makeTask({ status: "assigned", capabilities: ["start_task", "request_task_help", "submit_task_result"] });
  page = await mountWorkspace(<TaskStatusMenu task={task} />);
  const trigger = page.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());await settle();
  expect(document.activeElement?.textContent?.trim()).toBe("В работе");
  const press = async (key: string) => { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); };
  await press("ArrowDown");expect(document.activeElement?.textContent?.trim()).toBe("Нужна помощь");
  await press("End");expect(document.activeElement?.textContent?.trim()).toBe("На проверке");
  await press("Home");expect(document.activeElement?.textContent?.trim()).toBe("В работе");
  await press("Escape");expect(page.container.querySelector('[role="menu"]')).toBeNull();expect(document.activeElement).toBe(trigger);
});
it("one shared file-only result targets the task rather than an individual assignment", async () => {
  const task = makeTask();const file: FileRef = { file_id: "shared-file", name: "result.txt", mime_type: "text/plain", size_bytes: 10 };
  const upload = vi.spyOn(filesApi, "upload").mockResolvedValue(file);
  const command = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, status: "submitted", revision: task.revision + 1 });
  page = await mountWorkspace(<TaskStatusMenu task={task} variant="actions" />);await click("Сдать результат");
  const input = page.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const blob = new File(["shared result"], "result.txt", { type: "text/plain" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [blob] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page);
  expect(upload).toHaveBeenCalledWith(blob, { owner_kind: "task", owner_id: task.task_id, purpose: "submission" }, expect.any(Function));
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(command).toHaveBeenCalledWith(task.task_id, expect.objectContaining({ status: "submitted", text: richText(""), file_ids: [file.file_id] }));
});
it("comments switch newest/oldest order and retain the unposted Markdown draft across tabs", async () => {
  const task = makeTask();const comments: Comment[] = [
    { comment_id: "old", task_id: task.task_id, author: people[0], content: richText("Первый комментарий"), created_at: "2026-10-25T10:00:00Z", updated_at: null, capabilities: [] },
    { comment_id: "new", task_id: task.task_id, author: people[1], content: richText("Второй комментарий"), created_at: "2026-10-26T10:00:00Z", updated_at: null, capabilities: [] },
  ];
  await mountTask(task, comments);
  const displayed = () => [...page!.container.querySelectorAll("article")].map(item => item.textContent);
  expect(displayed()[0]).toContain("Второй комментарий");
  const order = page!.container.querySelector<HTMLSelectElement>('[aria-label="Порядок записей"]')!;await change(order, "oldest");expect(displayed()[0]).toContain("Первый комментарий");
  const editor = page!.container.querySelector<HTMLTextAreaElement>("textarea")!;await change(editor, "Несданный черновик $x^2$ с таблицей");
  await click("История");await waitForPage(page!);expect(editor.isConnected).toBe(true);expect(editor.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);
  await click("Комментарии");expect(editor.value).toBe("Несданный черновик $x^2$ с таблицей");
  const command = vi.spyOn(tasksApi, "comment").mockResolvedValue({ ...comments[0], comment_id: "posted" });
  await submit(editor.closest("form")!);await waitForPage(page!);
  expect(command).toHaveBeenCalledWith(task.task_id, richText("Несданный черновик $x^2$ с таблицей"));expect(editor.value).toBe("");
});
it("renders shared submissions once and leaves accounting hidden from ordinary readers", async () => {
  const task = makeTask({ capabilities: ["read_task"], submissions: [{ submission_id: "shared-result", submitted_at: "2026-10-26T11:00:00Z", submitted_by: people[0], text: richText("Общий результат"), links: [], files: [] }] });
  task.assignments = task.assignments.map(assignment => ({ ...assignment, capabilities: [] }));
  await mountTask(task);expect(page!.container.textContent).not.toContain("Учёт работы и ККР");
  await click("Вложения");expect(page!.container.textContent?.match(/Общий результат/g)).toHaveLength(1);
  expect(page!.container.querySelector('a[href="/contacts/101"]')).not.toBeNull();
  expect(page!.container.querySelector('button[aria-label="Чеклист — запланировано"]')?.hasAttribute("disabled")).toBe(true);
});

it("removes an open description editor when editing rights are revoked", async () => {
  const task = makeTask({ capabilities: ["read_task", "edit_task"] });
  await mountTask(task);await click("Редактировать");
  const input = page!.container.querySelector<HTMLInputElement>('input[name="title"]')!;expect(input).not.toBeNull();
  await change(input, "Старый черновик без прав");
  vi.mocked(tasksApi.get).mockResolvedValue({ ...task, capabilities: ["read_task"] });
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["tasks", task.task_id], exact: true }); });await waitForPage(page!);
  expect(page!.container.querySelector("dialog")).toBeNull();expect(page!.container.querySelector('input[name="title"]')).toBeNull();
});

it.each([true, false])("deadline shortcut follows actual date-edit rights (editable: %s)", async editable => {
  const fixture = createFixtures("chair");
  const task = makeTask({ capabilities: ["read_task", "view_assessment_inputs"], assignments: fixture.tasks[0].assignments.map(assignment => ({ ...assignment, capabilities: [] })) });
  const inputs = vi.spyOn(tasksApi, "inputs").mockResolvedValue({ ...fixture.inputs, capabilities: ["view_assessment_inputs", "edit_assessment_inputs", ...(editable ? ["edit_assessment_dates"] : [])] });
  await mountTask(task);
  const button = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Изменить дедлайн");
  expect(!!button).toBe(editable);expect(inputs).toHaveBeenCalledTimes(1);
  if (editable) {
    await click("Изменить дедлайн");
    const field = page!.container.querySelector<HTMLInputElement>('input[name="deadline"]')!;
    expect(document.activeElement).toBe(field);expect(field.closest("details")?.open).toBe(true);
    const accounting = [...page!.container.querySelectorAll<HTMLDetailsElement>("details")].find(item => item.querySelector(":scope > summary")?.textContent === "Учёт работы и ККР");
    expect(accounting?.open).toBe(true);
  } else expect(page!.container.querySelector('input[name="deadline"]')).toBeNull();
});

it.each(["needs_revision", "cancelled", "not_completed"] as const)("shows readable review reasons once for a shared %s task", async status => {
  const reason = "Нужны фотографии встречи";
  const task = makeTask({ status, capabilities: ["read_task"] });
  task.assignments = task.assignments.map(assignment => ({ ...assignment, review_note: reason, capabilities: [] }));
  await mountTask(task);
  const panel = page!.container.querySelector('[aria-label="Комментарий руководителя"]')!;
  expect(panel).not.toBeNull();expect(panel.textContent?.match(new RegExp(reason, "g"))).toHaveLength(1);
  expect(panel.textContent).not.toContain("Часы:");
});
