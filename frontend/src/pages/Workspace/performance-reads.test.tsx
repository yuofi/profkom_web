// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TrackerListPage } from "./TrackerList";
import { CalendarPage } from "./WorkspacePages";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, settle } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { createFixtures } from "../../mocks/fixtures";
import type { TaskListPageResponse } from "../../utils/api/contract";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks();vi.useRealTimers(); });
async function openFilters(label: string) {
  const details = [...page!.container.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent?.includes(label))!;
  await act(async () => { details.open = true;details.dispatchEvent(new Event("toggle")); });
  await waitForPage(page!);
}

it("loads calendar filter directories only on opening the filter pane", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const blocks = vi.spyOn(membershipApi, "blocks"), events = vi.spyOn(eventsApi, "list"), queues = vi.spyOn(taskQueuesApi, "catalog");
  page = await mountWorkspace(<CalendarPage />, { path: "/calendar" });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Календарь месяца"]')).not.toBeNull();
  expect(blocks).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();expect(queues).not.toHaveBeenCalled();
  await openFilters("Фильтры календаря");
  expect(blocks).toHaveBeenCalledOnce();expect(events).toHaveBeenCalledOnce();expect(queues).toHaveBeenCalledOnce();
  expect(page.client.getQueryCache().find({ queryKey: ["tasks", "queues", "catalog"], exact: true })).toBeDefined();
  expect(page.client.getQueryCache().find({ queryKey: ["tasks", "queues"], exact: true })).toBeUndefined();
});

it("keeps tracker people and season filter reads behind the filter pane", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const people = vi.spyOn(directoryApi, "contacts"), seasons = vi.spyOn(seasonsApi, "list");
  page = await mountWorkspace(<TrackerListPage />, { path: "/tasks" });await waitForPage(page);
  expect(people).not.toHaveBeenCalled();expect(seasons).not.toHaveBeenCalled();
  await openFilters("Добавить фильтр");
  expect(people).toHaveBeenCalledOnce();expect(seasons).toHaveBeenCalledOnce();
});

it("does not build an unused list page in a planning view and gets one-card facets only when asked", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const read = vi.spyOn(tasksApi, "listPage");
  page = await mountWorkspace(<TrackerListPage />, { path: "/tasks?view=calendar&month=2026-10" });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Календарь задач"]')).not.toBeNull();
  expect(read.mock.calls.every(call => (call[0] as { limit: number }).limit === 100)).toBe(true);
  await openFilters("Добавить фильтр");
  expect(read.mock.calls.some(call => (call[0] as { limit: number }).limit === 1)).toBe(true);
  expect(read.mock.calls.some(call => (call[0] as { limit: number }).limit === 20)).toBe(false);
});

it("coalesces rapid tracker search input and cancels an older in-flight search without showing its late result", async () => {
  mock = installMockTransport("chair", { delay: 0 });const fixture = createFixtures("chair").tasks[0];
  const response = (title: string): TaskListPageResponse => ({ items: [{ ...fixture, title }], next_cursor: null, scopes: [], assignees: [] });
  let oldSignal: AbortSignal | undefined, releaseOld!: (value: TaskListPageResponse) => void;
  const read = vi.spyOn(tasksApi, "listPage").mockImplementation(async (params, signal) => {
    const q = (params as { q?: string }).q;
    if (q === "first") { oldSignal = signal;return new Promise(resolve => { releaseOld = resolve; }); }
    return response(q || "Начальная задача");
  });
  page = await mountWorkspace(<TrackerListPage />, { path: "/tasks" });await waitForPage(page);
  const input = page.container.querySelector<HTMLInputElement>('[aria-label="Поиск задач"]')!;
  vi.useFakeTimers();
  for (const value of ["f", "fi", "fir", "firs", "first"]) {
    await change(input, value);await act(async () => { vi.advanceTimersByTime(100); });
  }
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(250); });
  expect(oldSignal).toBeInstanceOf(AbortSignal);expect(oldSignal?.aborted).toBe(false);
  await change(input, "second");await act(async () => { vi.advanceTimersByTime(250); });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { releaseOld(response("Старый ответ не показывать")); });
  vi.useRealTimers();await settle();await waitForPage(page!);
  expect(page.container.textContent).toContain("second");expect(page.container.textContent).not.toContain("Старый ответ не показывать");
  expect(read.mock.calls.map(call => (call[0] as { q?: string }).q ?? "")).toEqual(["", "first", "second"]);
});

it("forwards cancellation through the actual Axios read boundary", async () => {
  const { api } = await import("../../utils/api/index");
  const { CanceledError } = await import("axios");
  const previous = api.defaults.adapter, controller = new AbortController();let observed: unknown, cancelled = false;
  api.defaults.adapter = config => new Promise((_resolve, reject) => {
    observed = config.signal;
    config.signal?.addEventListener?.("abort", () => { cancelled = true;reject(new CanceledError("aborted")); });
  });
  try {
    const pending = tasksApi.listPage({ q: "obsolete" }, controller.signal);
    await Promise.resolve();await Promise.resolve();
    expect(observed).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: "Запрос отменён" });
    expect(cancelled).toBe(true);
  } finally { api.defaults.adapter = previous; }
});

it("does not reveal cached calendar directory options while a reopened filter is refused", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const name = mock.state.blocks[0].name;
  const blocks = vi.spyOn(membershipApi, "blocks");
  page = await mountWorkspace(<CalendarPage />, { path: "/calendar" });await waitForPage(page);
  await openFilters("Фильтры календаря");
  const picker = () => [...page!.container.querySelectorAll<HTMLElement>('[data-entity-picker]')].find(item => item.textContent?.startsWith("Блок"))!;
  const input = picker().querySelector<HTMLInputElement>('[role="combobox"]')!;expect(input).not.toBeNull();
  await act(async () => input.click());await waitForPage(page);
  expect(document.querySelector('[data-entity-picker-popup]')?.textContent).toContain(name);
  const details = [...page.container.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent?.includes("Фильтры календаря"))!;
  await act(async () => { details.open = false;details.dispatchEvent(new Event("toggle")); });
  await settle();
  expect(document.querySelector('[data-entity-picker-popup]')?.textContent ?? "").not.toContain(name);
  const { ApiError } = await import("../../utils/api/request");
  let refuse!: (error: unknown) => void;
  blocks.mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["workspaceBlocks"], refetchType: "none" }); });
  await act(async () => { details.open = true;details.dispatchEvent(new Event("toggle")); });
  await settle();
  expect(document.querySelector('[data-entity-picker-popup]')?.textContent ?? "").not.toContain(name);
  await act(async () => refuse(new ApiError("Нет доступа", 403)));
  await waitForPage(page);
  expect(document.querySelector('[data-entity-picker-popup]')?.textContent ?? "").not.toContain(name);
});
