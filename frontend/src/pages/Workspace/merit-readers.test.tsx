// @vitest-environment jsdom
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { WorkspaceLayout } from "../../components/Workspace/WorkspaceLayout";
import { sectionOf } from "../../components/Workspace/sections";
import { emptyCriteria, richText, type Session } from "../../utils/api/contract";
import { ApiError } from "../../utils/api/request";
import { seasonsApi } from "../../utils/api/seasons.api";
import { MeritEntryPage, MeritsPage } from "./MeritPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });

/** A block master: no summary and no creation rights, only the scoped right to read the block's merits. */
function blockReader(): Session {
  const session = createFixtures("organizer").session;
  return { ...session, capabilities: session.capabilities.filter(cap => cap !== "view_summary" && !cap.includes("merit")),
    assignments: [{ role_assignment_id: "role-master", role: "block_master", scope_kind: "block", scope_id: "block-it", revision: 1, capabilities: ["view_merits"] }] };
}
const routes = <Routes><Route element={<WorkspaceLayout />}>
  <Route path="/merits" element={<MeritEntryPage />} />
  <Route path="/seasons/:id/merits" element={<MeritsPage />} />
</Route></Routes>;
async function mount(path: string, session = blockReader()) {
  // The chair records the block's work; the reader then opens the page on the same data.
  mock = installMockTransport("chair", { delay: 0 });
  await seasonsApi.createMerit({ season_id: "season-1", source_kind: "block_volunteer", scope: { kind: "block", id: "block-it" }, title: "Волонтёрство IT",
    description: richText("Помощь блоку"), assigned_at: "2026-10-01T10:00:00Z", deadline_at: "2026-10-10T10:00:00Z", criteria: emptyCriteria(),
    recipients: [{ user_id: 101, hours: 2, evaluation: 1, completed_at: "2026-10-02T10:00:00Z" }] });
  const merits = structuredClone(mock.state.merits);mock.restore();
  mock = installMockTransport("organizer", { delay: 0 });mock.state.merits.splice(0, mock.state.merits.length, ...merits);mock.state.session = session;
  page = await mountWorkspace(routes, { path, session });await waitForPage(page);return page;
}
const meritRequests = () => mock!.adapter.history.get.filter(request => request.url === "/merits");

it("asks the server for the merits a scoped reader sees and offers them in the menu", async () => {
  await mount("/seasons/season-1/merits");
  expect(meritRequests().length).toBeGreaterThan(0);
  expect(page!.container.textContent).toContain("Волонтёрство IT");
  expect(page!.container.textContent).not.toContain("Нет доступа");
  expect(page!.container.querySelector('nav[aria-label="Основная навигация"] a[href="/merits"]')).not.toBeNull();
});

it("tells an empty list apart from a refusal", async () => {
  await mount("/seasons/season-1/merits");
  mock!.state.merits.splice(0);await page!.client.invalidateQueries({ queryKey: ["merits", "season-1"] });await waitForPage(page!);
  expect(page!.container.textContent).toContain("Записей пока нет.");
  expect(page!.container.textContent).not.toContain("Нет доступа");
  vi.spyOn(seasonsApi, "merits").mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));
  await page!.client.resetQueries({ queryKey: ["merits", "season-1"] });await waitForPage(page!);
  expect(page!.container.textContent).toContain("Нет доступа к исходным полям.");
});

it("lists seasons, closed ones too, for a reader without creation rights", async () => {
  await mount("/merits");
  const links = [...page!.container.querySelectorAll<HTMLAnchorElement>('main a[href^="/seasons/"]')].map(link => link.getAttribute("href"));
  expect(links).toEqual(expect.arrayContaining(["/seasons/season-1/merits", "/seasons/season-previous/merits"]));
  expect(page!.container.textContent).not.toContain("Нет доступных сезонов");
});

it("opens the only eligible season at once and keeps the requested scope", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const where: string[] = [];
  function Where() { const location = useLocation();where.push(location.pathname + location.search);return null; }
  page = await mountWorkspace(<><Routes><Route path="/merits" element={<MeritEntryPage />} /><Route path="/seasons/:id/merits" element={<p>Заслуги сезона</p>} /></Routes><Where /></>, { path: "/merits?source_kind=head_merit&scope_id=event-1" });
  await waitForPage(page);
  expect(where.at(-1)).toBe("/seasons/season-1/merits?source_kind=head_merit&scope_id=event-1");
  expect(page.container.textContent).toContain("Заслуги сезона");
});

it("opens the season where the chair records work straight from the menu item", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  // One open season, as on a real site: the previous one is closed, the next one planned.
  mock.state.seasons.find(season => season.season_id === "season-previous")!.state = "closed";
  const where: string[] = [];
  function Where() { const location = useLocation();where.push(location.pathname + location.search);return null; }
  page = await mountWorkspace(<><Routes><Route path="/merits" element={<MeritEntryPage />} /><Route path="/seasons/:id/merits" element={<p>Заслуги сезона</p>} /></Routes><Where /></>, { path: "/merits" });
  await waitForPage(page);
  expect(where.at(-1)).toBe("/seasons/season-1/merits");
  expect(page.container.textContent).toContain("Заслуги сезона");
});

it("offers the menu item and the seasons to a block HR curator without a role assignment there", async () => {
  const session = blockReader();
  await mount("/merits", { ...session, capabilities: [...session.capabilities, "view_merits"], assignments: [] });
  expect(page!.container.querySelector('nav[aria-label="Основная навигация"] a[href="/merits"]')).not.toBeNull();
  const links = [...page!.container.querySelectorAll<HTMLAnchorElement>('main a[href^="/seasons/"]')].map(link => link.getAttribute("href"));
  expect(links).toEqual(expect.arrayContaining(["/seasons/season-1/merits", "/seasons/season-previous/merits"]));
  expect(page!.container.textContent).not.toContain("Нет доступных сезонов");
});

it("puts a season's merits under the menu item of merits", () => {
  expect(sectionOf("/seasons/season-1/merits").label).toBe("Учёт выполненной работы");
  expect(sectionOf("/seasons/season-1").label).toBe("Сезоны и ККР");
  expect(sectionOf("/seasons/season-1/sources").label).toBe("Сезоны и ККР");
  expect(sectionOf("/merits").label).toBe("Учёт выполненной работы");
  expect(sectionOf("/eventsfoo").label).toBe("Рабочее пространство");
  expect(sectionOf("/subevents/x").label).toBe("Мероприятия");
});
