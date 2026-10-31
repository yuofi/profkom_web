// @vitest-environment jsdom
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { workspaceQueryCache } from "../../utils/api/invalidation";
import { seasonsApi } from "../../utils/api/seasons.api";
import { supportApi } from "../../utils/api/support.api";
import type { BlockRequest, Contribution } from "../../utils/api/contract";
import { SeasonBlockerLink } from "../../components/Workspace/SeasonBlockerLink";
import { SupportTaskPanel } from "../../components/Workspace/SupportTaskPanel";
import { ProfileAchievements } from "../../components/Workspace/ProfileAchievements";
import { MeritsPage } from "./MeritPages";
import { EventPage, SubeventPage } from "./EventPages";
import { BlockPage, BlockRequestsPage } from "./MembershipPages";
import { SeasonParticipants } from "./SeasonParticipants";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks();vi.useRealTimers(); });
/** As in production: no staleTime, so a second observer of a stale key would read again. */
const productionClient = () => new QueryClient({ queryCache: workspaceQueryCache(), defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const gets = (url: string | RegExp) => mock!.adapter.history.get.filter(request => typeof url === "string" ? request.url === url : url.test(request.url ?? ""));
const button = (text: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
async function open(details: HTMLDetailsElement) {
  await act(async () => { details.open = true;details.dispatchEvent(new Event("toggle")); });
  await waitForPage(page!);
}

it("reads the merit scopes of the season once and shares them with every editor (PB-11)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits", client: productionClient() });
  await waitForPage(page, () => !!page!.container.querySelector('[data-field-name="scope"]'));
  expect(gets("/merits/contexts")).toHaveLength(1);
  expect(gets("/merits/contexts")[0].params).toEqual({ season_id: "season-1" });
  expect(gets(/\/subevents$/)).toHaveLength(0);expect(gets("/events")).toHaveLength(0);expect(gets("/blocks")).toHaveLength(0);
  expect(page.container.textContent).toContain("Учесть выполненную работу");
});

it("shows event and subevent deputies from the response and reads the directory only for an editor (PF-13)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>, { path: "/events/event-1" });
  await waitForPage(page, () => page!.container.textContent!.includes("День математика"));
  expect(gets("/events/event-1").every(request => request.params?.include_deputies === true)).toBe(true);
  expect(page.container.textContent).toContain("Дарья Белова");expect(page.container.textContent).not.toContain("Участник #105");
  expect(gets("/contacts")).toHaveLength(0);
  const editor = [...page.container.querySelectorAll<HTMLDetailsElement>("details")].find(item => item.querySelector("summary")?.textContent === "Заместители")!;
  await open(editor);
  expect(gets("/contacts")).toHaveLength(1);
  expect(editor.querySelector("form")).not.toBeNull();
  await page.cleanup();
  mock.restore();mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>, { path: "/subevents/subevent-1" });
  await waitForPage(page, () => page!.container.textContent!.includes("Лекции и встречи"));
  expect(gets("/subevents/subevent-1")[0].params).toEqual({ include_deputies: true });
  expect(page.container.textContent).toContain("Дарья Белова");
  expect(gets("/contacts")).toHaveLength(0);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Изменить состав организаторов"]')!.click());await waitForPage(page);
  expect(gets("/contacts")).toHaveLength(1);
});

it("reads only the own requests to a block and no directory without the master form (PB-22, PF-13)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: "/blocks/block-info", role: "organizer" });
  await waitForPage(page, () => page!.container.textContent!.includes("Состав блока"));
  const requests = gets("/block-requests");
  expect(requests).toHaveLength(1);expect(String(requests[0].params)).toBe("block_id=block-info&mine=true");
  expect(gets("/contacts")).toHaveLength(0);
});

it("decides from the open list, keeps own closed requests and pages the rest of the history (PB-22)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const others = mock.state.people.filter(person => person.user_id !== mock!.state.session.user_id);
  const closed = (index: number, user = others[index % others.length]): BlockRequest => ({ ...structuredClone(mock!.state.requests[0]), request_id: `closed-${String(index).padStart(2, "0")}`, user, state: "rejected", created_at: `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00Z`, substitute_available_at: null, capabilities: [] });
  mock.state.requests.push(...Array.from({ length: 24 }, (_, index) => closed(index)), { ...closed(25), request_id: "own-closed", user: { user_id: mock.state.session.user_id, display_name: "Я сам", avatar_url: null } });
  page = await mountWorkspace(<BlockRequestsPage />);
  await waitForPage(page);
  const params = gets("/block-requests").map(request => String(request.params));
  expect(params).toEqual(expect.arrayContaining(["state=pending_hr&state=pending_block", "mine=true&state=approved&state=rejected&state=withdrawn", "limit=20&state=approved&state=rejected&state=withdrawn"]));
  expect(page.container.querySelector('[aria-label="Этап мастера — моё решение"]')?.textContent).toContain(mock.state.people[4].display_name);
  expect(page.container.querySelector('[aria-label="Мои заявки"]')?.textContent).toContain("Я сам");
  const history = [...page.container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.startsWith("История"))!;
  expect(history.querySelector("summary")?.textContent).toBe("История · 20");
  await act(async () => button("Показать ещё")!.click());await waitForPage(page);
  expect(String(gets("/block-requests").at(-1)!.params)).toBe("limit=20&cursor=mock%3A20&state=approved&state=rejected&state=withdrawn");
  expect(history.querySelector("summary")?.textContent).toBe("История · 24");
  expect(button("Показать ещё")).toBeUndefined();
});

it("links participant work and readiness blockers by the server task_id without paging tasks (PF-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const summary = structuredClone(mock.state.summary), row = summary.rows[0];
  const contribution = (id: string, task_id: string | null): Contribution => ({ contribution_id: id, season_id: "season-1", participant_id: row.participant_id, user: row.user, source_kind: "block_task", source_id: "block-info", source_title: `Работа ${id}`, score: 1, calculation_version: "test", assignment_inputs: { assignment_id: `assignment-${id}`, hours: 1, evaluation: 1, effective_completed_at: null, task_id, revision: 1, capabilities: [] }, capabilities: [] });
  const assessments = vi.spyOn(seasonsApi, "assessments").mockResolvedValue({ items: [contribution("open", "task-open"), contribution("hidden", null)], next_cursor: null });
  page = await mountWorkspace(<SeasonParticipants summary={summary} />);
  await act(async () => button("Начисления и работа →")!.click());await waitForPage(page);
  expect(assessments).toHaveBeenCalledWith({ season_id: "season-1", participant_id: row.participant_id, include_task_ids: true });
  const links = [...document.querySelectorAll<HTMLAnchorElement>("a")].filter(link => link.textContent === "Открыть задачу и её учёт →");
  expect(links.map(link => link.getAttribute("href"))).toEqual(["/tasks/task-open?assignment_id=assignment-open&return_season=season-1"]);
  expect(gets("/tasks")).toHaveLength(0);
  await page.cleanup();
  page = await mountWorkspace(<>
    <SeasonBlockerLink seasonId="season-1" blocker={{ kind: "missing_assessment", owner_kind: "assignment", owner_id: "a-1", title: "Нет оценки", task_id: "task-1" }} />
    <SeasonBlockerLink seasonId="season-1" blocker={{ kind: "missing_assessment", owner_kind: "assignment", owner_id: "a-2", title: "Нет оценки", task_id: null }} />
  </>);
  await waitForPage(page);
  expect([...page.container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/tasks/task-1?assignment_id=a-1&return_season=season-1"]);
  expect(page.container.textContent).toContain("Объект недоступен");
  expect(gets("/tasks")).toHaveLength(0);expect(gets(/readiness$/)).toHaveLength(0);
});

it("shows the award catalogue expander from the cheap flags and reads the context only when opened (PF-15)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<ProfileAchievements userId={102} />);
  await waitForPage(page);
  expect(gets("/profile/me/features-flags")).toHaveLength(1);expect(gets("/profile/me/features-context")).toHaveLength(0);
  const catalogue = [...page.container.querySelectorAll<HTMLDetailsElement>("details")].find(item => item.querySelector("summary")?.textContent === "Каталог и управление наградами")!;
  expect(catalogue).toBeDefined();
  await open(catalogue);
  expect(gets("/profile/me/features-context")).toHaveLength(1);
  expect(button("Создать награду")).toBeDefined();
});

it("does not reload an opened support screenshot on a timer (PF-22)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(supportApi, "task").mockResolvedValue({ task_id: "task-1", can_triage: true, diagnostics: {}, diagnostics_expired: false, has_screenshot: true, notes: [] } as unknown as Awaited<ReturnType<typeof supportApi.task>>);
  const screenshot = vi.spyOn(supportApi, "screenshot").mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  Object.assign(URL, { createObjectURL: () => "blob:screenshot", revokeObjectURL: () => {} });
  page = await mountWorkspace(<SupportTaskPanel task={mock.state.tasks[0]} />, { client: productionClient() });
  await waitForPage(page);
  vi.useFakeTimers();
  await act(async () => button("Открыть приложенное изображение")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
  expect(screenshot).toHaveBeenCalledOnce();
});
