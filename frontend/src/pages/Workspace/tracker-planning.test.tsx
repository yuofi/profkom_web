// @vitest-environment jsdom
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TrackerListPage } from "./TrackerList";
import { TrackerCalendar } from "./TrackerCalendar";
import { TrackerGantt } from "./TrackerGantt";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { loadPlanningTasks, moscowDay, planningRange, taskPlanning } from "./trackerPlanning";
import type { Task, TaskListPageResponse } from "../../utils/api/contract";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks();vi.useRealTimers(); });
const task = (overrides: Partial<Task> = {}): Task => ({ ...createFixtures("chair").tasks[0], task_key: "ITWEB-17", title: "Плановая задача", starts_at: "2026-10-05T21:30:00Z", deadline_at: "2026-10-09T12:00:00Z", task_type: "task", priority: "normal", is_favorite: false, ...overrides });
const button = (name: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === name)!;
function Location() { return <output data-location>{useLocation().search}</output>; }
async function list(path: string, respond: (filters: Record<string, unknown>) => TaskListPageResponse | Promise<TaskListPageResponse>, client?: QueryClient) {
  transport = installMockTransport("chair", { delay: 0 });const spy = vi.spyOn(tasksApi, "listPage").mockImplementation(filters => Promise.resolve(respond(filters as Record<string, unknown>)));
  page = await mountWorkspace(<Routes><Route path="/tasks" element={<><TrackerListPage /><Location /></>} /><Route path="/tasks/:id" element={<p>Открытая задача</p>} /></Routes>, { path, client });await waitForPage(page);return spy;
}
it("uses Moscow civil dates and never substitutes creation or accounting dates for a missing plan", () => {
  expect(moscowDay("2026-10-04T21:30:00Z")).toBe("2026-10-05");expect(taskPlanning(task())).toMatchObject({ first: "2026-10-06", last: "2026-10-09", hasStart: true });
  expect(taskPlanning(task({ starts_at: null, created_at: "2026-09-01T00:00:00Z" }))).toEqual({ first: "2026-10-09", last: "2026-10-09", hasStart: false });
  expect(taskPlanning(task({ task_type: "milestone" }))).toEqual({ first: "2026-10-09", last: "2026-10-09", hasStart: false });expect(taskPlanning(task({ starts_at: "2026-10-10T00:00:00Z" })).hasStart).toBe(false);
});
it("keeps year-round service tickets undated and excludes them from date plans", async () => {
  const service = task({ task_id: "service", scope: { kind: "queue", id: "support" }, season_id: null, starts_at: null, deadline_at: null });
  expect(moscowDay(null)).toBe("");
  expect(taskPlanning(service)).toEqual({ first: "", last: "", hasStart: false });
  const dated = task();
  vi.spyOn(tasksApi, "listPage").mockResolvedValue({ items: [service, dated], next_cursor: null });
  expect(await loadPlanningTasks({}, planningRange("2026-10", "calendar"))).toEqual([dated]);
});
it("shows complete Monday-first calendar weeks and a three-month Gantt overview", () => {
  const range = planningRange("2026-10", "calendar");expect(range.first).toBe("2026-09-28");expect(range.last).toBe("2026-11-08");expect(range.days).toHaveLength(42);expect(planningRange("2026-10", "gantt").days).toHaveLength(31);
  const quarter = planningRange("2026-10", "gantt", "month");expect(quarter.first).toBe("2026-09-01");expect(quarter.last).toBe("2026-11-30");expect(quarter.days).toHaveLength(91);
});
it("loads all period cursors and retains filters without inheriting a list-page cursor", async () => {
  const first = task(), second = task({ task_id: "task-second" });const get = vi.spyOn(tasksApi, "listPage").mockResolvedValueOnce({ items: [first], next_cursor: "next" }).mockResolvedValueOnce({ items: [second], next_cursor: null });
  expect((await loadPlanningTasks({ cursor: "old", mine: "true", task_type: "epic", favorite: "true", priority: "high" }, planningRange("2026-10", "calendar"))).map(item => item.task_id)).toEqual([first.task_id, second.task_id]);
  expect(get.mock.calls[0][0]).toMatchObject({ mine: "true", task_type: "epic", favorite: "true", priority: "high", limit: 100, date_from: "2026-09-27T21:00:00.000Z", date_to: "2026-11-08T21:00:00.000Z" });expect(get.mock.calls[0][0]).not.toHaveProperty("cursor");expect(get.mock.calls[1][0]).toMatchObject({ cursor: "next" });
});
it("fails rather than showing a truncated or partially authorized period", async () => {
  vi.spyOn(tasksApi, "listPage").mockResolvedValue({ items: [task()], next_cursor: "same" });await expect(loadPlanningTasks({}, planningRange("2026-10", "calendar"))).rejects.toMatchObject({ code: "pagination_error" });vi.restoreAllMocks();
  vi.spyOn(tasksApi, "listPage").mockResolvedValueOnce({ items: [task()], next_cursor: "next" }).mockRejectedValueOnce(new ApiError("Доступ закрыт", 403));await expect(loadPlanningTasks({}, planningRange("2026-10", "calendar"))).rejects.toMatchObject({ status: 403 });
});
it("switches views without dropping selected filters and preserves the view when filters clear", async () => {
  const source = task();const get = await list("/tasks?mine=true&task_type=epic&priority=high&favorite=true&month=2026-10", () => ({ items: [source], next_cursor: null, total: 1, scopes: [], assignees: [] }));
  await act(async () => button("Календарь").click());await waitForPage(page!);expect(page!.container.querySelector('[aria-label="Календарь задач"]')).not.toBeNull();expect(get.mock.calls.some(call => (call[0] as Record<string, unknown>).date_from === "2026-09-27T21:00:00.000Z")).toBe(true);
  expect(page!.container.querySelector('[aria-label="Активные фильтры"]')?.textContent).toContain("Тип: Эпик");expect(page!.container.querySelector('[data-location]')?.textContent).toContain("favorite=true");await act(async () => button("Гантт").click());await waitForPage(page!);expect(page!.container.querySelector('[aria-label="Диаграмма Гантта"]')).not.toBeNull();
  await act(async () => button("Сбросить все").click());await waitForPage(page!);const search = new URLSearchParams(page!.container.querySelector('[data-location]')!.textContent!);expect(search.get("view")).toBe("gantt");expect(search.get("month")).toBe("2026-10");expect(search.has("favorite")).toBe(false);
});
it("changes a personal favorite without opening the row or changing public revision", async () => {
  const source = task(), revision = source.revision;const save = vi.spyOn(tasksApi, "setFavorite").mockImplementation(async () => { source.is_favorite = true;return source; });await list("/tasks", () => ({ items: [source], next_cursor: null, scopes: [], assignees: [] }));
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Добавить в избранное: ITWEB-17"]')!.click());await waitForPage(page!);expect(save).toHaveBeenCalledExactlyOnceWith(source.task_id, true);expect(source.revision).toBe(revision);expect(page!.container.querySelector('[aria-label="Список задач"]')).not.toBeNull();expect(page!.container.textContent).not.toContain("Открытая задача");expect(page!.container.querySelector('[aria-label="Убрать из избранного: ITWEB-17"]')?.getAttribute("aria-pressed")).toBe("true");
});
it("marks Moscow today and shows a task without a start only on its deadline", async () => {
  vi.setSystemTime(new Date("2026-10-06T09:00:00Z"));const source = task({ starts_at: null });transport = installMockTransport("chair", { delay: 0 });page = await mountWorkspace(<Routes><Route path="/" element={<TrackerCalendar tasks={[source]} month="2026-10" range={planningRange("2026-10", "calendar")} onMonth={() => {}} />} /></Routes>);await waitForPage(page);
  expect(page.container.querySelector('[aria-current="date"]')?.getAttribute("dateTime")).toBe("2026-10-06");expect(page.container.querySelectorAll('a[href="/tasks/'+source.task_id+'"]').length).toBe(1);expect(page.container.querySelector('a')?.getAttribute("aria-label")).toContain("Дедлайн");
});
it("renders a milestone, an epic and visible dependency arrows, and opens the selected task", async () => {
  const source = task({ task_type: "epic" }), target = task({ task_id: "milestone", task_key: "ITWEB-18", title: "Проверочная веха", task_type: "milestone", starts_at: null });source.links = [{ link_id: "edge", kind: "blocks", task: { task_id: target.task_id, task_key: target.task_key!, title: target.title, task_type: "milestone", status: "open", starts_at: null, deadline_at: target.deadline_at } }];transport = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/" element={<TrackerGantt tasks={[source, target]} range={planningRange("2026-10", "gantt")} month="2026-10" onMonth={() => {}} zoom="week" onZoom={() => {}} />} /><Route path="/tasks/:id" element={<p>Открытая задача</p>} /></Routes>);await waitForPage(page);
  expect(page.container.querySelector('[data-type="epic"]')).not.toBeNull();const milestone = page.container.querySelector<HTMLAnchorElement>('a[data-type="milestone"]')!;expect(milestone.textContent).toContain("◆");expect(milestone.getAttribute("aria-label")).toContain("Веха, срок");expect(page.container.querySelector('svg>path[marker-end]')).not.toBeNull();await act(async () => milestone.click());expect(page.container.textContent).toContain("Открытая задача");
});
it("hides cached task rows immediately when a personal action discovers lost access", async () => {
  let denied = false;const source = task();vi.spyOn(tasksApi, "setFavorite").mockImplementation(async () => { denied = true;throw new ApiError("Доступ закрыт", 403); });await list("/tasks", async () => { if (denied) throw new ApiError("Доступ закрыт", 403);return { items: [source], next_cursor: null, scopes: [], assignees: [] }; });
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Добавить в избранное: ITWEB-17"]')!.click());await waitForPage(page!);expect(page!.container.querySelector('[aria-label="Список задач"]')).toBeNull();expect(page!.container.querySelector('[role="alert"]')).not.toBeNull();expect(page!.container.textContent).not.toContain(source.title);
});

it.each(["calendar", "gantt"] as const)("never lets a background list 500 mask a refused cached %s plan", async view => {
  const source = task(), client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });let denied = false;
  await list(`/tasks?view=${view}&month=2026-10`, async filters => {
    if (denied) throw new ApiError(filters.limit === 100 ? "Доступ к плану закрыт" : "Временный сбой списка", filters.limit === 100 ? 403 : 500);
    return { items: [source], next_cursor: null, total: 1, scopes: [], assignees: [] };
  }, client);
  expect(page!.container.textContent).toContain(source.title);const plan = client.getQueryCache().findAll({ queryKey: ["tasks", "planning"] })[0];expect(plan.state.data).toEqual([source]);
  denied = true;await act(async () => { await client.invalidateQueries({ queryKey: ["tasks"] }); });await waitForPage(page!);
  // Deliberately use a cache without dropRefusedData: the component itself must refuse stale data.
  expect(plan.state.data).toEqual([source]);expect((plan.state.error as ApiError).status).toBe(403);
  expect(page!.container.querySelector('[role="alert"]')).not.toBeNull();expect(page!.container.textContent).not.toContain(source.title);expect(page!.container.textContent).not.toContain("Задач в периоде:");expect(page!.container.querySelector('[aria-label="Календарь задач"],[aria-label="Диаграмма Гантта"]')).toBeNull();
});

it("requests a half-open period that includes its final millisecond and excludes the next midnight", async () => {
  const last = task({ task_id: "last-millisecond", starts_at: "2026-11-08T20:59:59.999Z", deadline_at: "2026-11-08T20:59:59.999Z" }), next = task({ task_id: "next-midnight", starts_at: "2026-11-08T21:00:00.000Z", deadline_at: "2026-11-08T22:00:00.000Z" });
  const get = vi.spyOn(tasksApi, "listPage").mockImplementation(async filters => {
    const { date_from, date_to } = filters as { date_from: string; date_to: string };
    return { items: [last, next].filter(item => item.deadline_at !== null && Date.parse(item.deadline_at) >= Date.parse(date_from) && Date.parse(item.starts_at ?? item.deadline_at) < Date.parse(date_to)), next_cursor: null };
  });
  expect((await loadPlanningTasks({}, planningRange("2026-10", "calendar"))).map(item => item.task_id)).toEqual([last.task_id]);
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ date_to: "2026-11-08T21:00:00.000Z" }));
});
