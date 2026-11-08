// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures, people } from "../../mocks/fixtures";
import { commentAction, mountWorkspace, settle, waitForPage } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { historyApi } from "../../utils/api/history.api";
import { ApiError } from "../../utils/api/request";
import { richText, type Comment, type Task } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const BODY = "😀 План\n- [ ] Купить бумагу\n- [x] Позвонить";
const file = { file_id: "file-comment", name: "смета.pdf", mime_type: "application/pdf", size_bytes: 10 };
const task: Task = { ...createFixtures("chair").tasks[0], status: "in_progress", capabilities: ["read_task", "comment_task"], attachments: [], submissions: [] };
const makeComment = (extra: Partial<Comment> = {}): Comment => ({ comment_id: "comment-marks", attachments: [], task_id: task.task_id, author: people[1], content: richText(BODY), created_at: "2026-11-08T10:00:00Z", updated_at: null, capabilities: ["edit_comment", "toggle_comment_checklist", "delete_comment"], ...extra });
async function mount(comments: Comment[]) {
  vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: createFixtures("chair").seasons, next_cursor: null });
  vi.spyOn(tasksApi, "get").mockResolvedValue(task);
  const read = vi.spyOn(tasksApi, "comments").mockResolvedValue({ items: comments, next_cursor: null });
  vi.spyOn(historyApi, "list").mockResolvedValue({ items: [], next_cursor: null });
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}` });
  await waitForPage(page, () => !!page!.container.querySelector("article"));
  return read;
}
const article = () => page!.container.querySelector<HTMLElement>("article")!;
const boxes = () => [...article().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text);

it("a reader ticks a comment mark against the body seen, by its string offset, without an edit", async () => {
  const comment = makeComment(), saved = { ...comment, content: richText(BODY.replace("[ ] Купить", "[x] Купить")) };
  let answer!: (value: Comment) => void;
  const mark = vi.spyOn(tasksApi, "commentChecklist").mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const edit = vi.spyOn(tasksApi, "editComment");
  await mount([comment]);
  expect(boxes().map(box => [box.checked, box.disabled])).toEqual([[false, false], [true, false]]);
  await act(async () => boxes()[0].click());await settle();
  // One mark at a time in a comment: the others wait for the answer.
  expect(boxes().every(box => box.disabled)).toBe(true);expect(article().textContent).toContain("Сохраняем отметку…");
  await act(async () => answer(saved));await waitForPage(page!);
  expect(mark).toHaveBeenCalledTimes(1);
  expect(mark).toHaveBeenCalledWith(comment.comment_id, { expected_body: BODY, offset: BODY.indexOf("[ ] Купить") + 1, checked: true });
  expect(boxes().map(box => [box.checked, box.disabled])).toEqual([[true, false], [true, false]]);
  expect(edit).not.toHaveBeenCalled();expect(article().textContent).not.toContain("изменён");expect(article().textContent).not.toContain("Сохраняем отметку…");
});

it("a refused mark explains itself in Russian and rereads the comments", async () => {
  vi.spyOn(tasksApi, "commentChecklist").mockRejectedValue(new ApiError("Comment changed since it was read", 409, "comment_changed"));
  const read = await mount([makeComment()]), reads = read.mock.calls.length;
  await act(async () => boxes()[0].click());await waitForPage(page!);
  expect(article().querySelector('[role="alert"]')?.textContent).toBe("Комментарий изменился, пока вы ставили отметку. Проверьте пункт и отметьте его снова.");
  expect(read.mock.calls.length).toBeGreaterThan(reads);
});

it("marks stay read-only without the capability and in the editor preview", async () => {
  await mount([makeComment({ capabilities: ["edit_comment"] })]);
  expect(boxes().every(box => box.disabled)).toBe(true);
  await commentAction(article(), "Редактировать");
  expect(button(article(), "Отменить редактирование")).toBeDefined();expect(article().querySelector('header [aria-haspopup="menu"]')).toBeNull();
  await act(async () => article().querySelector<HTMLButtonElement>('[aria-label="Предпросмотр"]')!.click());await waitForPage(page!, () => boxes().length > 0);
  expect(boxes().every(box => box.disabled)).toBe(true);
});

it("the «⋯» menu offers the comment's own commands and is keyboard operable", async () => {
  await mount([makeComment({ comment_id: "own" }), makeComment({ comment_id: "foreign", created_at: "2026-11-08T09:00:00Z", capabilities: [] })]);
  const [own, foreign] = [...page!.container.querySelectorAll("article")];
  expect(foreign.querySelector('[aria-haspopup="menu"]')).toBeNull();expect(button(foreign, "Редактировать")).toBeUndefined();
  const trigger = own.querySelector<HTMLButtonElement>('header [aria-haspopup="menu"]')!;
  expect(trigger.getAttribute("aria-label")).toBe("Действия с комментарием");expect(button(own, "Редактировать")).toBeUndefined();
  await act(async () => { trigger.focus();trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });await settle();
  const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["Редактировать", "Удалить"]);
  expect(document.activeElement?.textContent).toBe("Редактировать");
  await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));await settle();
  expect(document.querySelector('[role="menu"]')).toBeNull();expect(document.activeElement).toBe(trigger);
});

it("deleting asks once more, can be withdrawn, and leaves no placeholder or comment files", async () => {
  const comment = makeComment({ content: richText("С файлом"), attachments: [file] });
  const remove = vi.spyOn(tasksApi, "deleteComment").mockResolvedValue(undefined);
  await mount([comment]);
  await commentAction(article(), "Удалить");
  const question = article().querySelector('[role="alert"]')!;
  expect(question.textContent).toContain("Удалить комментарий? Удаление будет видно в истории задачи.");
  expect(document.activeElement).toBe(button(question, "Удалить"));
  await act(async () => button(question, "Отмена")!.click());await settle();
  expect(article().querySelector('[role="alert"]')).toBeNull();expect(remove).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(article().querySelector('header [aria-haspopup="menu"]'));
  await commentAction(article(), "Удалить");
  await act(async () => button(article().querySelector('[role="alert"]')!, "Удалить")!.click());await waitForPage(page!);
  expect(remove).toHaveBeenCalledWith(comment.comment_id);
  expect(page!.container.querySelector("article")).toBeNull();
  expect(page!.container.textContent).toContain("Пока нет комментариев.");
  await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === "Вложения")!.click());await waitForPage(page!);
  expect(page!.container.querySelector('[aria-label="Файлы из комментариев"]')?.textContent).toContain("В комментариях пока нет файлов.");
});

it("a refused deletion keeps the comment and says why", async () => {
  vi.spyOn(tasksApi, "deleteComment").mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));
  await mount([makeComment()]);
  await commentAction(article(), "Удалить");
  await act(async () => button(article().querySelector('[role="alert"]')!, "Удалить")!.click());await waitForPage(page!);
  expect([...article().querySelectorAll('[role="alert"]')].map(item => item.textContent)).toContain("Нет доступа к этому действию. Возможно, роль снята.");
  expect(button(article(), "Удалить")?.disabled).toBe(false);
});
