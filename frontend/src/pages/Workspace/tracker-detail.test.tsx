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
import { TrackerTaskHistoryDiff } from "./TrackerTaskHistoryDiff";
import { ApiError } from "../../utils/api/request";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const makeTask = (extra: Partial<Task> = {}): Task => ({ ...createFixtures("chair").tasks[0], status: "in_progress", task_key: "TASK-123", created_at: "2026-10-26T09:00:00Z", updated_at: "2026-10-26T10:00:00Z", created_by: people[0], scope_title: "Команда проверки", attachments: [], submissions: [], capabilities: ["read_task", "comment_task", "change_task_status", "submit_task_result"], ...extra });
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
it("uses the common public status and permits every other target without reading the accounting outcome", () => {
  const task = makeTask({ status: "submitted", capabilities: ["change_task_status"] });task.assignments[0].status = "cancelled";
  expect(taskStatus(task)).toBe("submitted");expect(taskTransitions(task)).toHaveLength(7);expect(taskTransitions(task)).not.toContain("submitted");expect(taskTransitions(task)).toContain("assigned");
  expect(taskTransitions({ ...task, status: "accepted" })).toContain("assigned");expect(taskTransitions({ ...task, capabilities: [] })).toEqual([]);
});
it("a status chip owns its click and starts the whole task with the task revision", async () => {
  const task = makeTask({ status: "assigned", revision: 5, capabilities: ["change_task_status"] });
  const command = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, revision: 6, status: "in_progress" });
  const openRow = vi.fn();page = await mountWorkspace(<div onClick={openRow}><TaskStatusMenu task={task} /></div>);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Статус задачи: Открыта"]')!.click());await settle();
  expect(openRow).not.toHaveBeenCalled();
  const options = [...page.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(options.find(button => button.textContent?.includes("Принята"))?.disabled).toBe(false);expect(options.find(button => button.textContent?.includes("Открыта"))?.disabled).toBe(true);
  await act(async () => options.find(button => button.textContent?.trim() === "В работе")!.click());await waitForPage(page);
  expect(command).toHaveBeenCalledWith(task.task_id, { expected_revision: 5, status: "in_progress" });expect(openRow).not.toHaveBeenCalled();
});
it("status menu supports arrow keys, Home/End and restores focus on Escape", async () => {
  const task = makeTask({ status: "assigned", capabilities: ["change_task_status", "submit_task_result"] });
  page = await mountWorkspace(<TaskStatusMenu task={task} />);
  const trigger = page.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());await settle();
  expect(document.activeElement?.textContent?.trim()).toBe("В работе");
  const press = async (key: string) => { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); };
  await press("ArrowDown");expect(document.activeElement?.textContent?.trim()).toBe("Нужна помощь");
  await press("End");expect(document.activeElement?.textContent?.trim()).toBe("Отменена");
  await press("Home");expect(document.activeElement?.textContent?.trim()).toBe("В работе");
  await press("Escape");expect(page.container.querySelector('[role="menu"]')).toBeNull();expect(document.activeElement).toBe(trigger);
});
it("one shared file-only result targets the task rather than an individual assignment", async () => {
  const task = makeTask();const file: FileRef = { file_id: "shared-file", name: "result.txt", mime_type: "text/plain", size_bytes: 10 };
  const upload = vi.spyOn(filesApi, "upload").mockResolvedValue(file);
  const command = vi.spyOn(tasksApi, "submitResult").mockResolvedValue({ ...task, status: "submitted", revision: task.revision + 1 });
  page = await mountWorkspace(<TaskStatusMenu task={task} variant="actions" />);await click("Сдать результат");
  const input = page.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const blob = new File(["shared result"], "result.txt", { type: "text/plain" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [blob] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page);
  expect(upload).toHaveBeenCalledWith(blob, { owner_kind: "task", owner_id: task.task_id, purpose: "submission" }, expect.any(Function));
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(command).toHaveBeenCalledWith(task.task_id, expect.objectContaining({ text: richText(""), file_ids: [file.file_id] }));
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


it("current assignees can edit description without receiving title controls or sending a title patch", async () => {
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
  let task = makeTask({ description: richText("- [ ] Проверить документы\n- [x] Готовый пункт"), revision: 8, capabilities: ["read_task", "edit_task_description"] });
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, data) => { task = { ...task, revision: 9, description: data.description! };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);
  const check = page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')!;
  expect(check.disabled).toBe(false);
  await act(async () => check.click());await waitForPage(page!, () => page!.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')?.checked === true);
  expect(update).toHaveBeenCalledWith(task.task_id, { expected_revision: 8, description: richText("- [x] Проверить документы\n- [x] Готовый пункт") });
  await click("История");await waitForPage(page!);expect(tasksApi.history).toHaveBeenCalledWith(task.task_id);
});

it("a rejected checklist save keeps server content, reports the conflict and does not retry a stale patch", async () => {
  const task = makeTask({ description: richText("- [ ] Проверить документы"), revision: 8, capabilities: ["read_task", "edit_task_description"] });
  const update = vi.spyOn(tasksApi, "update").mockRejectedValue(new ApiError("Changed", 409, "revision_conflict"));
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
  expect(trail.textContent).toContain("Дизайн");expect(trail.textContent).not.toContain(task.scope_title);
  expect(page!.container.querySelector('[aria-label="Параметры задачи"]')?.textContent).toContain(task.scope_title);
});

it("selects and clears a cross-queue parent in one combobox with revision protection", async () => {
  let task = makeTask({ capabilities: ["read_task", "edit_task"], queue: { queue_id: "queue-design", name: "Дизайн", key: "DSN" }, parent_task: null });
  const other = makeTask({ task_id: "other-task", title: "Задача из другой очереди", queue: { queue_id: "queue-web", name: "Разработка", key: "WEB" } });
  const candidates = vi.spyOn(tasksApi, "listPage").mockResolvedValue({ items: [task, other, makeTask({ task_id: "wrong-season", season_id: "other-season", title: "Другой сезон" })], total: 3, next_cursor: null });
  const update = vi.spyOn(tasksApi, "update").mockImplementation(async (_id, payload) => { task = { ...task, revision: task.revision + 1, parent_task: payload.parent_task_id ? { task_id: other.task_id, task_key: other.task_key!, title: other.title } : null };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async id => id === other.task_id ? other : task);await click("Изменить родительскую задачу");
  const dialog = page!.container.querySelector("dialog")!, input = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(dialog.querySelectorAll('[role="combobox"]')).toHaveLength(1);expect(dialog.textContent).not.toContain("Поиск родительской задачи");await act(async () => input.focus());await waitForPage(page!);
  expect(dialog.textContent).toContain(other.title);expect(dialog.textContent).not.toContain("Другой сезон");expect([...dialog.querySelectorAll('[role="option"]')]).toHaveLength(1);
  await change(input, "WEB");await waitForPage(page!);expect(candidates).toHaveBeenLastCalledWith({ season_id: task.season_id, q: "WEB", limit: 100 });
  await act(async () => dialog.querySelector<HTMLElement>('[role="option"]')!.click());await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(update).toHaveBeenLastCalledWith(task.task_id, { expected_revision: task.revision - 1, parent_task_id: other.task_id });expect(page!.container.querySelector('[aria-label="Путь задачи"]')?.textContent).toContain(other.title);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Убрать родительскую задачу"]')!.click());await submit(dialog.querySelector("form")!);await waitForPage(page!);
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
  vi.mocked(tasksApi.history).mockResolvedValue({ items: [{ event_id: "description-change", kind: "task.updated", actor: people[1], created_at: "2026-10-27T10:00:00Z", description: "Изменено описание", changes: [{ field: "description", before: "- [ ] Условие", after: "- [x] Условие" }] }], next_cursor: null });
  await click("История");await waitForPage(page!);
  const history = page!.container.querySelector("ol")!;
  expect(history.querySelector(`a[href="/contacts/${people[1].user_id}"]`)?.textContent).toContain(people[1].display_name);
  expect(history.querySelector('[data-change="removed"]')?.textContent).toContain("- [ ] Условие");expect(history.querySelector('[data-change="added"]')?.textContent).toContain("- [x] Условие");
});


it("never renders private accounting values in the public history difference component", async () => {
  page = await mountWorkspace(<TrackerTaskHistoryDiff changes={[{ field: "hours", label: "Часы", before: "PRIVATE-OLD", after: "PRIVATE-NEW" }, { field: "evaluation", before: "PRIVATE-SCORE", after: "PRIVATE-CORRECTION" }, { field: "comment", before: "Старый комментарий", after: "Новый комментарий" }]} />);
  expect(page.container.textContent).not.toContain("PRIVATE");expect(page.container.textContent).toContain("Комментарий");expect(page.container.textContent).toContain("Новый комментарий");
});


it("uses edit_comment capability for shared comments without requiring the original author", async () => {
  const task = makeTask({ capabilities: ["read_task", "edit_task_description"] });
  const comment: Comment = { comment_id: "shared-comment", task_id: task.task_id, author: people[1], content: richText("Общий комментарий"), created_at: "2026-10-27T10:00:00Z", updated_at: null, capabilities: ["edit_comment"] };
  const edit = vi.spyOn(tasksApi, "editComment").mockResolvedValue({ ...comment, content: richText("Правка исполнителя") });
  await mountTask(task, [comment]);const article = page!.container.querySelector("article")!;await click("Редактировать", article);
  await change(article.querySelector<HTMLTextAreaElement>("textarea")!, "Правка исполнителя");await submit(article.querySelector("form")!);await waitForPage(page!);
  expect(edit).toHaveBeenCalledWith(comment.comment_id, richText("Правка исполнителя"));
});


it("a reader can accept an open task without a submission or accounting mutation", async () => {
  const task = makeTask({ status: "assigned", submissions: [], assignees: [], capabilities: ["read_task", "change_task_status"] });
  const status = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, status: "accepted", revision: task.revision + 1 }), accounting = vi.spyOn(tasksApi, "updateAssessment");
  page = await mountWorkspace(<TaskStatusMenu task={task} />);await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await click("Принята");await waitForPage(page);
  expect(status).toHaveBeenCalledWith(task.task_id, { expected_revision: task.revision, status: "accepted" });expect(accounting).not.toHaveBeenCalled();expect(page.container.querySelector("dialog")).toBeNull();
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
it("readers can watch and unwatch independently of the accounting controls", async () => {
  const self = people.find(person => person.user_id === createFixtures("chair").session.user_id)!;let task = makeTask({ assignees: [], watchers: [], capabilities: ["read_task", "watch_task", "unwatch_task"] });
  task.assignments = task.assignments.map(assignment => ({ ...assignment, capabilities: [] }));
  const watch = vi.spyOn(tasksApi, "watch").mockImplementation(async () => { task = { ...task, watchers: [self], revision: task.revision + 1 };return task; });
  const unwatch = vi.spyOn(tasksApi, "unwatch").mockImplementation(async () => { task = { ...task, watchers: [], revision: task.revision + 1 };return task; });
  await mountTask(task);vi.mocked(tasksApi.get).mockImplementation(async () => task);const first = task.revision;await click("Наблюдать");await waitForPage(page!);expect(watch).toHaveBeenCalledWith(task.task_id, { expected_revision: first });
  const second = task.revision;await click("Перестать наблюдать");await waitForPage(page!);expect(unwatch).toHaveBeenCalledWith(task.task_id, { expected_revision: second });expect(page!.container.textContent).not.toContain("Учёт работы и ККР");
});
