// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import type { MockRole } from "../../mocks/fixtures";
import { mountWorkspace, settle, waitForPage } from "../../test/workspace";
import { reportsApi } from "../../utils/api/reports.api";
import { MeetingPage, ReportHistoryPage, ReportPage, ReportsPage } from "./ReportPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });
const routes = <Routes>
  <Route path="/reports" element={<ReportsPage />} />
  <Route path="/reports/history" element={<ReportHistoryPage />} />
  <Route path="/reports/:id" element={<ReportPage />} />
  <Route path="/meetings/:kind/:id" element={<MeetingPage />} />
</Routes>;
async function open(path: string, role: MockRole = "chair") { page = await mountWorkspace(routes, { path, role });await waitForPage(page); }
const heading = () => page!.container.querySelector("h1")?.textContent;
const link = (href: string) => page!.container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
const text = () => page!.container.textContent ?? "";

it("a report names its owner, links back to it and lists the owner's other reports (EV-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const report = mock.state.reports[0], sub = mock.state.subevents.find(item => item.subevent_id === report.owner_id)!;
  await open(`/reports/${report.report_id}`);
  expect(link(`/subevents/${sub.subevent_id}`)?.textContent).toBe(sub.title);
  expect([...page!.container.querySelectorAll("a")].find(item => item.textContent === "Все отчёты")?.getAttribute("href")).toBe(`/reports?owner_kind=subevent&owner_id=${sub.subevent_id}`);
  await page!.cleanup();
  await open(`/reports?owner_kind=subevent&owner_id=${sub.subevent_id}`);
  expect(heading()).toBe(`Отчёты · ${sub.title}`);
  expect(link(`/subevents/${sub.subevent_id}`)?.textContent).toBe(sub.title);
  await page!.cleanup();
  // The mixed list tells reports of different teams apart.
  await open("/reports");
  expect(heading()).toBe("Отчёты");
  expect(page!.container.querySelector("li")?.textContent).toContain(sub.title);
});

it("a meeting page names its team and links back to it (EV-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const sub = mock.state.subevents[0], event = mock.state.events.find(item => item.event_id === sub.event_id)!;
  await open(`/meetings/subevent/${sub.subevent_id}`);
  expect(heading()).toBe(`Созвон команды · ${sub.title}`);
  expect(link(`/subevents/${sub.subevent_id}`)?.textContent).toBe(sub.title);
  await page!.cleanup();
  await open(`/meetings/event/${event.event_id}`);
  expect(heading()).toBe(`Созвоны мероприятия · ${event.title}`);
  expect(link(`/events/${event.event_id}`)?.textContent).toBe(event.title);
});

it("without access a team meeting and its reports are refused, not reported as missing (EV-14)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const sub = mock.state.subevents[0];
  // An outsider of the team: no working access and no capabilities; the server filters its reports out.
  sub.organizer_user_ids = [];sub.leaders = [];sub.capabilities = [];mock.state.reports = [];
  await open(`/meetings/subevent/${sub.subevent_id}`, "organizer");
  expect(text()).toContain("Созвон доступен только команде подмероприятия.");
  expect(text()).not.toContain("Созвон пока не назначен.");
  expect(mock.adapter.history.get.some(request => request.url?.endsWith("/meeting"))).toBe(false);
  await page!.cleanup();
  await open(`/reports?owner_kind=subevent&owner_id=${sub.subevent_id}`, "organizer");
  expect(text()).toContain("Отчёты подмероприятия доступны только его команде.");
  expect(text()).not.toContain("Отчётов пока нет.");
});

it("a closed season explains the missing meetings to the team and to the chair (EV-14)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  // The team keeps working access; capabilities are empty in a closed season.
  mock.state.subevents[0].capabilities = [];
  await open(`/meetings/subevent/${mock.state.subevents[0].subevent_id}`, "organizer");
  expect(text()).toContain("Сезон закрыт: созвоны прошлых сезонов не показываются.");
  await page!.cleanup();mock.restore();
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  event.capabilities = [];mock.state.seasons.find(season => season.season_id === event.season_id)!.state = "closed";
  await open(`/meetings/event/${event.event_id}`);
  expect(text()).toContain("Сезон закрыт: созвоны прошлых сезонов не показываются.");
  expect(text()).not.toContain("Главный созвон доступен только его участникам");
});

it("the report history keeps its list during a background reread (EV-32)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const report = mock.state.reports[0];
  await open(`/reports/history?series_id=${report.report_series_id}`);
  expect(link(`/reports/${report.report_id}`)).not.toBeNull();
  let release!: () => void;
  const history = reportsApi.history;
  vi.spyOn(reportsApi, "history").mockImplementation(async (...args) => { await new Promise<void>(done => { release = done; });return history(...args); });
  await act(async () => { void page!.client.invalidateQueries({ queryKey: ["reports", "history"] }); });await settle();
  expect(page!.client.getQueryState(["reports", "history", report.report_series_id, ""])?.fetchStatus).toBe("fetching");
  expect(link(`/reports/${report.report_id}`)).not.toBeNull();
  expect(text()).not.toContain("Загружаем данные…");
  await act(async () => release());await waitForPage(page!);
});
