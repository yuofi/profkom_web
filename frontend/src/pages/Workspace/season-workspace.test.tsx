// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures, type MockRole } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { SessionContext } from "../../utils/session";
import { api } from "../../utils/api";
import { ApiError } from "../../utils/api/request";
import { kkrApi } from "../../utils/api/kkr.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { SeasonAnalytics as Analytics } from "../../utils/api/contract";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { SeasonCreatePage, SeasonPage, SeasonsPage, SummaryPage } from "./SeasonPages";
import { SeasonAnalytics } from "./SeasonAnalytics";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
let otherCleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;await otherCleanup?.();otherCleanup = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
async function mount(element: ReactNode, path = "/seasons", role: MockRole = "chair") {
  transport = installMockTransport(role, { delay: 0 });if (path.includes("/summary")) transport.state.summary.state="approved";page = await mountWorkspace(element, { path, role });await waitForPage(page);return page;
}
async function click(name: string) { const button = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name);expect(button, name).toBeDefined();await act(async () => button!.click());await waitForPage(page!); }
const analytics = (): Analytics => ({
  season: { season_id: "season-1", title: "Осень 2026", state: "open", starts_at: "2026-10-01T00:00:00Z", ends_at: "2027-01-31T00:00:00Z" }, as_of: "2026-10-27T12:00:00Z", basis: { kind: "current_ledger", version: null, approved_at: null }, filters: { participant_id: null, block_id: null }, participants: [{ participant_id: "person-1", user: createFixtures().user }], blocks: [{ block_id: "it", name: "IT" }],
  totals: { completed_tasks: 1, credited_hours: 3, kkr: -2 }, weekly: [{ starts_on: "2026-10-19", completed_tasks: 1, credited_hours: 3, kkr: -2 }], unallocated: { completed_tasks: 0, credited_hours: 0, kkr: 0, contribution_count: 0 }, source_breakdown: [],
  season_comparison: [{ season_id: "old", title: "Старый сезон", state: "closed", starts_at: "2026-06-01T00:00:00Z", ends_at: "2026-09-01T00:00:00Z", basis: { kind: "approved_snapshot", version: 4, approved_at: "2026-09-01T00:00:00Z" }, totals: { completed_tasks: null, credited_hours: null, kkr: 18 } }], coverage: { accepted_assignments: 1, missing_hours_assignments: 0, undated_accepted_assignments: 0, undated_contributions: 0, notes: ["Исторические часы неизвестны."] },
});
it("keeps creation and global season corrections off the catalog with a dedicated create entry", async () => {
  await mount(<SeasonsPage />);expect(page!.container.querySelectorAll("form")).toHaveLength(0);expect(page!.container.textContent).not.toContain("Исправить ошибочную принадлежность");expect(page!.container.querySelector('section[aria-label="Текущий сезон"]')?.textContent).toContain("Осень и зима 2026");expect(page!.container.querySelector('a[href="/seasons/new"]')?.textContent).toContain("Создать сезон");
});
it("creates through the visual shell with a preview and exact server dates", async () => {
  await mount(<Routes><Route path="/seasons/new" element={<SeasonCreatePage />} /><Route path="/seasons/:id" element={<p>Созданный сезон</p>} /></Routes>, "/seasons/new");
  transport!.state.seasons.splice(transport!.state.seasons.findIndex(season => season.state === "planned"), 1);
  expect(page!.container.querySelector('[aria-label="Предпросмотр сезона"]')).toBeNull();
  await change(field(page!.container, "title"), "Новый сезон из редактора");await change(field(page!.container, "start"), "2027-02-01T12:00");await change(field(page!.container, "end"), "2027-06-01T12:00");await change(field(page!.container, "type"), "winter_spring");
  await click("Показать предпросмотр сезона");expect(page!.container.querySelector('button[aria-controls][aria-pressed="true"]')).not.toBeNull();expect(page!.container.querySelector('[aria-label="Предпросмотр сезона"]')?.textContent).toContain("Новый сезон из редактора");
  await click("Скрыть предпросмотр сезона");expect(page!.container.querySelector('[aria-label="Предпросмотр сезона"]')).toBeNull();expect(field(page!.container, "title").value).toBe("Новый сезон из редактора");expect(field(page!.container, "start").value).toBe("2027-02-01T12:00");
  await submit(page!.container.querySelector("form")!);await waitForPage(page!, () => page!.container.textContent?.includes("Созданный сезон") ?? false, 3000);const request = transport!.adapter.history.post.find(request => request.url === "/seasons")!;expect(JSON.parse(request.data)).toEqual({ title: "Новый сезон из редактора", starts_at: "2027-02-01T09:00:00.000Z", ends_at: "2027-06-01T09:00:00.000Z", type: "winter_spring" });
});
it("opens period editing by pencil and saves the same season with revision and reason", async () => {
  await mount(<Routes><Route path="/seasons/:id" element={<SeasonPage />} /></Routes>, "/seasons/season-1");expect(page!.container.querySelector('input[name="title"]')).toBeNull();expect(page!.container.textContent).not.toContain("Исправление периода");
  await click("Редактировать сезон");expect(field(page!.container, "title").value).toBe("Осень и зима 2026");await change(field(page!.container, "title"), "Уточнённое название");await change(field(page!.container, "reason"), "Исправили название");await submit(page!.container.querySelector("form")!);await waitForPage(page!, () => !page!.container.querySelector('input[name="title"]'));
  const request = transport!.adapter.history.patch.find(request => request.url === "/seasons/season-1")!;expect(JSON.parse(request.data)).toMatchObject({ expected_revision: 1, title: "Уточнённое название", reason: "Исправили название" });expect(page!.container.querySelector("h1")?.textContent).toBe("Уточнённое название");
});
it.each(["organizer", "leader"] as const)("never requests global summary or analytics for %s", async role => {
  await mount(<Routes><Route path="/seasons/:id" element={<SeasonPage />} /></Routes>, "/seasons/season-1?tab=analytics", role);expect(transport!.adapter.history.get.some(request => /\/summary|\/analytics/.test(request.url ?? ""))).toBe(false);expect(page!.container.querySelector('nav[aria-label="Разделы сезона"]')).toBeNull();expect(page!.container.querySelector('button[aria-label="Редактировать сезон"]')).toBeNull();
});
it("keeps the summary deep link and labels evaluated assignments honestly", async () => {
  await mount(<Routes><Route path="/seasons/:id/summary" element={<SummaryPage />} /></Routes>, "/seasons/season-1/summary");expect(page!.container.querySelector('a[aria-current="page"]')?.textContent).toBe("Участники и ККР");expect(page!.container.textContent).toContain("ККР блоков");expect(page!.container.textContent).toContain("посмотреть его начисления");expect(page!.container.querySelectorAll('tbody img').length).toBeGreaterThan(0);expect(page!.container.textContent).not.toContain("Исправить закрытые итоги");
});
it("retains missing history as gaps and sends participant/source filters", async () => {
  const data = analytics();data.totals = { completed_tasks: null, credited_hours: null, kkr: 18 };data.weekly = [];data.basis = { kind: "approved_snapshot", version: 4, approved_at: data.as_of };
  const api = vi.spyOn(seasonsApi, "analytics").mockResolvedValue(data);await mount(<SeasonAnalytics seasonId="season-1" />);expect(page!.container.textContent).toContain("Для этого показателя нет датированных данных");expect(page!.container.textContent).not.toContain("Полнота данных");expect(page!.container.querySelectorAll("strong")[0].textContent).toBe("—");
  await change(field(page!.container, "participant"), "person-1");await waitForPage(page!);await change(field(page!.container, "block"), "it");await waitForPage(page!);expect(api).toHaveBeenLastCalledWith("season-1", { participant_id: "person-1", block_id: "it" });
  await click("По сезонам");expect(page!.container.textContent).toContain("Для этого показателя нет датированных данных");await click("ККР");expect(page!.container.querySelector('svg[aria-label="ККР, по сезонам; баллов"]')).not.toBeNull();
});
it("shows negative values and identifies retrospective work distribution", async () => {
  vi.spyOn(seasonsApi, "analytics").mockResolvedValue(analytics());await mount(<SeasonAnalytics seasonId="season-1" />);await click("ККР");expect(page!.container.querySelector('svg[role="img"] [role="button"]')?.getAttribute("aria-label")).toContain("-2");expect(page!.container.textContent).toContain("не история баланса ККР на каждый день");expect(page!.container.querySelector('svg[role="img"] path')?.getAttribute("d")).not.toMatch(/NaN|Infinity/);
});
it("places weekly observations at their real date distances instead of equal category spacing", async () => {
  const data = analytics();data.weekly = ["2026-10-05", "2026-10-12", "2026-11-09"].map((starts_on, index) => ({ starts_on, completed_tasks: index + 1, credited_hours: index + 1, kkr: index + 1 }));
  vi.spyOn(seasonsApi, "analytics").mockResolvedValue(data);await mount(<SeasonAnalytics seasonId="season-1" />);
  const positions = [...page!.container.querySelectorAll('svg[role="img"] circle')].map(circle => Number(circle.getAttribute("cx")));expect(positions).toHaveLength(3);expect((positions[2] - positions[1]) / (positions[1] - positions[0])).toBeCloseTo(4);
});
it("omits empty future weeks from current observation without mutating or hiding dated facts", async () => {
  const data = analytics();data.weekly = [{ starts_on: "2026-10-19", completed_tasks: 1, credited_hours: 2, kkr: 3 }, { starts_on: "2026-11-02", completed_tasks: 0, credited_hours: 0, kkr: 0 }, { starts_on: "2026-11-09", completed_tasks: 1, credited_hours: 1, kkr: 2 }];
  vi.spyOn(seasonsApi, "analytics").mockResolvedValue(data);await mount(<SeasonAnalytics seasonId="season-1" />);
  expect(page!.container.querySelectorAll('svg[role="img"] circle')).toHaveLength(2);expect([...page!.container.querySelectorAll('svg[role="img"] [role="button"]')].some(point => point.getAttribute("aria-label")?.includes("2 нояб"))).toBe(false);expect(data.weekly).toHaveLength(3);
});
it.each(["seasons", "summary"] as const)("retains a real decision draft through %s refetch503, then removes it on403", async resource => {
  await mount(<Routes><Route path="/seasons/:id/summary" element={<SummaryPage />} /></Routes>, "/seasons/season-1/summary");
  page!.client.setQueryData(["summary","season-1"], {...page!.client.getQueryData<object>(["summary","season-1"]),state:"approved"});await waitForPage(page!);
  await act(async()=>page!.container.querySelector<HTMLButtonElement>('button[aria-label^="Изменить отметки:"]')!.click());await waitForPage(page!,()=>!!document.querySelector('[data-anchored-popover] input[name="reason"]'));
  const disclosure=document.querySelector<HTMLElement>('[data-anchored-popover]')!;
  const form = field(disclosure, "reason").closest("form")!;await change(field(form, "reason"), "Несохранённое основание решения");
  const read = vi.spyOn(api, "request");read.mockRejectedValue(new ApiError("Временная ошибка", 503));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: resource === "seasons" ? ["seasons"] : ["summary", "season-1"] }); });await waitForPage(page!);
  expect(form.isConnected).toBe(true);expect(field(form, "reason").value).toBe("Несохранённое основание решения");expect(page!.container.textContent).toContain("Временная ошибка");
  read.mockRejectedValue(new ApiError("Нет доступа", 403));await act(async () => { await page!.client.invalidateQueries({ queryKey: resource === "seasons" ? ["seasons"] : ["summary", "season-1"] }); });await waitForPage(page!);
  expect(form.isConnected).toBe(false);expect(page!.container.querySelector('input[name="reason"]')).toBeNull();expect(page!.container.textContent).toContain("Нет доступа");
});
it("preserves chart metric and period when participant filters refetch", async () => {
  vi.spyOn(seasonsApi, "analytics").mockResolvedValue(analytics());await mount(<SeasonAnalytics seasonId="season-1" />);await click("ККР");await click("По сезонам");
  await change(field(page!.container, "participant"), "person-1");await waitForPage(page!);
  expect([...page!.container.querySelectorAll("button")].find(button => button.textContent === "ККР")?.getAttribute("aria-pressed")).toBe("true");expect([...page!.container.querySelectorAll("button")].find(button => button.textContent === "По сезонам")?.getAttribute("aria-pressed")).toBe("true");
});
it("guards unsaved creation and never creates a season through Cancel", async () => {
  transport = installMockTransport("chair", { delay: 0 });const create = vi.spyOn(seasonsApi, "create");const container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [{ path: "/seasons/new", element: <SeasonCreatePage /> }, { path: "/seasons", element: <p>Каталог сезонов</p> }] }], { initialEntries: ["/seasons/new"] });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: transport!.state.session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));otherCleanup = async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove(); };
  await change(field(container, "title"), "Несохранённый сезон");const warn = new Event("beforeunload", { cancelable: true });window.dispatchEvent(warn);expect(warn.defaultPrevented).toBe(true);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Отмена")!.click());expect(container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");expect(create).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Остаться")!.click());expect(field(container, "title").value).toBe("Несохранённый сезон");expect(create).not.toHaveBeenCalled();
});
it("shows precise point tooltips on hover, focus and touch clicks, and dismisses them", async () => {
  const data = analytics();data.weekly = [
    { starts_on: "2026-10-05", completed_tasks: 1, credited_hours: 2, kkr: 1 },
    { starts_on: "2026-10-12", completed_tasks: null, credited_hours: null, kkr: null },
    { starts_on: "2026-11-09", completed_tasks: 1, credited_hours: 2, kkr: -12.3456789012345 },
  ];
  vi.spyOn(seasonsApi, "analytics").mockResolvedValue(data);await mount(<SeasonAnalytics seasonId="season-1" />);await click("ККР");
  const chart = page!.container.querySelector('[data-chart-canvas]')!, point = chart.querySelector<SVGElement>('[data-point-key="2026-11-09"]')!;
  expect(chart.querySelector("svg title")).toBeNull();expect(chart.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => point.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  let tooltip = chart.querySelector('[role="tooltip"]')!;expect(tooltip.textContent).toContain("9 ноября 2026");expect(tooltip.textContent).toContain("15 ноября 2026");expect(tooltip.textContent).toContain("-12,3456789012345 баллов");expect(point.getAttribute("aria-describedby")).toBe(tooltip.id);expect(point.getAttribute("aria-pressed")).toBe("true");
  expect(chart.nextElementSibling?.textContent).toBe("2 из 3 периодов с данными");
  await act(async () => point.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));expect(chart.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => point.focus());expect(chart.querySelector('[role="tooltip"]')).not.toBeNull();await act(async () => point.blur());expect(chart.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => point.dispatchEvent(new MouseEvent("click", { bubbles: true })));tooltip = chart.querySelector('[role="tooltip"]')!;expect(tooltip.getAttribute("data-point-key")).toBe("2026-11-09");
  await act(async () => point.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));expect(chart.querySelector('[role="tooltip"]')).toBeNull();
});
it("keeps missing seasonal bars distinct from zero and identifies their full periods", async () => {
  const data = analytics();data.season_comparison[0].totals.kkr = null;data.season_comparison.push({ season_id: "current", title: "Текущий сезон", state: "open", starts_at: "2026-10-01T00:00:00Z", ends_at: "2027-01-31T00:00:00Z", basis: data.basis, totals: { completed_tasks: 1, credited_hours: 3, kkr: -2.25 } });
  vi.spyOn(seasonsApi, "analytics").mockResolvedValue(data);await mount(<SeasonAnalytics seasonId="season-1" />);await click("ККР");await click("По сезонам");
  const chart = page!.container.querySelector('[data-chart-canvas]')!, gap = chart.querySelector<SVGElement>('[data-point-key="old"]')!, negative = chart.querySelector<SVGElement>('[data-point-key="current"]')!;
  await act(async () => gap.dispatchEvent(new MouseEvent("click", { bubbles: true })));expect(chart.querySelector('[role="tooltip"]')?.textContent).toContain("Старый сезон");expect(chart.querySelector('[role="tooltip"]')?.textContent).toContain("1 июня 2026");expect(chart.querySelector('[role="tooltip"]')?.textContent).toContain("Нет данных");expect(chart.querySelector('[role="tooltip"] strong')?.textContent).not.toContain("0");
  await act(async () => negative.focus());expect(chart.querySelector('[role="tooltip"] strong')?.textContent).toBe("-2,25 баллов");expect(chart.querySelector('svg rect[data-negative="true"]')).not.toBeNull();
});
it("clears active chart tooltips when the metric, filters or observations change", async () => {
  const data = analytics(), read = vi.spyOn(seasonsApi, "analytics").mockResolvedValue(data);await mount(<SeasonAnalytics seasonId="season-1" />);
  const activate = async () => { await act(async () => page!.container.querySelector('[data-chart-canvas] [role="button"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));expect(page!.container.querySelector('[role="tooltip"]')).not.toBeNull(); };
  await activate();await click("Учтённые часы");expect(page!.container.querySelector('[role="tooltip"]')).toBeNull();
  await activate();await change(field(page!.container, "participant"), "person-1");await waitForPage(page!);expect(page!.container.querySelector('[role="tooltip"]')).toBeNull();
  await activate();await change(field(page!.container, "participant"), "");await waitForPage(page!);expect(page!.container.querySelector('[role="tooltip"]')).toBeNull();
  await activate();read.mockResolvedValue({ ...data, weekly: data.weekly.map(row => ({ ...row, credited_hours: 7 })) });await act(async () => { await page!.client.invalidateQueries({ queryKey: ["summary", "analytics", "season-1", "", ""] }); });await waitForPage(page!);expect(page!.container.querySelector('[role="tooltip"]')).toBeNull();expect(page!.container.querySelector('[data-chart-canvas] [role="button"]')?.getAttribute("aria-label")).toContain("7 ч");
});

it("does not fetch a collapsed activity chart on the statistics tab",async()=>{
 vi.spyOn(kkrApi,"statistics").mockResolvedValue({items:[],preliminary:true});const read=vi.spyOn(seasonsApi,"analytics");await mount(<Routes><Route path="/seasons/:id" element={<SeasonPage/>}/></Routes>,"/seasons/season-1?tab=analytics");expect(read).not.toHaveBeenCalled();
 const details=[...page!.container.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent==='Динамика задач, часов и ККР')!;
 await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});await waitForPage(page!);expect(read).toHaveBeenCalledTimes(1);
});
