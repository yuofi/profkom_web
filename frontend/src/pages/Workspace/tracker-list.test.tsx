// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TrackerListPage } from "./TrackerList";
import { tasksApi } from "../../utils/api/tasks.api";
import { eventsApi } from "../../utils/api/events.api";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, settle } from "../../test/workspace";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { TaskListPageResponse } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";

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
  const task = { ...createFixtures("chair").tasks[0], task_key: "TASK-17", title: "Проверка общей работы", status: "open" as const };
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

it("PF-04: resting on the task's link or cell starts the task; resting on a person's chip in the row starts nothing", async () => {
  const { task } = await mount();
  const get = vi.spyOn(tasksApi, "get"), comments = vi.spyOn(tasksApi, "comments");
  const row = page!.container.querySelector("tbody tr")!, chip = row.querySelector('a[href^="/contacts/"]')!, title = row.querySelector(`a[href="/tasks/${task.task_id}"]`)!;
  const rest = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));await new Promise(resolve => setTimeout(resolve, 200)); });
  expect(chip).not.toBeNull();
  await rest(chip);expect(get).not.toHaveBeenCalled();
  await rest(title);await waitForPage(page!);
  expect(get).toHaveBeenCalledExactlyOnceWith(task.task_id);expect(comments).not.toHaveBeenCalled();
});
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
it("opens a bare list on the current season's unfinished work and keeps a cleared default cleared", async () => {
  const { list } = await mount("/tasks");
  const filters = () => page!.container.querySelector('[aria-label="Активные фильтры"]')!.textContent!, url = () => new URLSearchParams(page!.container.querySelector("[data-location]")!.textContent!);
  expect(list.mock.calls.length).toBeGreaterThan(0);
  expect(list.mock.calls.every(call => (call[0] as { season_id?: string; unfinished?: string }).season_id === "season-1" && (call[0] as { unfinished?: string }).unfinished === "true")).toBe(true);
  expect(url().get("season_id")).toBe("season-1");expect(url().get("unfinished")).toBe("true");
  expect(filters()).toContain("Сезон: Осень и зима 2026");expect(filters()).toContain("Незавершённые");
  expect(filters()).not.toContain("Показаны все доступные вам задачи");expect(button("Сбросить все")).toBeUndefined();
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Убрать фильтр: Сезон"]')!.click());await waitForPage(page!);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Убрать фильтр: Незавершённые"]')!.click());await waitForPage(page!);
  expect(url().get("season_id")).toBe("");expect(url().get("unfinished")).toBe("");
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("season_id");expect(list.mock.lastCall?.[0]).not.toHaveProperty("unfinished");
  expect(filters()).toContain("Показаны все доступные вам задачи");
});
it("does not name a season «выбран» or offer a reset while the current season is still being read", async () => {
  let release: (() => void) | undefined;const current = seasonsApi.current;
  vi.spyOn(seasonsApi, "current").mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; });return current(); });
  transport = installMockTransport("chair", { delay: 0 });vi.spyOn(tasksApi, "listPage").mockResolvedValue({ items: [], next_cursor: null, total: 0, scopes: [], assignees: [] });
  page = await mountWorkspace(<Routes><Route path="/tasks" element={<><TrackerListPage /><Location /></>} /></Routes>, { path: "/tasks?season_id=season-1&unfinished=true" });
  for (let wait = 0; !release && wait < 100; wait++) await settle();
  const filters = () => page!.container.querySelector('[aria-label="Активные фильтры"]')!.textContent!;
  expect(filters()).toContain("Сезон: …");expect(filters()).not.toContain("выбран");expect(button("Сбросить все")).toBeUndefined();
  await act(async () => release!());await waitForPage(page);
  expect(filters()).toContain("Сезон: Осень и зима 2026");expect(button("Сбросить все")).toBeUndefined();
});
it("resets every filter back to the current open work", async () => {
  const { list } = await mount("/tasks?mine=true&status=in_progress&view=list");
  expect(list.mock.calls.every(call => !("season_id" in (call[0] as object)))).toBe(true);
  await act(async () => button("Сбросить все").click());await waitForPage(page!);
  const url = new URLSearchParams(page!.container.querySelector("[data-location]")!.textContent!);
  expect([...url.keys()].sort()).toEqual(["season_id", "unfinished", "view"]);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ season_id: "season-1", unfinished: "true" }), expect.any(AbortSignal));
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("status");
});
it("names the chair team filter and lets it be removed without probing team creation", async () => {
  const subevent = vi.spyOn(eventsApi, "subevent");
  const { list } = await mount("/tasks?scope_kind=chair&scope_id=chair");
  const filters = page!.container.querySelector('[aria-label="Активные фильтры"]')!.textContent!;
  expect(filters).toContain("Команда: Работа председателя");expect(filters).not.toContain("Показаны все доступные вам задачи");
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ scope_kind: "chair", scope_id: "chair" }), expect.any(AbortSignal));
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Убрать фильтр: Команда"]')!.click());await waitForPage(page!);
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("scope_kind");expect(subevent).not.toHaveBeenCalled();
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

it("D-02: keeps the team column on the main list and folds every assignee after the first into one counter", async () => {
  const fixture = createFixtures("chair");const people = fixture.people.slice(0, 5).map(person => ({ user_id: person.user_id, display_name: person.display_name, avatar_url: null }));
  await mount("/tasks?mine=false", () => ({ items: [{ ...fixture.tasks[0], task_key: "TASK-17", assignees: people }], next_cursor: null, total: 1, scopes: [], assignees: [] }));
  expect([...page!.container.querySelectorAll("thead th")].map(th => th.textContent?.trim())).toContain("Команда");
  const cell = page!.container.querySelector("td[data-label='Исполнители']")!;
  expect(cell.querySelectorAll('a[href^="/contacts/"]')).toHaveLength(1);
  const counter = cell.querySelector<HTMLElement>('[class*="morePeople"]')!;
  // The rest stay named for a screen reader and in the tooltip; the task page lists everyone.
  expect(counter.textContent).toMatch(/^\+4/);expect(counter.title).toBe(`Ещё: ${people.slice(1).map(person => person.display_name).join(", ")}`);
  for (const person of people.slice(1)) expect(counter.textContent).toContain(person.display_name);
  // The counter is not a control: a click on it opens the task, as the rest of the row does.
  await act(async () => counter.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(page!.container.textContent).toContain("Открытая задача");
});
it("D-02: a single assignee has no counter", async () => {
  const fixture = createFixtures("chair");const person = fixture.people[0];
  await mount("/tasks?mine=false", () => ({ items: [{ ...fixture.tasks[0], assignees: [{ user_id: person.user_id, display_name: person.display_name, avatar_url: null }] }], next_cursor: null, total: 1, scopes: [], assignees: [] }));
  const cell = page!.container.querySelector("td[data-label='Исполнители']")!;
  expect(cell.querySelectorAll('a[href^="/contacts/"]')).toHaveLength(1);expect(cell.querySelector('[class*="morePeople"]')).toBeNull();
});
it("D-02: list dates drop the current year, keep another year's, and name the date in the tooltip", async () => {
  const year = Number(new Intl.DateTimeFormat("en", { timeZone: "Europe/Moscow", year: "numeric" }).format(Date.now()));
  const thisYear = `${year}-06-15T09:00:00Z`, nextYear = `${year + 1}-02-03T09:00:00Z`, fixture = createFixtures("chair").tasks[0];
  await mount("/tasks?mine=false", () => ({ items: [
    { ...fixture, task_id: "task-a", task_key: "QB-1", deadline_at: thisYear, updated_at: thisYear },
    { ...fixture, task_id: "task-b", task_key: "QB-2", deadline_at: nextYear, updated_at: thisYear },
    { ...fixture, task_id: "task-c", task_key: "QB-3", deadline_at: null },
  ], next_cursor: null, total: 3, scopes: [], assignees: [] }));
  const [current, later, none] = [...page!.container.querySelectorAll("tbody tr")].map(row => row.querySelector("td[data-label='Дедлайн']")!);
  const short = current.querySelector("time")!;
  expect(short.textContent).not.toContain(String(year));expect(short.textContent).toMatch(/^15\u00a0\S+, 12:00$/);
  expect(short.title).toBe(`Дедлайн: ${displayDate(thisYear)}`);expect(short.dateTime).toBe(thisYear);expect(short.hasAttribute("data-full")).toBe(false);
  const full = later.querySelector("time")!;
  expect(full.textContent).toBe(displayDate(nextYear));expect(full.textContent).toContain(String(year + 1));expect(full.hasAttribute("data-full")).toBe(true);
  // A phone row has no column header: the deadline's name is there for a screen reader, not before «Без дедлайна».
  expect(current.querySelector('[class*="cellLabel"]')?.textContent).toBe("Дедлайн: ");
  expect(none.textContent).toBe("Без дедлайна");expect(none.querySelector('[class*="cellLabel"]')).toBeNull();
  const updated = page!.container.querySelector<HTMLTimeElement>("tbody td[data-label='Обновлено'] time")!;
  expect(updated.title).toBe(`Обновлено: ${displayDate(thisYear)}`);expect(updated.textContent).not.toContain(String(year));
});
it("D-02: the key cell is one row of type, priority, key and star, the key and its star wrapping together", async () => {
  await mount();
  const row = page!.container.querySelector("td[data-label='Ключ'] [class*='keyRow']")!;
  expect([...row.children].map(child => child.className.match(/(classificationControls|keyName)/)?.[1])).toEqual(["classificationControls", "keyName"]);
  const name = row.querySelector("[class*='keyName']")!;
  expect(name.querySelector("[class*='keyText']")?.textContent).toBe("TASK-17");expect(name.querySelector('button[aria-label^="Добавить в избранное"], button[aria-label^="Убрать из избранного"]')).not.toBeNull();
});
it("D-02: on a phone the deadline closes the people row, and joins the key row from 480 px", () => {
  const css = readFileSync(`${__dirname}/TrackerList.module.css`, "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 768px)"));
  expect(phone).toMatch(/\.table tbody tr \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  expect(phone).toMatch(/\.status \{ grid-column: 2 \/ 4; grid-row: 1; justify-self: end;/);
  expect(phone).toMatch(/\.assignees \{ grid-column: 1 \/ 3; grid-row: 3; \}/);
  expect(phone).toMatch(/\.deadline \{ grid-column: 3; grid-row: 3; align-self: center; justify-self: end;/);
  expect(phone).not.toMatch(/content: "Дедлайн · "/);
  const wide = css.match(/@media\(min-width:480px\) and \(max-width:768px\) \{([^\n]*)\}/)?.[1] ?? "";
  expect(wide).toMatch(/\.deadline \{ grid-column:2;grid-row:1; \}/);expect(wide).toMatch(/\.status \{ grid-column:3; \}/);expect(wide).toMatch(/\.assignees \{ grid-column:1 \/ -1; \}/);
  // Desktop: one key line at every width, short dates on one line, one width set.
  expect(css).not.toMatch(/order:-1;flex:1 0 100%/);expect(css).not.toMatch(/min-width: 1441px/);
  expect(css).toMatch(/@media \(min-width: 769px\) \{ \.table :is\(td\.deadline, td\.updated\) time:not\(\[data-full\]\) \{ white-space: nowrap; \} \}/);
  expect(css).toMatch(/\.table \.colKey \{ width: 150px; \}.*\.table \.colDeadline \{ width: 84px; \}.*\.table \.colUpdated \{ width: 84px; \}/);
});

it("keeps the current rows and paging in place while the next page loads", async () => {
  transport = installMockTransport("chair", { delay: 0 });
  const fixture = createFixtures("chair").tasks[0];let release!: (value: TaskListPageResponse) => void;
  vi.spyOn(tasksApi, "listPage").mockImplementation(async params => (params as { cursor?: string }).cursor
    ? new Promise<TaskListPageResponse>(resolve => { release = resolve; })
    : { items: [{ ...fixture, title: "Первая страница" }], next_cursor: "page-two", total: 21, scopes: [], assignees: [] });
  page = await mountWorkspace(<TrackerListPage />, { path: "/tasks?mine=false" });await waitForPage(page);
  const table = page.container.querySelector("table");
  await act(async () => button("Далее").click());
  expect(page.container.querySelector("table")).toBe(table);expect(page.container.textContent).not.toContain("Загружаем данные");
  expect(page.container.querySelector("[aria-busy='true']")?.textContent).toContain("Первая страница");
  expect(button("Далее").disabled).toBe(true);expect(button("Назад").disabled).toBe(true);expect(page.container.textContent).toContain("Страница 2");
  await act(async () => release({ items: [{ ...fixture, title: "Вторая страница" }], next_cursor: null, total: 21, scopes: [], assignees: [] }));await waitForPage(page);
  expect(page.container.textContent).toContain("Вторая страница");expect(page.container.querySelector("[aria-busy='true']")).toBeNull();expect(button("Назад").disabled).toBe(false);
});
it("steps back from an opened page link through its saved previous cursor", async () => {
  const { list } = await mount("/tasks?mine=false&cursor=c3&page=3&prev_cursor=c2", params => ({ items: [], next_cursor: (params as { cursor?: string }).cursor ? "c4" : "c2", total: 80, scopes: [], assignees: [] }));
  await act(async () => button("Назад").click());await waitForPage(page!);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c2" }), expect.any(AbortSignal));expect(page!.container.textContent).toContain("Страница 2");
});
it("walks back through every earlier page saved in the history entry after a reload", async () => {
  transport = installMockTransport("chair", { delay: 0 });
  const list = vi.spyOn(tasksApi, "listPage").mockImplementation(async () => ({ items: [], next_cursor: "next", total: 80, scopes: [], assignees: [] }));
  // A reloaded history entry keeps its URL and its state.
  page = await mountWorkspace(<Routes>
    <Route path="/reload" element={<Navigate to="/tasks?mine=false&cursor=c4&page=4&prev_cursor=c3" replace state={{ trackerCursors: ["", "c2", "c3"] }} />} />
    <Route path="/tasks" element={<><TrackerListPage /><Location /></>} />
  </Routes>, { path: "/reload" });await waitForPage(page);
  await act(async () => button("Назад").click());await waitForPage(page);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c3" }), expect.any(AbortSignal));expect(page.container.textContent).toContain("Страница 3");
  await act(async () => button("Назад").click());await waitForPage(page);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c2" }), expect.any(AbortSignal));expect(page.container.textContent).toContain("Страница 2");
  await act(async () => button("Назад").click());await waitForPage(page);
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("cursor");expect(new URLSearchParams(page.container.querySelector("[data-location]")!.textContent!).has("prev_cursor")).toBe(false);
});
