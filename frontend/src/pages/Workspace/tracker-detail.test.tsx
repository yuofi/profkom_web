// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures, people } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage, settle, change, submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { filesApi } from "../../utils/api/files.api";
import { richText, type Task, type Comment, type FileRef } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { taskStatus, taskTransitions } from "./trackerStatus";
import { TrackerTaskHistoryDiff } from "./TrackerTaskHistoryDiff";
import { TaskDeadlineParameter } from "./TaskDeadlineParameter";
import { ApiError } from "../../utils/api/request";
import { historyApi } from "../../utils/api/history.api";
import { taskCollaborationApi } from "../../utils/api/taskCollaboration.api";
import { QueryClient } from "@tanstack/react-query";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const makeTask = (extra: Partial<Task> = {}): Task => ({ ...createFixtures("chair").tasks[0], status: "in_progress", task_key: "TASK-123", created_at: "2026-10-26T09:00:00Z", updated_at: "2026-10-26T10:00:00Z", created_by: people[0], scope_title: "Команда проверки", attachments: [], submissions: [], capabilities: ["read_task", "comment_task", "change_task_status", "submit_task_result"], ...extra });
async function click(text: string, root: ParentNode = page!.container) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text);
  expect(button, `Missing button ${text}`).toBeDefined();await act(async () => button!.click());await settle();
}
async function mountTask(task: Task, comments: Comment[] = [], search = "") {
  vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: createFixtures("chair").seasons, next_cursor: null });
  vi.spyOn(tasksApi, "get").mockResolvedValue(task);
  vi.spyOn(tasksApi, "comments").mockResolvedValue({ items: comments, next_cursor: null });
  vi.spyOn(historyApi, "list").mockResolvedValue({ items: [], next_cursor: null });
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}${search}` });
  await waitForPage(page);return page;
}
it("uses the common public status and permits every other target without reading the accounting outcome", () => {
  const task = makeTask({ status: "completed", capabilities: ["change_task_status"] });task.assignments[0].status = "cancelled";
  expect(taskStatus(task)).toBe("completed");expect(taskTransitions(task)).toHaveLength(3);expect(taskTransitions(task)).not.toContain("completed");expect(taskTransitions(task)).toContain("open");
  expect(taskTransitions({ ...task, status: "closed" })).toContain("open");expect(taskTransitions({ ...task, capabilities: [] })).toEqual([]);
});
it("offers only the server's allowed transitions and shows a locked status without a menu", async () => {
  const reader = makeTask({ status: "in_progress", allowed_statuses: ["open", "in_progress", "completed"], capabilities: ["change_task_status"] });
  expect(taskTransitions(reader)).toEqual(["open", "completed"]);
  expect(taskTransitions({ ...reader, allowed_statuses: undefined })).toEqual([]);
  page = await mountWorkspace(<><TaskStatusMenu task={{ ...reader, status: "closed", allowed_statuses: [] }} /><TaskStatusMenu task={{ ...reader, queue: { queue_id: "kkr", name: "Контроль ККР", key: "KKR" }, allowed_statuses: [], capabilities: [] }} /></>);
  expect(page.container.querySelector('[aria-haspopup="menu"]')).toBeNull();
  const chips = [...page.container.querySelectorAll<HTMLElement>('[aria-label^="Статус задачи:"]')];
  expect(chips.map(chip => chip.title)).toEqual(["Переоткрыть задачу может только её автор.", "Статус контрольного эпика меняется автоматически."]);
});
it("a refused closure explains that only the author closes the task", async () => {
  const task = makeTask({ status: "completed", allowed_statuses: ["open", "in_progress", "completed", "closed"], capabilities: ["change_task_status"] });
  vi.spyOn(tasksApi, "changeStatus").mockRejectedValue(new ApiError("Only the task author may close or reopen this task", 403, "task_close_author_only"));
  page = await mountWorkspace(<TaskStatusMenu task={task} />);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await settle();
  await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes("Закрыта"))!.click());await waitForPage(page);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toBe("Закрыть или переоткрыть задачу может только её автор.");
});
it("a status menu near the right edge opens leftwards instead of widening the page", async () => {
  const task = makeTask({ status: "open", allowed_statuses: ["open", "in_progress"], capabilities: ["change_task_status"] });
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 900, right: 990, top: 0, bottom: 32, width: 90, height: 32, x: 900, y: 0, toJSON: () => ({}) });
  page = await mountWorkspace(<TaskStatusMenu task={task} />);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await settle();
  expect(page.container.querySelector('[role="menu"]')!.className).toMatch(/menuEnd/);
});
it("a status chip owns its click and starts the whole task with the task revision", async () => {
  const task = makeTask({ status: "open", revision: 5, capabilities: ["change_task_status"] });
  const command = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, revision: 6, status: "in_progress" });
  const openRow = vi.fn();page = await mountWorkspace(<div onClick={openRow}><TaskStatusMenu task={task} /></div>);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Статус задачи: Открыта"]')!.click());await settle();
  expect(openRow).not.toHaveBeenCalled();
  const options = [...page.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(options.find(button => button.textContent?.includes("Закрыта"))?.disabled).toBe(false);expect(options.find(button => button.textContent?.includes("Открыта"))?.disabled).toBe(true);
  await act(async () => options.find(button => button.textContent?.trim() === "В работе")!.click());await waitForPage(page);
  expect(command).toHaveBeenCalledWith(task.task_id, { expected_revision: 5, status: "in_progress" });expect(openRow).not.toHaveBeenCalled();
});
it("a saved status shows at once in cached task lists, only on its own row", async () => {
  const task = makeTask({ status: "open", revision: 5, allowed_statuses: ["open", "in_progress"], capabilities: ["change_task_status"] }), other = makeTask({ task_id: "other", status: "open" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  client.setQueryData(["tasks", "page", {}], { items: [task, other], next_cursor: null });client.setQueryData(["tasks", "planning", {}, "a", "b"], [task]);
  vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, revision: 6, status: "in_progress", allowed_statuses: ["open", "in_progress", "completed"] });
  page = await mountWorkspace(<TaskStatusMenu task={task} />, { client });
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await settle();
  await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.trim() === "В работе")!.click());await waitForPage(page);
  const rows = client.getQueryData<{ items: Task[] }>(["tasks", "page", {}])!.items;
  expect(rows.map(row => [row.task_id, row.status, row.revision])).toEqual([[task.task_id, "in_progress", 6], ["other", "open", other.revision]]);
  expect(rows[0].allowed_statuses).toEqual(["open", "in_progress", "completed"]);
  expect(client.getQueryData<Task[]>(["tasks", "planning", {}, "a", "b"])![0].status).toBe("in_progress");
});
it("status menu supports arrow keys, Home/End and restores focus on Escape", async () => {
  const task = makeTask({ status: "open", capabilities: ["change_task_status", "submit_task_result"] });
  page = await mountWorkspace(<TaskStatusMenu task={task} />);
  const trigger = page.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());await settle();
  expect(document.activeElement?.textContent?.trim()).toBe("В работе");
  const press = async (key: string) => { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); };
  await press("ArrowDown");expect(document.activeElement?.textContent?.trim()).toBe("Выполнена");
  await press("End");expect(document.activeElement?.textContent?.trim()).toBe("Закрыта");
  await press("Home");expect(document.activeElement?.textContent?.trim()).toBe("В работе");
  await press("Escape");expect(page.container.querySelector('[role="menu"]')).toBeNull();expect(document.activeElement).toBe(trigger);
});
it("one shared file-only result targets the task rather than an individual assignment", async () => {
  const task = makeTask();const file: FileRef = { file_id: "shared-file", name: "result.txt", mime_type: "text/plain", size_bytes: 10 };
  const upload = vi.spyOn(filesApi, "upload").mockResolvedValue(file);
  const command = vi.spyOn(tasksApi, "submitResult").mockResolvedValue({ ...task, status: "completed", revision: task.revision + 1 });
  page = await mountWorkspace(<TaskStatusMenu task={task} variant="actions" />);await click("Сдать результат");
  // The result dialog is loaded on demand: under load its code may take longer than one settle.
  await waitForPage(page, () => !!page!.container.querySelector('input[type="file"]'));
  const input = page.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const blob = new File(["shared result"], "result.txt", { type: "text/plain" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [blob] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page);
  expect(upload).toHaveBeenCalledWith(blob, { owner_kind: "task", owner_id: task.task_id, purpose: "submission" }, expect.any(Function));
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(command).toHaveBeenCalledWith(task.task_id, expect.objectContaining({ text: richText(""), file_ids: [file.file_id] }));
});
it("comments switch newest/oldest order and retain the unposted Markdown draft across tabs", async () => {
  const task = makeTask();const comments: Comment[] = [
    { comment_id: "old", attachments: [], task_id: task.task_id, author: people[0], content: richText("Первый комментарий"), created_at: "2026-10-25T10:00:00Z", updated_at: null, capabilities: [] },
    { comment_id: "new", attachments: [], task_id: task.task_id, author: people[1], content: richText("Второй комментарий"), created_at: "2026-10-26T10:00:00Z", updated_at: null, capabilities: [] },
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
  expect(command).toHaveBeenCalledWith(task.task_id, richText("Несданный черновик $x^2$ с таблицей"), [], [], expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));expect(editor.value).toBe("");
});
it("renders shared submissions once and leaves accounting hidden from ordinary readers", async () => {
  const task = makeTask({ capabilities: ["read_task"], submissions: [{ submission_id: "shared-result", submitted_at: "2026-10-26T11:00:00Z", submitted_by: people[0], text: richText("Общий результат"), links: [], files: [] }] });
  task.assignments = task.assignments.map(assignment => ({ ...assignment, capabilities: [] }));
  await mountTask(task);expect(page!.container.textContent).not.toContain("Учёт работы и ККР");
  await click("Вложения");expect(page!.container.textContent?.match(/Общий результат/g)).toHaveLength(1);
  expect(page!.container.querySelector('a[href="/contacts/101"]')).not.toBeNull();
  expect(page!.container.querySelector('button[aria-label="Чеклист — запланировано"]')).toBeNull();
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

it.each(["open", "closed"] as const)("accounting opens only after closure (%s)", async status => {
  const task=makeTask({status,capabilities:["read_task","view_assessment_inputs"]});
  await mountTask(task);
  expect(page!.container.textContent?.includes("Оценить работу")).toBe(status==="closed");
  expect(page!.container.querySelector('input[name="deadline"]')).toBeNull();
});

it.each(["open", "completed", "closed"] as const)("shows readable review reasons once for a shared %s task", async status => {
  const reason = "Нужны фотографии встречи";
  const task = makeTask({ status, capabilities: ["read_task"] });
  task.assignments = task.assignments.map(assignment => ({ ...assignment, review_note: reason, capabilities: [] }));
  await mountTask(task);
  const panel = page!.container.querySelector('[aria-label="Комментарий руководителя"]')!;
  expect(panel).not.toBeNull();expect(panel.textContent?.match(new RegExp(reason, "g"))).toHaveLength(1);
  expect(panel.textContent).not.toContain("Часы:");
});


it("an explicit description capability supplies the editor without title rights", async () => {
  const task = makeTask({ capabilities: ["read_task", "edit_task_description"] });
  const saved = { ...task, revision: task.revision + 1, description: richText("Обновлено исполнителем") };
  const update = vi.spyOn(tasksApi, "update").mockResolvedValue(saved);
  await mountTask(task);await click("Редактировать");
  const dialog = page!.container.querySelector("dialog")!;
  expect(dialog.querySelector('input[name="title"]')).toBeNull();
  await change(dialog.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!, "Обновлено исполнителем");
  await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(update).toHaveBeenCalledWith(task.task_id, { expected_revision: task.revision, description: richText("Обновлено исполнителем") });
});

it("saves a checklist mark through the description revision and refreshes its history", async () => {
  let task = makeTask({ description: richText("- [ ] Проверить документы\n- [x] Готовый пункт"), revision: 8, capabilities: ["read_task", "toggle_task_checklist"] });
  const update = vi.spyOn(tasksApi, "descriptionChecklist").mockImplementation(async (_id, data) => { const body = task.description.body;task = { ...task, revision: 9, description: richText(body.slice(0, data.offset) + (data.checked ? "x" : " ") + body.slice(data.offset + 1)) };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  const check = page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')!;
  expect(check.disabled).toBe(false);
  await act(async () => check.click());await waitForPage(page!, () => page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')?.checked === true);
  expect(update).toHaveBeenCalledWith(task.task_id, { expected_revision: 8, offset: 3, checked: true });
  expect(task.description.body).toBe("- [x] Проверить документы\n- [x] Готовый пункт");
  await click("История");await waitForPage(page!);expect(historyApi.list).toHaveBeenCalledWith("task", task.task_id);
});

it("names a mark after emoji by its UTF-16 offset, the unit the server maps", async () => {
  const body = "- [ ] A " + "😀".repeat(11) + "\n- [ ] Бета\n- [ ] Гамма\n";
  let task = makeTask({ description: richText(body), revision: 8, capabilities: ["read_task", "toggle_task_checklist"] });
  const update = vi.spyOn(tasksApi, "descriptionChecklist").mockImplementation(async (_id, data) => {
    const text = task.description.body;task = { ...task, revision: 9, description: richText(text.slice(0, data.offset) + (data.checked ? "x" : " ") + text.slice(data.offset + 1)) };return task;
  });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  const boxes = () => [...page!.container.querySelectorAll<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')];
  const beta = boxes().find(box => box.getAttribute("aria-label") === "Отметить: Бета")!;
  await act(async () => beta.click());await waitForPage(page!, () => boxes()[1]?.checked === true);
  // 34 is a JavaScript index; counted in code points (each emoji once) the mark is at 23.
  expect(update).toHaveBeenCalledWith(task.task_id, { expected_revision: 8, offset: 34, checked: true });
  expect([...body.slice(0, 34)].length).toBe(23);
  expect(task.description.body).toBe(body.replace("- [ ] Бета", "- [x] Бета"));
  expect(boxes().map(box => box.checked)).toEqual([false, true, false]);
});

it("rapid marks in the description and the checklist all save in order with own revisions", async () => {
  let task = makeTask({ description: richText("- [ ] Первый\n- [ ] Второй"), revision: 8, checklist: [{ item_id: "one", text: "Пункт", checked: false }, { item_id: "two", text: "Ещё", checked: false }], capabilities: ["read_task", "toggle_task_checklist"] });
  const releases: (() => void)[] = [];const later = () => new Promise<void>(resolve => releases.push(resolve));
  const marks = vi.spyOn(tasksApi, "descriptionChecklist").mockImplementation(async (_id, data) => {
    await later();if (data.expected_revision !== task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    const body = task.description.body;task = { ...task, revision: task.revision + 1, description: richText(body.slice(0, data.offset) + (data.checked ? "x" : " ") + body.slice(data.offset + 1)) };return task;
  });
  const toggles = vi.spyOn(tasksApi, "toggleChecklist").mockImplementation(async (_id, itemId, data) => {
    await later();if (data.expected_revision !== task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    task = { ...task, revision: task.revision + 1, checklist: task.checklist!.map(item => item.item_id === itemId ? { ...item, checked: data.checked } : item) };return task;
  });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  const boxes = () => [...page!.container.querySelectorAll<HTMLInputElement>('main input[type="checkbox"], section input[type="checkbox"]')];
  const description = () => [...page!.container.querySelectorAll<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')];
  const checklist = () => [...page!.container.querySelectorAll<HTMLInputElement>('section[aria-label="Чеклист задачи"] input[type="checkbox"]')];
  expect(boxes().length).toBeGreaterThanOrEqual(4);
  await act(async () => description()[0].click());
  expect(description()[0].checked).toBe(true);expect(description()[0].disabled).toBe(true);expect(description()[1].disabled).toBe(false);expect(checklist()[0].disabled).toBe(false);
  expect(page!.container.querySelector('section[aria-label="Описание задачи"] [role="status"]')?.textContent).toBe("Сохраняем отметку…");
  await act(async () => checklist()[0].click());await act(async () => description()[1].click());
  expect(checklist()[0].checked).toBe(true);expect(description()[1].checked).toBe(true);
  for (let step = 0; step < 3; step++) { await waitForPage(page!, () => releases.length > 0);await act(async () => releases.shift()!());await settle(); }
  await waitForPage(page!, () => !page!.container.querySelector('[aria-busy="true"]'));
  expect([marks.mock.calls[0][1], toggles.mock.calls[0][2], marks.mock.calls[1][1]]).toEqual([{ expected_revision: 8, offset: 3, checked: true }, { expected_revision: 9, checked: true }, { expected_revision: 10, offset: 16, checked: true }]);
  expect(page!.container.querySelector('section[aria-label="Описание задачи"] [role="alert"], section[aria-label="Чеклист задачи"] [role="alert"]')).toBeNull();
  expect(task.description.body).toBe("- [x] Первый\n- [x] Второй");expect(task.checklist![0].checked).toBe(true);expect(task.revision).toBe(11);
  expect(description().map(box => box.checked)).toEqual([true, true]);expect(checklist().map(box => box.checked)).toEqual([true, false]);
});

it("a link removed right after a checkmark waits for it and sends the next own revision", async () => {
  const link = { link_id: "link-1", kind: "related" as const, task: { task_id: "other", task_key: "WEB-2", title: "Другая", status: "open" as const, deadline_at: null, starts_at: null, task_type: "task" as const } };
  let task = makeTask({ description: richText("- [ ] Первый"), revision: 8, links: [link], capabilities: ["read_task", "toggle_task_checklist", "manage_task_links"] });
  const releases: (() => void)[] = [];const later = () => new Promise<void>(resolve => releases.push(resolve));
  const marks = vi.spyOn(tasksApi, "descriptionChecklist").mockImplementation(async (_id, data) => {
    await later();if (data.expected_revision !== task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    task = { ...task, revision: task.revision + 1, description: richText("- [x] Первый") };return task;
  });
  const remove = vi.spyOn(tasksApi, "removeLink").mockImplementation(async (_id, _link, data) => {
    if (data.expected_revision !== task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    task = { ...task, revision: task.revision + 1, links: [] };return task;
  });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  await act(async () => page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')!.click());
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Удалить связь: WEB-2"]')!.click());
  expect(remove).not.toHaveBeenCalled();
  await waitForPage(page!, () => releases.length > 0);await act(async () => releases.shift()!());
  await waitForPage(page!, () => !page!.container.querySelector('[aria-label="Удалить связь: WEB-2"]'));
  expect([marks.mock.calls[0][1].expected_revision, remove.mock.calls[0][2].expected_revision]).toEqual([8, 9]);
  expect(page!.container.querySelector('section[aria-label="Связанные задачи"] [role="alert"], section[aria-label="Описание задачи"] [role="alert"]')).toBeNull();expect(task.revision).toBe(10);
});

/** A task with one checklist item whose title and description the reader edits, and its server (TR-01).
 *  `foreignTitle`: someone else renames the task right after the checkmark is saved. */
function editableWithChecklist(foreignTitle?: string) {
  const server = { task: makeTask({ title: "Старое название", description: richText("Старое описание"), revision: 8, checklist: [{ item_id: "one", text: "Пункт", checked: false }], capabilities: ["read_task", "toggle_task_checklist", "edit_task"] }) };
  const releases: (() => void)[] = [];
  const toggles = vi.spyOn(tasksApi, "toggleChecklist").mockImplementation(async (_id, itemId, data) => {
    await new Promise<void>(resolve => releases.push(resolve));
    if (data.expected_revision !== server.task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    const own = server.task = { ...server.task, revision: server.task.revision + 1, checklist: server.task.checklist!.map(item => item.item_id === itemId ? { ...item, checked: data.checked } : item) };
    if (foreignTitle) server.task = { ...server.task, revision: server.task.revision + 1, title: foreignTitle };
    return own;
  });
  return { server, releases, toggles };
}
async function openTaskEditor(title: string, body: string) {
  await click("Редактировать");
  const dialog = page!.container.querySelector("dialog")!;
  await change(dialog.querySelector<HTMLInputElement>('input[name="title"]')!, title);
  await change(dialog.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!, body);
  return dialog;
}
const saveButton = (dialog: HTMLElement) => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const tickChecklist = () => act(async () => page!.container.querySelector<HTMLInputElement>('section[aria-label="Чеклист задачи"] input[type="checkbox"]')!.click());

it("a title and description save right after a checkmark waits for it and sends the next own revision (TR-01)", async () => {
  const { server, releases, toggles } = editableWithChecklist();
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, data) => {
    if (data.expected_revision !== server.task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    server.task = { ...server.task, revision: server.task.revision + 1, title: data.title ?? server.task.title, description: data.description ?? server.task.description };return server.task;
  });
  await mountTask(server.task);vi.mocked(tasksApi.get).mockImplementation(async () => server.task);
  await tickChecklist();
  const dialog = await openTaskEditor("Новое название", "Новое описание");
  await submit(dialog.querySelector("form")!);
  // The save waits in the card's queue behind the checkmark, which is still unanswered.
  expect(saveButton(dialog).textContent).toBe("Сохраняем…");expect(update).not.toHaveBeenCalled();
  expect(releases).toHaveLength(1);await act(async () => releases.shift()!());
  await waitForPage(page!, () => !page!.container.querySelector("dialog"));
  expect(toggles.mock.calls.map(call => call[2].expected_revision)).toEqual([8]);
  expect(update.mock.calls.map(call => call[1])).toEqual([{ expected_revision: 9, title: "Новое название", description: richText("Новое описание") }]);
  expect(server.task.revision).toBe(10);expect(page!.container.querySelector('section[aria-label="Описание задачи"] [role="alert"], section[aria-label="Чеклист задачи"] [role="alert"]')).toBeNull();
  expect(page!.container.querySelector("h1")?.textContent).toBe("Новое название");
  expect(page!.container.querySelector('section[aria-label="Описание задачи"]')?.textContent).toContain("Новое описание");
  expect(page!.container.querySelector<HTMLInputElement>('section[aria-label="Чеклист задачи"] input[type="checkbox"]')?.checked).toBe(true);
  expect(page!.container.textContent).toContain("Изменения сохранены");
});

it("a refused title save keeps the typed title and description in the open dialog (TR-01)", async () => {
  const task = makeTask({ title: "Старое название", description: richText("Старое описание"), revision: 8, capabilities: ["read_task", "edit_task"] });
  const update = vi.spyOn(tasksApi, "update").mockRejectedValue(new ApiError("Invalid input", 422, "validation_error", { title: "String should have at most 300 characters" }));
  await mountTask(task);
  const dialog = await openTaskEditor("Слишком длинное название", "Новое описание");
  await submit(dialog.querySelector("form")!);await waitForPage(page!, () => !!dialog.querySelector('[role="alert"]'));
  expect(update).toHaveBeenCalledTimes(1);expect(update).toHaveBeenCalledWith(task.task_id, { expected_revision: 8, title: "Слишком длинное название", description: richText("Новое описание") });
  expect(dialog.isConnected).toBe(true);expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Название задачи");
  expect(dialog.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("Слишком длинное название");
  expect(dialog.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value).toBe("Новое описание");
  expect(saveButton(dialog).disabled).toBe(false);expect(page!.container.querySelector("h1")?.textContent).toBe("Старое название");
});

it("someone else's change answers the queued save with 409 in the dialog, once, keeping the draft and the own checkmark (TR-01)", async () => {
  const { server, releases } = editableWithChecklist("Чужое название");
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, data) => {
    if (data.expected_revision !== server.task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    server.task = { ...server.task, revision: server.task.revision + 1 };return server.task;
  });
  await mountTask(server.task);vi.mocked(tasksApi.get).mockImplementation(async () => server.task);
  await tickChecklist();
  const dialog = await openTaskEditor("Моё название", "Моё описание");
  await submit(dialog.querySelector("form")!);
  await act(async () => releases.shift()!());
  await waitForPage(page!, () => !!dialog.querySelector('[role="alert"]'));
  expect(update.mock.calls.map(call => call[1].expected_revision)).toEqual([9]);expect(server.task.revision).toBe(10);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Запись изменилась");
  expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Обновить данные")).toBe(true);
  expect(dialog.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("Моё название");
  expect(dialog.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value).toBe("Моё описание");
  expect(page!.container.querySelector<HTMLInputElement>('section[aria-label="Чеклист задачи"] input[type="checkbox"]')?.checked).toBe(true);
  await settle();await settle();expect(update).toHaveBeenCalledTimes(1);
});

it("a planning save of type and priority right after a checkmark also waits for it (TR-01)", async () => {
  const { server, releases } = editableWithChecklist();
  server.task = { ...server.task, priority: "normal", capabilities: [...server.task.capabilities, "edit_task_metadata"] };
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, data) => {
    if (data.expected_revision !== server.task.revision) throw new ApiError("Changed", 409, "revision_conflict");
    server.task = { ...server.task, revision: server.task.revision + 1, ...("priority" in data ? { priority: data.priority } : {}) };return server.task;
  });
  await mountTask(server.task);vi.mocked(tasksApi.get).mockImplementation(async () => server.task);
  await tickChecklist();
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Изменить параметры"]')!.click());await settle();
  const dialog = page!.container.querySelector("dialog")!;
  await change(dialog.querySelector<HTMLSelectElement>('[name="priority"]')!, "urgent");await submit(dialog.querySelector("form")!);
  expect(update).not.toHaveBeenCalled();await act(async () => releases.shift()!());
  await waitForPage(page!, () => !page!.container.querySelector("dialog"));
  expect(update.mock.calls.map(call => call[1].expected_revision)).toEqual([9]);expect(server.task).toMatchObject({ revision: 10, priority: "urgent" });
});

it("a dialog save does not read the task again after its answer filled it; the rest of the workspace still rereads, and a refusal rereads the task too (TR-01 review)", async () => {
  const server = { task: makeTask({ title: "Старое название", description: richText("Старое описание"), revision: 8, capabilities: ["read_task", "edit_task"] }) };
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, data) => (server.task = { ...server.task, revision: server.task.revision + 1, title: data.title ?? server.task.title, description: data.description ?? server.task.description }));
  await mountTask(server.task);vi.mocked(tasksApi.get).mockImplementation(async () => server.task);
  const reads = () => vi.mocked(tasksApi.get).mock.calls.length, comments = () => vi.mocked(tasksApi.comments).mock.calls.length;
  const [taskReads, commentReads] = [reads(), comments()];
  let dialog = await openTaskEditor("Новое название", "Новое описание");
  await submit(dialog.querySelector("form")!);await waitForPage(page!, () => !page!.container.querySelector("dialog"));await settle();
  expect(update).toHaveBeenCalledTimes(1);expect(page!.container.querySelector("h1")?.textContent).toBe("Новое название");
  expect(reads()).toBe(taskReads);expect(comments()).toBeGreaterThan(commentReads);
  update.mockRejectedValueOnce(new ApiError("Changed", 409, "revision_conflict"));
  dialog = await openTaskEditor("Ещё название", "Ещё описание");
  await submit(dialog.querySelector("form")!);await waitForPage(page!, () => !!dialog.querySelector('[role="alert"]'));await settle();
  expect(reads()).toBe(taskReads + 1);
});

it("a refused queued mark rolls back only itself and keeps later own marks", async () => {
  let task = makeTask({ description: richText("- [ ] Первый"), revision: 8, checklist: [{ item_id: "one", text: "Пункт", checked: false }], capabilities: ["read_task", "toggle_task_checklist"] });
  const releases: (() => void)[] = [];const later = () => new Promise<void>(resolve => releases.push(resolve));
  vi.spyOn(tasksApi, "descriptionChecklist").mockImplementation(async () => { await later();throw new ApiError("Changed", 409, "revision_conflict"); });
  vi.spyOn(tasksApi, "toggleChecklist").mockImplementation(async (_id, itemId, data) => { await later();task = { ...task, revision: data.expected_revision + 1, checklist: task.checklist!.map(item => item.item_id === itemId ? { ...item, checked: data.checked } : item) };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  const description = () => page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')!;
  const checklist = () => page!.container.querySelector<HTMLInputElement>('section[aria-label="Чеклист задачи"] input[type="checkbox"]')!;
  await act(async () => description().click());await act(async () => checklist().click());
  await waitForPage(page!, () => releases.length > 0);await act(async () => releases.shift()!());await settle();
  expect(description().checked).toBe(false);expect(checklist().checked).toBe(true);
  expect(page!.container.querySelector('[role="alert"]')?.textContent).toContain("Запись изменилась");
  await waitForPage(page!, () => releases.length > 0);await act(async () => releases.shift()!());
  await waitForPage(page!, () => !page!.container.querySelector('[aria-busy="true"]'));expect(checklist().checked).toBe(true);
});

it("a rejected checklist save keeps server content, reports the conflict and does not retry a stale patch", async () => {
  const task = makeTask({ description: richText("- [ ] Проверить документы"), revision: 8, capabilities: ["read_task", "toggle_task_checklist"] });
  const update = vi.spyOn(tasksApi, "descriptionChecklist").mockRejectedValue(new ApiError("Changed", 409, "revision_conflict"));
  await mountTask(task);
  await act(async () => page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')!.click());await waitForPage(page!, () => !!page!.container.querySelector('[role="alert"]'));
  expect(update).toHaveBeenCalledTimes(1);
  expect(page!.container.querySelector('[role="alert"]')?.textContent).toContain("Запись изменилась");
  expect(page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')?.checked).toBe(false);
});

it("renders literal multiline public differences and translates status values", async () => {
  page = await mountWorkspace(<TrackerTaskHistoryDiff changes={[{ field: "description", before: "Общая строка\nСтарое условие\nПоследняя строка", after: "Общая строка\nНовое условие\nДобавлен пункт\nПоследняя строка" }, { field: "status", before: "assigned", after: "in_progress" }]} />);
  const removed = [...page.container.querySelectorAll('[data-change="removed"]')].map(node => node.textContent).join("\n");
  const added = [...page.container.querySelectorAll('[data-change="added"]')].map(node => node.textContent).join("\n");
  expect(removed).toContain("Старое условие");expect(removed).toContain("Открыта");
  expect(added).toContain("Новое условие");expect(added).toContain("Добавлен пункт");expect(added).toContain("В работе");
  expect(removed).not.toContain("Общая строка");expect(added).not.toContain("Последняя строка");
});


it("uses real queue and parent breadcrumbs while keeping the scope in task parameters", async () => {
  const task = makeTask({ queue: { queue_id: "queue-design", name: "Дизайн", key: "DSN" }, parent_task: { task_id: "parent-task", task_key: "WEB-12", title: "Подготовить запуск" } });
  await mountTask(task);
  const trail = page!.container.querySelector('[aria-label="Путь задачи"]')!;
  expect([...trail.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/tasks/queues/queue-design", "/tasks/parent-task"]);
  expect(trail.tagName).toBe("NAV");expect([...trail.querySelectorAll("a")].map(link => link.textContent)).toEqual(["Дизайн", "Подготовить запуск"]);
  expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(task.task_key);expect(trail.querySelectorAll('a,[aria-current="page"]')).toHaveLength(3);
  expect(trail.textContent).not.toContain("WEB-12");expect(trail.textContent).toContain("Дизайн");expect(trail.textContent).not.toContain("DSN");expect(trail.textContent).not.toContain(task.scope_title);
  expect(page!.container.querySelector('[aria-label="Параметры задачи"]')?.textContent).toContain(task.scope_title);
  expect(page!.container.querySelector('header button[aria-label^="Тип задачи:"]')).toBeNull();
  expect(page!.container.querySelector('header button[aria-label^="Приоритет:"]')).toBeNull();
  expect(page!.container.querySelectorAll('[aria-label="Параметры задачи"] button[aria-label^="Тип задачи:"]')).toHaveLength(1);
  expect(page!.container.querySelectorAll('[aria-label="Параметры задачи"] button[aria-label^="Приоритет:"]')).toHaveLength(1);
});

it.each([true, false])("without a parent the breadcrumb has only the queue and current key (queue supplied: %s)", async (hasQueue) => {
  const task = makeTask({ parent_task: null, queue: hasQueue ? { queue_id: "queue-design", name: "Дизайн", key: "DSN" } : undefined });
  await mountTask(task);
  const trail = page!.container.querySelector('[aria-label="Путь задачи"]')!;
  expect(trail.querySelectorAll('a,[aria-current="page"]')).toHaveLength(2);
  expect(trail.querySelector("a")?.textContent).toBe(hasQueue ? "Дизайн" : "Очереди");expect(trail.querySelector("a")?.getAttribute("href")).toBe(hasQueue ? "/tasks/queues/queue-design" : "/tasks/queues");
  expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(task.task_key);
});

it("a task whose queue the reader cannot open shows the queue as text and support tickets lead to own reports", async () => {
  await mountTask(makeTask({ queue: { queue_id: "queue-kkr", name: "Контроль заполнения ККР", key: "KKR", readable: false } }));
  const path = page!.container.querySelector('[aria-label="Путь задачи"]')!, parameters = page!.container.querySelector('[aria-label="Параметры задачи"]')!;
  expect(path.textContent).toContain("Контроль заполнения ККР");expect(path.querySelector('a[href*="queue-kkr"]')).toBeNull();expect(parameters.querySelector('a[href*="queue-kkr"]')).toBeNull();expect(parameters.textContent).toContain("Контроль заполнения ККР");
  await page!.cleanup();vi.restoreAllMocks();
  await mountTask(makeTask({ queue: { queue_id: "queue-support", name: "WEBSUPPORT", key: "WEBSUPPORT", readable: false } }));
  const supportPath = page!.container.querySelector('[aria-label="Путь задачи"]')!;
  expect(supportPath.querySelector('a[href="/support"]')?.textContent).toBe("Мои обращения");expect(page!.container.querySelector('a[href*="queue-support"]')).toBeNull();
  expect(page!.container.querySelector('[aria-label="Параметры задачи"] a[href="/support"]')).not.toBeNull();
  await page!.cleanup();vi.restoreAllMocks();
  await mountTask(makeTask({ queue: { queue_id: "queue-open", name: "Открытая", key: "OPEN", readable: true } }));
  expect(page!.container.querySelector('[aria-label="Путь задачи"] a[href="/tasks/queues/queue-open"]')).not.toBeNull();
});
it("without any clipboard the share button offers the link selected for manual copying", async () => {
  vi.stubGlobal("navigator", {});const execCommand = document.execCommand;document.execCommand = vi.fn(() => false);
  try {
    await mountTask(makeTask());
    await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Скопировать ссылку на задачу"]')!.click());await settle();
    const field = page!.container.querySelector<HTMLInputElement>("input[readonly]")!;
    expect(field.value).toBe(`${window.location.origin}/tasks/${makeTask().task_id}`);expect(document.activeElement).toBe(field);
    expect(page!.container.textContent).not.toContain("Не удалось скопировать");
  } finally { document.execCommand = execCommand;vi.unstubAllGlobals(); }
});
it("an assessment link to an open task explains that the evaluation waits for closure", async () => {
  const task = makeTask({ status: "in_progress", capabilities: ["read_task", "view_assessment_inputs"] });
  await mountTask(task, [], `?assignment_id=${task.assignments[0].assignment_id}`);
  expect(page!.container.textContent).toContain("Оценка исполнителя станет доступна после закрытия задачи.");expect(page!.container.querySelector("dialog")).toBeNull();
});
it("the description's link action opens the link editor for link managers and is absent for readers", async () => {
  await mountTask(makeTask({ capabilities: ["read_task"] }));
  expect([...page!.container.querySelectorAll("button")].some(button => button.textContent?.includes("Связь с задачей"))).toBe(false);
  await page!.cleanup();vi.restoreAllMocks();
  await mountTask(makeTask({ capabilities: ["read_task", "manage_task_links"] }));
  const action = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim().endsWith("Связь с задачей"))!;
  await act(async () => action.click());await settle();
  expect(page!.container.querySelector("dialog")?.textContent).toContain("Тип связи");
});
it("selects and clears a cross-queue parent in one combobox with revision protection", async () => {
  let task = makeTask({ capabilities: ["read_task", "edit_task"], queue: { queue_id: "queue-design", name: "Дизайн", key: "DSN" }, parent_task: null });
  const other = makeTask({ task_id: "other-task", task_key: "WEB-12", title: "Задача из другой очереди", queue: { queue_id: "queue-web", name: "Разработка", key: "WEB" } });
  const candidates = vi.spyOn(tasksApi, "listPage").mockResolvedValue({ items: [task, other, makeTask({ task_id: "wrong-season", season_id: "other-season", title: "Другой сезон" })], total: 3, next_cursor: null });
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, payload) => { task = { ...task, revision: task.revision + 1, parent_task: payload.parent_task_id ? { task_id: other.task_id, task_key: other.task_key!, title: other.title } : null };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async id => id === other.task_id ? other : task);await click("Изменить родительскую задачу");
  const dialog = page!.container.querySelector("dialog")!, input = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(dialog.querySelectorAll('[role="combobox"]')).toHaveLength(1);expect(dialog.textContent).not.toContain("Поиск родительской задачи");await act(async () => input.focus());await waitForPage(page!);
  expect(dialog.textContent).toContain(other.title);expect(dialog.textContent).not.toContain("Другой сезон");expect([...dialog.querySelectorAll('[role="option"]')]).toHaveLength(1);
  await change(input, "WEB");await waitForPage(page!, () => (candidates.mock.lastCall?.[0] as { q?: string } | undefined)?.q === "WEB");expect(candidates).toHaveBeenLastCalledWith({ season_id: task.season_id, q: "WEB", limit: 20 }, expect.any(AbortSignal));
  await act(async () => dialog.querySelector<HTMLElement>('[role="option"]')!.click());await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(update).toHaveBeenLastCalledWith(task.task_id, { expected_revision: task.revision - 1, parent_task_id: other.task_id });expect(dialog.isConnected).toBe(false);expect(page!.container.textContent).toContain("Изменения сохранены");expect(page!.container.querySelector('[aria-label="Путь задачи"]')?.textContent).toContain(other.title);
  const trail = page!.container.querySelector('[aria-label="Путь задачи"]')!;
  expect([...trail.querySelectorAll("a")].map(link => [link.textContent, link.getAttribute("href")])).toEqual([["Дизайн", "/tasks/queues/queue-design"], [other.title, "/tasks/other-task"]]);
  expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(task.task_key);
  await click("Изменить родительскую задачу");const reopened = page!.container.querySelector("dialog")!;
  await act(async () => reopened.querySelector<HTMLButtonElement>('[aria-label="Убрать родительскую задачу"]')!.click());await submit(reopened.querySelector("form")!);await waitForPage(page!);
  expect(update).toHaveBeenLastCalledWith(task.task_id, { expected_revision: task.revision - 1, parent_task_id: null });
});

it("keeps an unreadable parent masked and does not grant assignees parent editing", async () => {
  await mountTask(makeTask({ capabilities: ["read_task", "edit_task_description"], parent_task: null, parent_task_unavailable: true }));
  const related = page!.container.querySelector('[aria-label="Связанные задачи"]')!;
  expect(related.textContent).toContain("Недоступна");expect(related.textContent).not.toContain("Изменить родительскую задачу");
  expect(page!.container.querySelector('[aria-label="Путь задачи"]')?.querySelectorAll("a")).toHaveLength(1);
});

it("shows the real history actor and public field diff with status names", async () => {
  const task = makeTask();await mountTask(task);
  vi.mocked(historyApi.list).mockResolvedValue({ items: [{ id: "activity:description-change", source_kind: "activity", source_id: "description-change", target: { kind: "task", id: task.task_id }, changed_by: people[1], created_at: "2026-10-27T10:00:00Z", description: "Изменено описание", changes: [{ field: "description", label: "Описание", before: "- [ ] Условие", after: "- [x] Условие" }], reason: null, hidden: false, hidden_by: null, hidden_at: null, revision: 1, can_hide: false }], next_cursor: null });
  await click("История");await waitForPage(page!);
  const history = page!.container.querySelector("ol")!;
  expect(history.querySelector(`a[href="/contacts/${people[1].user_id}"]`)?.textContent).toContain(people[1].display_name);
  expect(history.querySelector('[data-change="removed"]')?.textContent).toContain("[ ]");expect(history.querySelector('[data-change="added"]')?.textContent).toContain("[x]");expect(history.textContent).toContain("Условие");
});


it("never renders private accounting values in the public history difference component", async () => {
  page = await mountWorkspace(<TrackerTaskHistoryDiff changes={[{ field: "hours", label: "Часы", before: "PRIVATE-OLD", after: "PRIVATE-NEW" }, { field: "evaluation", before: "PRIVATE-SCORE", after: "PRIVATE-CORRECTION" }, { field: "comment", before: "Старый комментарий", after: "Новый комментарий" }]} />);
  expect(page.container.textContent).not.toContain("PRIVATE");expect(page.container.textContent).toContain("Комментарий");expect(page.container.textContent).toContain("Новый комментарий");
});


it("uses edit_comment capability for shared comments without requiring the original author", async () => {
  const task = makeTask({ capabilities: ["read_task", "edit_task_description"] });
  const comment: Comment = { comment_id: "shared-comment", attachments: [], task_id: task.task_id, author: people[1], content: richText("Общий комментарий"), created_at: "2026-10-27T10:00:00Z", updated_at: null, capabilities: ["edit_comment"] };
  const edit = vi.spyOn(tasksApi, "editComment").mockResolvedValue({ ...comment, content: richText("Правка исполнителя") });
  await mountTask(task, [comment]);const article = page!.container.querySelector("article")!;await click("Редактировать", article);
  await change(article.querySelector<HTMLTextAreaElement>("textarea")!, "Правка исполнителя");await submit(article.querySelector("form")!);await waitForPage(page!);
  expect(edit).toHaveBeenCalledWith(comment.comment_id, richText("Правка исполнителя"), [], []);
});


it("a reader completes an open task without a submission, closure rights or accounting mutation", async () => {
  const task = makeTask({ status: "open", submissions: [], assignees: [], allowed_statuses:["open","in_progress","completed"], capabilities: ["read_task", "change_task_status"] });
  const status = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, status: "completed", revision: task.revision + 1 }), accounting = vi.spyOn(tasksApi, "updateAssessment");
  page = await mountWorkspace(<TaskStatusMenu task={task} />);await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await click("Выполнена");await waitForPage(page);
  expect(status).toHaveBeenCalledWith(task.task_id, { expected_revision: task.revision, status: "completed" });expect(accounting).not.toHaveBeenCalled();expect(page.container.querySelector("dialog")).toBeNull();
});
it("self joining and removing another assignee update the public roster and put the removed person in watchers", async () => {
  const other = people[1], self = people.find(person => person.user_id === createFixtures("chair").session.user_id)!;let task = makeTask({ assignees: [other], watchers: [], capabilities: ["read_task", "join_task", "watch_task", "remove_task_assignee"] });
  const join = vi.spyOn(tasksApi, "join").mockImplementation(async () => { task = { ...task, assignees: [other, self], revision: task.revision + 1 };return task; });
  const remove = vi.spyOn(tasksApi, "removeAssignee").mockImplementation(async () => { task = { ...task, assignees: [self], watchers: [other], revision: task.revision + 1 };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);const firstRevision = task.revision;
  await click("Стать исполнителем");await waitForPage(page!);expect(join).toHaveBeenCalledWith(task.task_id, { expected_revision: firstRevision });
  const parameters = page!.container.querySelector('[aria-label="Параметры задачи"]')!;expect(parameters.textContent).not.toContain("Стать исполнителем");
  const nextRevision = task.revision;await act(async () => parameters.querySelector<HTMLButtonElement>(`[aria-label="Убрать исполнителя: ${other.display_name}"]`)!.click());await waitForPage(page!);
  expect(remove).toHaveBeenCalledWith(task.task_id, other.user_id, { expected_revision: nextRevision });expect(task.watchers?.map(person => person.user_id)).toEqual([other.user_id]);
});
it("the assignee picker disables people without task access and explains the mention route", async () => {
  let task = makeTask({ assignees: [people[0]], watchers: [], capabilities: ["read_task", "assign_task_participants"] });
  vi.spyOn(taskCollaborationApi, "candidates").mockResolvedValue({ items: [{ ...people[1], can_assign: false }, { ...people[2], can_assign: true }], next_cursor: null });
  const assign = vi.spyOn(tasksApi, "assign").mockImplementation(async () => { task = { ...task, assignees: [people[0], people[2]], revision: task.revision + 1 };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);const first = task.revision;
  await click("Добавить исполнителя");await waitForPage(page!);
  const parameters = page!.container.querySelector('[aria-label="Параметры задачи"]')!;const input = parameters.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => input.focus());await settle();
  const locked = document.querySelector<HTMLElement>(`[data-option-value="${people[1].user_id}"]`)!, open = document.querySelector<HTMLElement>(`[data-option-value="${people[2].user_id}"]`)!;
  expect(locked.getAttribute("aria-disabled")).toBe("true");expect(open.hasAttribute("aria-disabled")).toBe(false);
  expect(open.compareDocumentPosition(locked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;expect(hint.textContent).toContain("Призовите их в комментарии");
  await act(async () => locked.click());await settle();expect(assign).not.toHaveBeenCalled();
  await act(async () => open.click());await waitForPage(page!);
  expect(assign).toHaveBeenCalledWith(task.task_id, people[2].user_id, { expected_revision: first });
});
it("readers can watch and unwatch independently of the accounting controls", async () => {
  const self = people.find(person => person.user_id === createFixtures("chair").session.user_id)!;let task = makeTask({ assignees: [], watchers: [], capabilities: ["read_task", "watch_task", "unwatch_task"] });
  task.assignments = task.assignments.map(assignment => ({ ...assignment, capabilities: [] }));
  const watch = vi.spyOn(tasksApi, "watch").mockImplementation(async () => { task = { ...task, watchers: [self], revision: task.revision + 1 };return task; });
  const unwatch = vi.spyOn(tasksApi, "unwatch").mockImplementation(async () => { task = { ...task, watchers: [], revision: task.revision + 1 };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);const first = task.revision;await click("Наблюдать");await waitForPage(page!);expect(watch).toHaveBeenCalledWith(task.task_id, { expected_revision: first });
  const second = task.revision;await click("Перестать наблюдать");await waitForPage(page!);expect(unwatch).toHaveBeenCalledWith(task.task_id, { expected_revision: second });expect(page!.container.textContent).not.toContain("Учёт работы и ККР");
});
it("planning and file dialogs close after a successful save and the card confirms it", async () => {
  const file: FileRef = { file_id: "file-brief", name: "brief.pdf", mime_type: "application/pdf", size_bytes: 12 };
  let task = makeTask({ capabilities: ["read_task", "edit_task_metadata", "attach_task_file"], priority: "normal", attachments: [file] });
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, payload) => (task = { ...task, ...("priority" in payload ? { priority: payload.priority } : {}), ...("file_ids" in payload ? { attachments: [] } : {}), revision: task.revision + 1 }));
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  const edit = page!.container.querySelector<HTMLButtonElement>('[aria-label="Параметры задачи"] details > button[aria-label="Изменить параметры"]')!;
  expect(edit.previousElementSibling?.tagName).toBe("SUMMARY");expect([...edit.nextElementSibling!.children].map(group => group.tagName)).toEqual(["SECTION", "SECTION", "SECTION"]);expect(edit.querySelector("[aria-hidden], span, svg")).not.toBeNull();
  await act(async () => edit.click());await settle();let dialog = page!.container.querySelector("dialog")!;
  await change(dialog.querySelector<HTMLSelectElement>('[name="priority"]')!, "urgent");await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(update).toHaveBeenCalledTimes(1);expect(dialog.isConnected).toBe(false);expect(page!.container.querySelector("dialog")).toBeNull();
  expect(page!.container.textContent).toContain("Изменения сохранены");
  await click("Прикрепить файлы");dialog = page!.container.querySelector("dialog")!;
  await click("Убрать", dialog);await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(update).toHaveBeenLastCalledWith(task.task_id, { expected_revision: task.revision - 1, file_ids: [] });expect(page!.container.querySelector("dialog")).toBeNull();
});
it("moves the deadline only through reasoned assessment inputs and tells other managers who moves it", async () => {
  let task = makeTask({ capabilities: ["read_task", "view_assessment_inputs", "edit_task"], deadline_at: "2026-11-10T15:00:00Z" });
  const inputs = { task_id: task.task_id, assigned_at: "2026-10-20T09:00:00Z", deadline_at: task.deadline_at, criteria: { unique: false, creative: false, external_communication: false, in_person: false, fixed_time: false }, revision: 3, capabilities: ["edit_assessment_inputs", "edit_assessment_dates"] };
  const read = vi.spyOn(tasksApi, "inputs").mockResolvedValue(inputs);
  const update = vi.spyOn(tasksApi, "updateInputs").mockImplementation(async (_id, data) => { task = { ...task, deadline_at: data.deadline_at!, revision: task.revision + 1 };return { ...inputs, deadline_at: data.deadline_at!, revision: 4 }; });
  const edit = vi.spyOn(tasksApi, "update");
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  await click("Перенести срок");const dialog = page!.container.querySelector("dialog")!, form = dialog.querySelector("form")!;
  expect(dialog.querySelector<HTMLInputElement>('[name="deadline_at"]')!.value).toBe("2026-11-10T18:00");
  expect(dialog.textContent?.replace(/\u00a0/g, " ")).toMatch(/Не раньше 20 окт\. 2026 г\., 12:00 и не позже .+ \(конец сезона\), МСК\./);
  await change(dialog.querySelector<HTMLInputElement>('[name="deadline_at"]')!, "2026-11-20T18:00");await submit(form);expect(update).not.toHaveBeenCalled();
  await change(dialog.querySelector<HTMLInputElement>('[name="reason"]')!, "Подрядчик сдвинул поставку");await submit(form);await waitForPage(page!);
  expect(update).toHaveBeenCalledWith(task.task_id, { expected_revision: 3, deadline_at: "2026-11-20T15:00:00.000Z", reason: "Подрядчик сдвинул поставку" });expect(edit).not.toHaveBeenCalled();
  expect(dialog.isConnected).toBe(false);expect(page!.container.textContent).toContain("Изменения сохранены");
  expect(page!.container.querySelector('[aria-label="Параметры задачи"] time')?.getAttribute("datetime")).toBe("2026-11-20T15:00:00.000Z");
  await page!.cleanup();read.mockResolvedValue({ ...inputs, capabilities: ["edit_assessment_inputs"] });
  await mountTask(makeTask({ capabilities: ["read_task", "view_assessment_inputs"] }));
  expect(page!.container.textContent).toContain("Срок переносят председатель, замы, мастер HR и его заместитель");expect(page!.container.textContent).not.toContain("Перенести срок");
  await page!.cleanup();read.mockClear();
  await mountTask(makeTask({ capabilities: ["read_task", "comment_task"] }));
  expect(read).not.toHaveBeenCalled();expect(page!.container.textContent).not.toContain("Срок переносят");
  // An area lead reads assessment inputs but never moves dates: no inputs request for it.
  await page!.cleanup();const lead = createFixtures("organizer").session;expect(lead.capabilities).not.toContain("view_summary");
  page = await mountWorkspace(<TaskDeadlineParameter task={makeTask({ capabilities: ["read_task", "view_assessment_inputs"] })} now={Date.now()} />, { session: lead });await waitForPage(page);
  expect(read).not.toHaveBeenCalled();expect(page.container.textContent).toContain("Срок переносят председатель");
});
it("in a closed season the deadline hint names only the chair, the deputies and the HR master (F2-01, SE-13)", async () => {
  // The HR deputy reads the inputs of a closed season's task but moves no dates there.
  const hr = createFixtures("hr-deputy"), task = makeTask({ season_id: "season-previous", capabilities: ["read_task", "view_assessment_inputs"] });
  const seasons = hr.seasons.map(season => season.season_id === "season-previous" ? { ...season, state: "closed" as const } : season);
  vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: seasons, next_cursor: null });vi.spyOn(tasksApi, "get").mockResolvedValue(task);
  vi.spyOn(tasksApi, "comments").mockResolvedValue({ items: [], next_cursor: null });vi.spyOn(historyApi, "list").mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(tasksApi, "inputs").mockResolvedValue({ task_id: task.task_id, assigned_at: "2026-07-01T09:00:00Z", deadline_at: task.deadline_at, criteria: { unique: false, creative: false, external_communication: false, in_person: false, fixed_time: false }, revision: 2, capabilities: [] });
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session: hr.session });await waitForPage(page);
  const text = page.container.textContent!;
  expect(text).toContain("Срок закрытого сезона переносят председатель, замы и мастер HR");expect(text).not.toContain("его заместитель");expect(text).not.toContain("Перенести срок");
});
it.each([
  ["?return_season=season-1&return_to=participant&participant=participant-4", "← К участнику", "/seasons/season-1?participant=participant-4"],
  ["?return_season=season-1&return_to=checks", "← К проверкам сезона", "/seasons/season-1?panel=checks"],
  ["?return_season=season-1&return_to=%2F%2Fevil.example", "← К сезону", "/seasons/season-1"],
])("names the season place a task returns to (%s)", async (search, label, href) => {
  await mountTask(makeTask({ capabilities: ["read_task"] }), [], search);
  const back = [...page!.container.querySelectorAll("a")].find(node => node.textContent?.startsWith("← К"));
  expect(back?.textContent).toBe(label);expect(back?.getAttribute("href")).toBe(href);
});

// D-03 (owner 2026-11-01): the parameters form three titled groups; a phone keeps a summary above them.
const parameterGroups = () => [...page!.container.querySelectorAll<HTMLElement>('[aria-label="Параметры задачи"] details section')];
const taskSummary = () => page!.container.querySelector<HTMLElement>('[aria-label="Параметры задачи"] [role="group"][aria-label="Кратко о задаче"]');
const phone = () => vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
it("groups the parameters under status and dates, place and people, each label beside its value (D-03)", async () => {
  await mountTask(makeTask({ capabilities: ["read_task", "change_task_status", "change_task_type", "change_task_priority"] }));
  const groups = parameterGroups();
  expect(groups.map(group => group.querySelector("h3")?.textContent)).toEqual(["Статус и сроки", "Где", "Люди"]);
  expect(groups.every(group => group.getAttribute("aria-labelledby") === group.querySelector("h3")?.id)).toBe(true);
  expect(groups.map(group => [...group.querySelectorAll("dt")].map(label => label.textContent))).toEqual([["Начало, МСК", "Дедлайн, МСК"], ["Очередь", "Команда", "Сезон"], ["Автор", "Исполнители", "Наблюдатели"]]);
  // Status, type and priority are one row of chips above the dates, outside the label grid.
  const chips = groups[0].querySelector('[role="group"][aria-label="Статус, тип и приоритет"]')!;
  expect([...chips.querySelectorAll("button")].map(button => button.getAttribute("aria-label")?.split(":")[0])).toEqual(["Статус задачи", "Тип задачи", "Приоритет"]);
  expect(chips.closest("dl")).toBeNull();expect(chips.nextElementSibling?.tagName).toBe("DL");
  expect(page!.container.textContent).not.toContain("Плановое начало");
  // A wide screen opens the panel and has no summary: the status chip is not rendered twice.
  expect(page!.container.querySelector<HTMLDetailsElement>('[aria-label="Параметры задачи"] details')!.open).toBe(true);
  expect(taskSummary()).toBeNull();expect(page!.container.querySelectorAll('[aria-label^="Статус задачи:"]')).toHaveLength(1);
  await page!.cleanup();vi.restoreAllMocks();
  await mountTask(makeTask({ task_type: "milestone", scope: { kind: "queue", id: "queue-design" } }));
  expect(parameterGroups().map(group => [...group.querySelectorAll("dt")].map(label => label.textContent))).toEqual([["Дедлайн, МСК"], ["Очередь", "Сезон"], ["Автор", "Исполнители", "Наблюдатели"]]);
});
it("people actions stand in one row under the people group and follow the reader's rights (D-03)", async () => {
  const self = people.find(person => person.user_id === createFixtures("chair").session.user_id)!;
  vi.spyOn(taskCollaborationApi, "candidates").mockResolvedValue({ items: [], next_cursor: null });
  await mountTask(makeTask({ assignees: [people[1]], watchers: [], capabilities: ["read_task", "join_task", "assign_task_participants", "watch_task"] }));
  let group = parameterGroups()[2];
  const row = group.querySelector<HTMLElement>('[role="group"][aria-label="Действия с людьми задачи"]')!;
  expect([...row.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Стать исполнителем", "Добавить исполнителя", "Наблюдать"]);
  expect(row.previousElementSibling?.tagName).toBe("DL");expect([...group.querySelectorAll("dd button")].some(button => /исполнител|Наблюдать/.test(button.textContent ?? ""))).toBe(false);
  const add = [...row.querySelectorAll("button")].find(button => button.textContent === "Добавить исполнителя")!;expect(add.getAttribute("aria-expanded")).toBe("false");
  await act(async () => add.click());await waitForPage(page!);
  const picker = group.querySelector('[role="combobox"]')!;expect(add.getAttribute("aria-expanded")).toBe("true");expect(row.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await page!.cleanup();vi.restoreAllMocks();
  // An assignee without people rights gets no empty action row.
  await mountTask(makeTask({ assignees: [self], watchers: [], capabilities: ["read_task", "join_task", "watch_task"] }));
  group = parameterGroups()[2];
  expect(group.querySelector('[role="group"]')).toBeNull();expect([...group.querySelectorAll("button")].some(button => /исполнител|Наблюдать/.test(button.textContent ?? ""))).toBe(false);
  await page!.cleanup();vi.restoreAllMocks();
  await mountTask(makeTask({ assignees: [], watchers: [self], capabilities: ["read_task", "unwatch_task", "watch_task"] }));
  expect([...parameterGroups()[2].querySelectorAll('[aria-label="Действия с людьми задачи"] button')].map(button => button.textContent)).toEqual(["Перестать наблюдать"]);
});
it("on a phone the folded parameters keep the status, the deadline and three assignees in sight (D-03)", async () => {
  phone();
  try {
    await mountTask(makeTask({ status: "open", deadline_at: "2026-01-10T09:00:00Z", assignees: people, capabilities: ["read_task", "change_task_status"] }));
    const details = page!.container.querySelector<HTMLDetailsElement>('[aria-label="Параметры задачи"] details')!, summary = taskSummary()!;
    expect(details.open).toBe(false);expect(summary.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.querySelector('button[aria-label^="Статус задачи:"]')).not.toBeNull();
    // The same deadline value as the parameter, overdue colour included.
    const time = summary.querySelector("time")!;expect(summary.textContent).toContain("Дедлайн");expect(time.getAttribute("datetime")).toBe("2026-01-10T09:00:00Z");
    expect(time.className).toMatch(/overdue/);expect(time.className).toBe(details.querySelector("time")!.className);
    const names = people.map(person => person.display_name);
    expect(names.filter(name => summary.textContent!.includes(name))).toEqual(names.slice(0, 3));
    const more = [...summary.querySelectorAll("button")].find(button => button.textContent === "+2")!;expect(more.getAttribute("aria-label")).toBe("+2: все исполнители в параметрах");
    await act(async () => more.click());await settle();
    expect(details.open).toBe(true);expect(taskSummary()).toBeNull();expect(document.activeElement).toBe(details.querySelector("summary"));
    for (const name of names) expect(details.textContent).toContain(name);
    await act(async () => { details.open = false;details.dispatchEvent(new Event("toggle")); });await settle();
    expect(taskSummary()).not.toBeNull();
    await page!.cleanup();vi.restoreAllMocks();
    await mountTask(makeTask({ deadline_at: null, assignees: [] }));
    expect(taskSummary()!.textContent).toContain("Не задан");expect(taskSummary()!.textContent).toContain("Исполнители не назначены");expect(taskSummary()!.querySelector("button[aria-label*='все исполнители']")).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
it("keeps the D-03 widths: a 344 px column, labels above values beside the navigation, the summary on a phone only", () => {
  const css = readFileSync(`${__dirname}/TrackerTaskDetail.module.css`, "utf8");
  const media = (query: string) => {
    const start = css.indexOf(`@media(${query})`);expect(start, query).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);let depth = 0;
    for (let at = open; at < css.length; at++) { if (css[at] === "{") depth++;if (css[at] === "}" && --depth === 0) return css.slice(open + 1, at); }
    return "";
  };
  expect(css).toMatch(/\.workspace \{[^}]*grid-template-columns: minmax\(0, 1fr\) 344px/);
  expect(css).toMatch(/\.parameters dl > div \{[^}]*grid-template-columns: 96px minmax\(0, 1fr\)/);
  expect(css).toMatch(/(^|\n)\.summary \{ display: none; \}/);
  // 901-1100 px: the old 235 px column, so each label stands above its value.
  expect(media("max-width: 1100px")).toMatch(/grid-template-columns: minmax\(0, 1fr\) 235px/);
  expect(media("min-width: 901px) and (max-width: 1100px")).toMatch(/\.parameters dl > div \{ grid-template-columns: minmax\(0, 1fr\)/);
  const phoneRules = media("max-width: 900px");
  expect(phoneRules).toMatch(/\.summary \{ display: flex/);expect(phoneRules).not.toMatch(/repeat\(2/);
  // Without hover the subevent season hint stays on the card instead of the tooltip.
  expect(media("hover: none),(pointer: coarse")).toMatch(/\.seasonHint \{ position: static/);
});
