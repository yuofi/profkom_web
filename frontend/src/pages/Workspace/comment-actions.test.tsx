// @vitest-environment jsdom
import { readFileSync } from "node:fs";
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
const trigger = (root: ParentNode = article()) => root.querySelector<HTMLButtonElement>('header [aria-haspopup="menu"]');
const question = (root: ParentNode = article()) => root.querySelector<HTMLElement>('header [role="group"]');
const tab = (name: string) => [...page!.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === name)!;
const comment = (id: string) => page!.container.querySelector<HTMLElement>(`#task-comment-${id}`)!;
const press = (key: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

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

it("the «⋯» menu offers the comment's own commands with their icons and is keyboard operable", async () => {
  await mount([makeComment({ comment_id: "own" }), makeComment({ comment_id: "foreign", created_at: "2026-11-08T09:00:00Z", capabilities: [] })]);
  const [own, foreign] = [...page!.container.querySelectorAll("article")];
  expect(foreign.querySelector('[aria-haspopup="menu"]')).toBeNull();expect(button(foreign, "Редактировать")).toBeUndefined();
  const opener = trigger(own)!;
  expect(opener.getAttribute("aria-label")).toBe("Действия с комментарием");expect(button(own, "Редактировать")).toBeUndefined();
  await act(async () => { opener.focus();opener.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });await settle();
  const menu = document.getElementById(opener.getAttribute("aria-controls")!)!, items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map(item => item.textContent)).toEqual(["Редактировать", "Удалить"]);
  // Owner 2026-11-08, В5, variant Б: a pencil and a trash can before the words, out of the accessible name;
  // only «Удалить» takes the danger colour.
  expect(items.map(item => item.querySelector('[data-icon][aria-hidden="true"]')?.getAttribute("data-icon"))).toEqual(["edit", "delete"]);
  expect(items.map(item => /commentMenuDanger/.test(item.className))).toEqual([false, true]);
  expect(document.activeElement?.textContent).toBe("Редактировать");
  await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));await settle();
  expect(document.querySelector('[role="menu"]')).toBeNull();expect(document.activeElement).toBe(opener);
});

it("deleting asks once more in the comment's header, can be withdrawn, and leaves no placeholder or comment files", async () => {
  const withFile = makeComment({ content: richText("С файлом\n- [ ] Пункт"), attachments: [file] });
  const remove = vi.spyOn(tasksApi, "deleteComment").mockResolvedValue(undefined);
  await mount([withFile]);
  await commentAction(article(), "Удалить");
  // The short question takes the place of «⋯»; the comment fades and its marks wait meanwhile.
  const asked = question()!;
  expect(document.getElementById(asked.getAttribute("aria-labelledby")!)?.textContent).toBe("Удалить комментарий?");
  expect([...asked.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Удалить", "Отмена"]);
  expect(/confirmDelete/.test(button(asked, "Удалить")!.className)).toBe(true);
  expect(trigger()).toBeNull();expect(article().dataset.confirming).toBe("true");expect(article().querySelector('[role="alert"]')).toBeNull();
  expect(boxes().every(box => box.disabled)).toBe(true);
  expect(document.activeElement).toBe(button(asked, "Удалить"));
  // «Отмена» and Escape withdraw it and give the focus back to «⋯».
  await act(async () => button(asked, "Отмена")!.click());await settle();
  expect(question()).toBeNull();expect(article().dataset.confirming).toBeUndefined();expect(boxes().some(box => box.disabled)).toBe(false);
  expect(document.activeElement).toBe(trigger());
  await commentAction(article(), "Удалить");
  await press("Escape");await settle();
  expect(question()).toBeNull();expect(document.activeElement).toBe(trigger());expect(remove).not.toHaveBeenCalled();
  await commentAction(article(), "Удалить");
  await act(async () => button(question()!, "Удалить")!.click());await waitForPage(page!);
  expect(remove).toHaveBeenCalledWith(withFile.comment_id);
  expect(page!.container.querySelector("article")).toBeNull();
  expect(page!.container.textContent).toContain("Пока нет комментариев.");
  // The last comment gone, the focus stays with the discussion: on its tab.
  expect(document.activeElement).toBe(tab("Комментарии"));
  await act(async () => tab("Вложения").click());await waitForPage(page!);
  expect(page!.container.querySelector('[aria-label="Файлы из комментариев"]')?.textContent).toContain("В комментариях пока нет файлов.");
});

it("a deleted comment hands the focus to its neighbour, unless the focus has already left it", async () => {
  let answer: () => void = () => {};
  const remove = vi.spyOn(tasksApi, "deleteComment").mockResolvedValue(undefined);
  // Newest first: a, b, plain (no commands of its own), d, e.
  await mount(["e", "d", "plain", "b", "a"].map((id, index) => makeComment({ comment_id: id, created_at: `2026-11-08T0${index + 1}:00:00Z`, ...(id === "plain" ? { capabilities: [] } : {}) })));
  const confirmDeletion = async (id: string) => { await commentAction(comment(id), "Удалить");await act(async () => button(question(comment(id))!, "Удалить")!.click());await waitForPage(page!); };
  // The comment below takes the focus on its «⋯», or on itself without one.
  await confirmDeletion("a");
  expect(document.activeElement).toBe(trigger(comment("b")));
  await confirmDeletion("b");
  expect(document.activeElement).toBe(comment("plain"));expect(comment("plain").tabIndex).toBe(-1);
  // The last comment of the list hands it to the one above.
  await confirmDeletion("e");
  expect(document.activeElement).toBe(trigger(comment("d")));
  // A focus moved elsewhere while the answer was awaited stays there.
  remove.mockImplementation(() => new Promise<void>(resolve => { answer = resolve; }));
  await commentAction(comment("d"), "Удалить");
  await act(async () => button(question(comment("d"))!, "Удалить")!.click());
  await act(async () => tab("История").focus());
  await act(async () => answer());await waitForPage(page!);
  expect(page!.container.querySelector("#task-comment-d")).toBeNull();expect(document.activeElement).toBe(tab("История"));
});

it("while a deletion is sent its buttons keep the focus and a second press sends nothing", async () => {
  let answer: () => void = () => {};
  const remove = vi.spyOn(tasksApi, "deleteComment").mockImplementation(() => new Promise<void>(resolve => { answer = resolve; }));
  await mount([makeComment()]);
  await commentAction(article(), "Удалить");
  const confirm = button(question()!, "Удалить")!;
  await act(async () => confirm.click());
  expect(confirm.textContent).toBe("Удаляем…");expect(confirm.disabled).toBe(false);
  expect(confirm.getAttribute("aria-disabled")).toBe("true");expect(confirm.getAttribute("aria-busy")).toBe("true");expect(document.activeElement).toBe(confirm);
  await act(async () => { confirm.click();button(question()!, "Отмена")!.click(); });await press("Escape");
  expect(remove).toHaveBeenCalledTimes(1);expect(question()).not.toBeNull();
  await act(async () => answer());await waitForPage(page!);
  expect(page!.container.querySelector("article")).toBeNull();
});

it("a refused deletion keeps the comment and its question, says why and keeps the focus on «Удалить»", async () => {
  vi.spyOn(tasksApi, "deleteComment").mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));
  await mount([makeComment()]);
  await commentAction(article(), "Удалить");
  const confirm = button(question()!, "Удалить")!;
  await act(async () => confirm.click());await waitForPage(page!);
  expect([...article().querySelectorAll('[role="alert"]')].map(item => item.textContent)).toContain("Нет доступа к этому действию. Возможно, роль снята.");
  expect(question()).not.toBeNull();expect(document.activeElement).toBe(confirm);
  expect(confirm.textContent).toBe("Удалить");expect(confirm.getAttribute("aria-disabled")).toBeNull();
});

it("the question stands in the header instead of a framed box and wraps under the author on a short line", () => {
  const css = readFileSync(`${__dirname}/TrackerTaskDetail.module.css`, "utf8");
  expect(css).toMatch(/\.comment > header:has\(> \.commentConfirm\) \{ flex-wrap: wrap;/);
  expect(css).toMatch(/\.commentConfirm \{[^}]*margin-left: auto;/);
  // As tall as the author chip from outside (as «⋯»), so the comment does not jump when the question opens.
  expect(css).toMatch(/\.commentConfirm \{[^}]*margin-block: -1\.5px;/);
  expect(css).toMatch(/\.commentConfirm > \.confirmDelete \{ color: var\(--error-container\); \}/);
  expect(css).toMatch(/\.comment\[data-confirming\] > :not\(header, \[role="alert"\]\) \{ opacity: \.45; \}/);
  expect(css).toMatch(/\.commentMenuItem\.commentMenuDanger, [^{]*\{ color: var\(--error-container\); \}/);
  expect(css).not.toMatch(/\.commentConfirm \{[^}]*border: 1px solid var\(--error\)/);
});
