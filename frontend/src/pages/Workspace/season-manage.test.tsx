// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import type { MockRole } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { ApiError } from "../../utils/api/request";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { SeasonBlocker } from "../../utils/api/contract";
import { SeasonPage } from "./SeasonPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
async function mount(element: ReactNode, path: string, role: MockRole = "chair") {
  transport = installMockTransport(role, { delay: 0 });page = await mountWorkspace(element, { path, role });await waitForPage(page);return page;
}
const hub = <Routes><Route path="/seasons/:id" element={<SeasonPage />} /></Routes>;
const menu = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-labelledby]');
const trigger = () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Управление сезоном"))!;
async function press(element: Element) { await act(async () => (element as HTMLElement).click());await waitForPage(page!); }
const item = (name: string) => [...menu()!.querySelectorAll<HTMLElement>("button,a")].find(node => node.textContent?.includes(name))!;

it("opens season management as an anchored menu that closes on Escape and outside clicks", async () => {
  await mount(hub, "/seasons/season-1");
  await press(trigger());expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect([...menu()!.querySelectorAll("button")].map(button => button.textContent)).toEqual(expect.arrayContaining(["Название и период", "Начать подведение итогов"]));
  expect(menu()!.querySelectorAll("form")).toHaveLength(0);
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });await waitForPage(page!);
  expect(menu()).toBeNull();expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await press(trigger());expect(menu()).not.toBeNull();
  await act(async () => { page!.container.querySelector("h1")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });await waitForPage(page!);
  expect(menu()).toBeNull();
});

it("closes the menu on a refused close and groups the blockers above the tabs without loading tasks", async () => {
  const blockers: SeasonBlocker[] = [
    ...Array.from({ length: 12 }, (_, index) => ({ kind: "unfinished_assignment" as const, owner_kind: "assignment", owner_id: `assignment-${index}`, title: "Unfinished", subject: `Задача ${index % 3}`, assignee: "Анна", task_id: `task-${index % 3}` })),
    { kind: "missing_final_report", owner_kind: "event", owner_id: "event-1", title: "Missing", subject: "День математика" },
  ];
  await mount(hub, "/seasons/season-1");
  transport!.state.seasons.find(season => season.season_id === "season-1")!.capabilities = ["close_season"];
  page!.client.setQueryData(["seasons"], { items: transport!.state.seasons.map(season => ({ ...season })) });await waitForPage(page!);
  const command = vi.spyOn(seasonsApi, "command").mockRejectedValue(new ApiError("Season is not ready to close", 409, "season_not_ready", { blockers }));
  await press(trigger());await press(item("Закрыть сезон"));
  expect(command).toHaveBeenCalledWith("season-1", "close", { expected_revision: 1 });
  expect(menu()).toBeNull();
  const panel = page!.container.querySelector<HTMLElement>('section[aria-label="Препятствия закрытию"]')!;
  expect(panel.querySelector('[role="alert"]')?.textContent).toBe("Сезон пока нельзя закрыть: 13 препятствий");
  expect(panel.compareDocumentPosition(page!.container.querySelector('nav[aria-label="Разделы сезона"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const unfinished = panel.querySelector<HTMLElement>('section[aria-label="Незавершённые назначения"]')!;
  expect(unfinished.querySelector("h3")?.textContent).toBe("Незавершённые назначения — 12 (в 3 задачах)");
  expect(unfinished.querySelectorAll("li")).toHaveLength(10);
  expect(unfinished.querySelector("li a")?.getAttribute("href")).toBe("/tasks/task-0?assignment_id=assignment-0&return_season=season-1");
  await press([...unfinished.querySelectorAll("button")].find(button => button.textContent === "Показать все (12)")!);
  expect(unfinished.querySelectorAll("li")).toHaveLength(12);
  expect(panel.querySelector('section[aria-label="Нет итоговых отчётов"] h3')?.textContent).toBe("Нет итоговых отчётов — 1");
  expect(panel.textContent).not.toContain("Ищем назначение");
  expect(transport!.adapter.history.get.some(request => request.url === "/tasks")).toBe(false);
});

it("clears the blockers of a refused close once a later close succeeds", async () => {
  const blockers: SeasonBlocker[] = [{ kind: "missing_final_report", owner_kind: "event", owner_id: "event-1", title: "Missing", subject: "День математика" }];
  await mount(hub, "/seasons/season-1");
  transport!.state.seasons.find(season => season.season_id === "season-1")!.capabilities = ["close_season"];
  page!.client.setQueryData(["seasons"], { items: transport!.state.seasons.map(season => ({ ...season })) });await waitForPage(page!);
  const panel = () => page!.container.querySelector('section[aria-label="Препятствия закрытию"]');
  const command = vi.spyOn(seasonsApi, "command").mockRejectedValueOnce(new ApiError("Season is not ready to close", 409, "season_not_ready", { blockers }));
  await press(trigger());await press(item("Закрыть сезон"));
  expect(panel()?.querySelector("h2")?.textContent).toBe("Сезон пока нельзя закрыть: 1 препятствие");
  command.mockResolvedValueOnce({ ...transport!.state.seasons.find(season => season.season_id === "season-1")!, state: "closed" });
  await press(trigger());await press(item("Закрыть сезон"));
  expect(command).toHaveBeenCalledTimes(2);
  expect(panel()).toBeNull();
  expect(menu()).toBeNull();
});

it("links a closed season to its detailed accruals and corrections", async () => {
  await mount(hub, "/seasons/season-previous");
  transport!.state.seasons.find(season => season.season_id === "season-previous")!.state = "closed";
  transport!.state.seasons.find(season => season.season_id === "season-previous")!.capabilities = [];
  page!.client.setQueryData(["seasons"], { items: transport!.state.seasons.map(season => ({ ...season })) });
  page!.client.setQueryData(["summary", "season-previous"], { ...page!.client.getQueryData<object>(["summary", "season-previous"]), state: "approved", capabilities: ["view_summary", "correct_summary"] });await waitForPage(page!);
  expect(page!.container.querySelector('a[href="/seasons/season-previous/sources"]')?.textContent).toBe("Подробные начисления");
  await press(trigger());
  expect(item("Исправить итоги…").getAttribute("href")).toBe("/seasons/season-previous/corrections");
  expect(menu()!.textContent).not.toContain("Название и период");
});
