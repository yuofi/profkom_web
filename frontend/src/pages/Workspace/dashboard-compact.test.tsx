// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { workspaceApi, type Workday } from "../../utils/api/workspace.api";
import { ApiError } from "../../utils/api/request";
import { DashboardPage } from "./WorkspacePages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const empty: Workday = { today: "2026-10-30", agenda: [], tasks: [], overdue_tasks: [], overdue_count: 0, undated_count: 2, approvals: [], merit_entries: [] };
const region = (label: string) => page!.container.querySelector<HTMLElement>(`[role="region"][aria-label="${label}"]`)!;
const box = () => page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const twoTasks = (state: ReturnType<typeof installMockTransport>["state"]) => [state.tasks[0], { ...structuredClone(state.tasks[0]), task_id: "task-second", task_key: "TASK-2", title: "Вторая задача дня" }];
const headings = (root: ParentNode) => [...root.querySelectorAll("h2")].map(heading => heading.firstChild?.textContent);

it("keeps a short empty-day line and the personal teams beside the deadline lists (EV-28, D-01)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(workspaceApi, "home").mockResolvedValue(empty);
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  const day = page.container.querySelector('[role="region"][aria-label="Сегодняшний день"]')!;
  // An empty day no longer draws 24 empty hours; it says so and leads to the calendar.
  expect(day.querySelector('[aria-label="Календарь дня"]')).toBeNull();
  expect(day.textContent).toBe("Сегодня событий нет · открыть календарь");
  expect(day.querySelector("a")?.getAttribute("href")).toBe("/calendar?view=day&date=2026-10-30");
  expect(page.container.querySelector('[aria-label="Задачи по срокам"]')?.textContent).toContain("Ближайшие задачи");
  // D-01: zero overdue tasks are a line under the heading of the nearest tasks, not a card.
  expect(page.container.querySelector('[class*="overdue"]')).toBeNull();
  expect(region("Задачи по срокам").querySelector('[class*="taskMeta"]')?.textContent).toBe("Просроченных задач нетТакже задачи, за которыми я наблюдаю");
  expect(page.container.textContent).toContain("Нет задач с будущим дедлайном.");
  expect(page.container.textContent).toContain("Без срока: 2");
  const teams = region("Сегодня, решения и команды");
  expect(teams.querySelector('section[aria-label="Мои блоки"]')).not.toBeNull();
  expect(teams.querySelector('section[aria-label="Мои мероприятия"]')).not.toBeNull();
  expect([...page.container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toContain("/calendar?view=day&date=2026-10-30");
});

it("retains the watched-task request flag and only renders approvals returned by the server", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const get = vi.spyOn(workspaceApi, "home").mockImplementation(async watching => ({ ...empty, approvals: watching ? [{ kind: "queue_access", title: "Доступ в очередь подготовки", count: 3, to: "/tasks/queues/preparation" }] : [] }));
  page = await mountWorkspace(<DashboardPage />, { role: "organizer" });await waitForPage(page);
  expect(get).toHaveBeenLastCalledWith(false);
  expect(page.container.textContent).not.toContain("Требует решения");
  await act(async () => page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await waitForPage(page);
  expect(get).toHaveBeenLastCalledWith(true);
  expect(page.container.querySelector('a[href="/tasks/queues/preparation"]')?.textContent).toContain("Доступ в очередь подготовки");
  expect(page.container.querySelector('[aria-label="Задачи по срокам"]')?.textContent).not.toContain("Требует решения");
  // D-01: the decisions stand in the side column between the day and the teams.
  expect(headings(region("Сегодня, решения и команды"))).toEqual(["Сегодня", "Требует решения", "Мои команды", "Мои блоки", "Мои мероприятия"]);
});

it("shows the compact accounting entry for explicit assignment capabilities and hides it from a plain reader", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  vi.spyOn(workspaceApi, "home").mockResolvedValue(empty);
  const plain = { ...createFixtures("organizer").session, capabilities: [], assignments: [] };
  page = await mountWorkspace(<DashboardPage />, { session: plain });await waitForPage(page);
  expect(page.container.querySelector('header a[href="/merits"]')).toBeNull();
  await page.cleanup();
  page = await mountWorkspace(<DashboardPage />, { session: { ...plain, assignments: [{ role_assignment_id: "scoped-head", role: "event_leader", scope_kind: "event", scope_id: "event-one", revision: 1, capabilities: ["create_head_merit"] }] } });await waitForPage(page);
  expect(page.container.querySelector('header a[href="/merits"]')?.textContent).toBe("Учёт выполненной работы");
});

it("leaves personal teams readable when the day request fails and offers a retry", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(workspaceApi, "home").mockRejectedValue(new ApiError("Не удалось загрузить день", 503, "unavailable"));
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Сервис временно недоступен");
  expect([...page.container.querySelectorAll("button")].some(button => button.textContent === "Обновить данные")).toBe(true);
  expect(page.container.querySelector('section[aria-label="Мои блоки"]')).not.toBeNull();
  expect(page.container.querySelector('[aria-label="Сегодняшний день"]')).toBeNull();
  // D-01: the watched-tasks box lives in the task card and stays there through the failure.
  expect(region("Задачи по срокам").contains(box())).toBe(true);expect(box().checked).toBe(false);
});

it("D-01: overdue tasks keep their own card above the nearest tasks, and the box stays under the nearest heading", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const [late, soon] = twoTasks(mock.state);
  vi.spyOn(workspaceApi, "home").mockResolvedValue({ ...empty, overdue_tasks: [late], overdue_count: 3, tasks: [soon] });
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  const tasks = region("Задачи по срокам");
  const cards = [...tasks.children];
  expect(cards).toHaveLength(2);
  expect(headings(tasks)).toEqual(["Просроченные", "Ближайшие задачи"]);
  expect(cards[0].className).toContain("overdue");expect(cards[0].querySelector("h2")?.textContent).toBe("Просроченные3");
  expect([...cards[0].querySelectorAll("a")].find(link => link.getAttribute("href") === "/tasks?mine=true&unfinished=true&overdue=true")?.textContent).toBe("Все просроченные задачи");
  expect(cards[0].querySelector('ul[aria-label="Просроченные задачи"]')?.textContent).toContain(late.title);
  // With overdue tasks there is no «none» line; the box keeps its place in the nearest tasks.
  expect(tasks.textContent).not.toContain("Просроченных задач нет");
  expect(cards[1].querySelector('[class*="taskMeta"]')?.textContent).toBe("Также задачи, за которыми я наблюдаю");
  expect(cards[1].querySelector('ul[aria-label="Ближайшие задачи"]')?.textContent).toContain(soon.title);
});

it("D-01: tasks come first in the page order, so a phone shows them before the day and the teams", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(workspaceApi, "home").mockResolvedValue({ ...empty, approvals: [{ kind: "block_requests", title: "Заявки в блоки", count: 2, to: "/blocks/requests" }] });
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  const board = region("Задачи по срокам").parentElement!;
  expect([...board.children].map(column => column.getAttribute("aria-label"))).toEqual(["Задачи по срокам", "Сегодня, решения и команды"]);
  expect(headings(board)).toEqual(["Ближайшие задачи", "Сегодня", "Требует решения", "Мои команды", "Мои блоки", "Мои мероприятия"]);
  // Two columns from 1100 px (2 : 1), one below; the team cards stack in the side column.
  const css = readFileSync(`${__dirname}/Dashboard.module.css`, "utf8");
  expect(board.className).toContain("board");
  expect(css).toMatch(/\.board \{[^}]*grid-template-columns: minmax\(0, 2fr\) minmax\(300px, 1fr\)/);
  expect(css).toMatch(/@media \(max-width: 1100px\) \{\s*\.board \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  expect(css).toMatch(/\.teamColumns \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

it("D-01: the watched-tasks box keeps its node and focus while the other choice loads", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const [own, watched] = twoTasks(mock.state);
  let release: (day: Workday) => void = () => {};
  vi.spyOn(workspaceApi, "home").mockImplementation(watching => watching ? new Promise<Workday>(resolve => { release = resolve; }) : Promise.resolve({ ...empty, tasks: [own] }));
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  const node = box();node.focus();
  await act(async () => node.click());
  // The previous day stays on screen and reads as busy; the box neither moves nor loses focus.
  expect(box()).toBe(node);expect(node.checked).toBe(true);expect(document.activeElement).toBe(node);
  expect(region("Задачи по срокам").getAttribute("aria-busy")).toBe("true");
  expect(region("Задачи по срокам").textContent).toContain(own.title);
  expect(page.container.textContent).not.toContain("Загружаем данные");
  await act(async () => release({ ...empty, tasks: [own, watched] }));await waitForPage(page);
  expect(region("Задачи по срокам").getAttribute("aria-busy")).toBeNull();
  expect(region("Задачи по срокам").textContent).toContain(watched.title);
  expect(box()).toBe(node);expect(document.activeElement).toBe(node);
});

it("D-01: when the watched day fails, the box can still be turned back", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const [own] = mock.state.tasks;
  vi.spyOn(workspaceApi, "home").mockImplementation(async watching => { if (watching) throw new ApiError("Не удалось загрузить день", 503, "unavailable");return { ...empty, tasks: [own] }; });
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  await act(async () => box().click());await waitForPage(page);
  expect(region("Задачи по срокам").querySelector('[role="alert"]')).not.toBeNull();
  expect(page.container.querySelector('[aria-label="Сегодняшний день"]')).toBeNull();
  expect(box().checked).toBe(true);
  await act(async () => box().click());await waitForPage(page);
  expect(box().checked).toBe(false);
  expect(region("Задачи по срокам").querySelector('[role="alert"]')).toBeNull();
  expect(region("Задачи по срокам").textContent).toContain(own.title);
  expect(page.container.querySelector('[aria-label="Сегодняшний день"]')).not.toBeNull();
});
