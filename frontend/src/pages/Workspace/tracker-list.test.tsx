// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TrackerListPage } from "./TrackerList";
import { tasksApi } from "../../utils/api/tasks.api";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change } from "../../test/workspace";
import type { TaskListPageResponse } from "../../utils/api/contract";

vi.mock("./TaskCreateForm", () => ({ TaskCreateForm: () => <p>Создание задачи</p> }));
vi.mock("./TaskStatusMenu", () => ({ TaskStatusMenu: function Menu() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(!open)}>Статус задачи</button>{open && <div role="menu">Доступные переходы</div>}</>;
} }));
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; transport?.restore(); transport = undefined; vi.restoreAllMocks(); });
function Location() { return <output data-location>{useLocation().search}</output>; }
async function mount(path = "/tasks", responder?: (params: object) => TaskListPageResponse) {
  transport = installMockTransport("chair", { delay: 0 });
  const task = { ...createFixtures("chair").tasks[0], task_key: "TASK-17", title: "Проверка общей работы", status: "assigned" as const };
  const list = vi.spyOn(tasksApi, "listPage").mockImplementation(async params => responder?.(params ?? {}) ?? ({ items: [task], next_cursor: null, total: 1, scopes: [], assignees: [] }));
  page = await mountWorkspace(<Routes>
    <Route path="/tasks" element={<><TrackerListPage /><Location /></>} />
    <Route path="/tasks/:id" element={<p>Открытая задача</p>} />
    <Route path="/contacts/:id" element={<p>Профиль исполнителя</p>} />
  </Routes>, { path });
  await waitForPage(page);
  return { task, list };
}
const button = (text: string) => Array.from(page!.container.querySelectorAll("button")).find(node => node.textContent?.trim() === text)!;

it("opens the task from a non-link row cell and supports keyboard row activation", async () => {
  await mount();
  await act(async () => page!.container.querySelector("tbody td")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(page!.container.textContent).toContain("Открытая задача");
  await page!.cleanup(); page = undefined; transport!.restore(); transport = undefined; vi.restoreAllMocks();
  await mount();
  await act(async () => page!.container.querySelector("tbody tr")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(page!.container.textContent).toContain("Открытая задача");
});
it("an assignee chip opens that person's profile without activating the row", async () => {
  const { task } = await mount();
  const assignee = task.assignments.find(item => item.assignee.user_id != null)!;
  const link = page!.container.querySelector<HTMLAnchorElement>(`tbody a[href="/contacts/${assignee.assignee.user_id}"]`)!;
  expect(link).not.toBeNull();
  await act(async () => link.click());
  expect(page!.container.textContent).toContain("Профиль исполнителя");
  expect(page!.container.textContent).not.toContain("Открытая задача");
});
it("the status chip opens its menu and keeps the task list visible", async () => {
  await mount();
  await act(async () => button("Статус задачи").click());
  expect(page!.container.querySelector('[role="menu"]')?.textContent).toContain("Доступные переходы");
  expect(page!.container.querySelector("table")).not.toBeNull();
  expect(page!.container.textContent).not.toContain("Открытая задача");
});
it("represents selected filters as independent removable chips and removes only the chosen filter", async () => {
  const { list } = await mount("/tasks?mine=true&status=in_progress&q=общая");
  expect(page!.container.querySelector('[aria-label="Активные фильтры"]')?.textContent).toContain("Мои задачи");
  expect(page!.container.querySelector('[aria-label="Активные фильтры"]')?.textContent).toContain("Статус: В работе");
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Убрать фильтр: Статус"]')!.click());
  await waitForPage(page!);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ mine: "true", q: "общая" }), expect.any(AbortSignal));
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("status");
  const url = page!.container.querySelector("[data-location]")!.textContent!;
  expect(new URLSearchParams(url).has("status")).toBe(false);
  expect(new URLSearchParams(url).get("mine")).toBe("true");
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Убрать фильтр: Назначение"]')!.click());
  await waitForPage(page!);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ mine: "false", q: "общая" }), expect.any(AbortSignal));
});
it("uses real next cursors and resets pagination when search changes", async () => {
  const { list } = await mount("/tasks", params => ({ items: [], next_cursor: "cursor" in params ? null : "page-two", total: 23, scopes: [], assignees: [] }));
  await act(async () => button("Далее").click()); await waitForPage(page!);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-two" }), expect.any(AbortSignal));
  expect(page!.container.textContent).toContain("Страница 2");
  await change(page!.container.querySelector<HTMLInputElement>('[aria-label="Поиск задач"]')!, "TASK-17"); await waitForPage(page!, () => (list.mock.lastCall?.[0] as { q?: string })?.q === "TASK-17");
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "TASK-17" }), expect.any(AbortSignal));
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("cursor");
  expect(page!.container.textContent).toContain("Страница 1");
});
it("preserves a modifier click on the whole row as a new-tab navigation", async () => {
  const { task } = await mount();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => page!.container.querySelector("tbody td")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
  expect(open).toHaveBeenCalledWith(`/tasks/${task.task_id}`, "_blank", "noopener,noreferrer");
  expect(page!.container.querySelector("table")).not.toBeNull();
});
it("omits empty optional filters rather than sending an invalid empty numeric or status value", async () => {
  const { list } = await mount();
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("assignee_user_id");
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("status");
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("scope_id");
});
