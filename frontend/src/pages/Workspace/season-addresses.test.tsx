// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures, type MockRole } from "../../mocks/fixtures";
import { change, mountWorkspace, waitForPage } from "../../test/workspace";
import { kkrApi } from "../../utils/api/kkr.api";
import { SeasonPage, SeasonsPage, SummaryPage } from "./SeasonPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
function Where() { const location = useLocation();return <output data-where>{location.pathname + location.search}</output>; }
async function mount(element: ReactNode, path: string, role: MockRole = "chair") {
  await page?.cleanup();transport?.restore();
  transport = installMockTransport(role, { delay: 0 });page = await mountWorkspace(<>{element}<Where /></>, { path, role });await waitForPage(page);return page;
}
const where = () => page!.container.querySelector("[data-where]")?.textContent;
const routes = <Routes><Route path="/seasons" element={<SeasonsPage />} /><Route path="/seasons/:id/summary" element={<SummaryPage />} /><Route path="/seasons/:id" element={<SeasonPage />} /></Routes>;

it("replaces the old summary address with the season's own one", async () => {
  await mount(routes, "/seasons/season-1/summary");
  expect(where()).toBe("/seasons/season-1");
  expect(page!.container.querySelector('nav[aria-label="Разделы сезона"] a[aria-current="page"]')?.textContent).toBe("Участники и ККР");
  expect(page!.container.querySelector('[role="status"]')).toBeNull();
});

it("says why the summary is absent when the old address is opened without the right", async () => {
  await mount(routes, "/seasons/season-1/summary", "organizer");
  expect(where()).toBe("/seasons/season-1");
  expect(page!.container.querySelector('[role="status"]')?.textContent).toBe("Итоги сезона доступны председателю, заместителям и HR.");
});

it("addresses the participants tab without a query and keeps the other tabs across seasons", async () => {
  await mount(routes, "/seasons/season-1?tab=history");
  const select = page!.container.querySelector<HTMLSelectElement>('select[aria-label="Выбранный сезон"]')!;
  await change(select, "season-previous");await waitForPage(page!);
  expect(where()).toBe("/seasons/season-previous?tab=history");
  await mount(routes, "/seasons/season-1");
  await change(page!.container.querySelector<HTMLSelectElement>('select[aria-label="Выбранный сезон"]')!, "season-previous");await waitForPage(page!);
  expect(where()).toBe("/seasons/season-previous");
  expect(page!.container.querySelector('nav[aria-label="Разделы сезона"] a')?.getAttribute("href")).toBe("/seasons/season-previous");
});

it("leaves out the participants preview on the participants tab and keeps it on the others", async () => {
  await mount(routes, "/seasons/season-1");
  const workflow = () => [...page!.container.querySelectorAll("details")].find(details => details.textContent?.startsWith("Работа сезона"))!;
  workflow().open = true;workflow().dispatchEvent(new Event("toggle"));await waitForPage(page!);
  expect(workflow().textContent).not.toContain("Участники сезона");
  await mount(routes, "/seasons/season-1?tab=history");
  workflow().open = true;workflow().dispatchEvent(new Event("toggle"));await waitForPage(page!);
  expect(workflow().textContent).toContain("Участники сезона");
  expect([...workflow().querySelectorAll("a")].find(link => link.textContent?.includes("Все участники"))?.getAttribute("href")).toBe("/seasons/season-1");
});

it("names the section like the menu and does not link the stamp to the page itself", async () => {
  await mount(routes, "/seasons");
  const stamp = [...page!.container.querySelectorAll("header *")].find(node => node.textContent?.startsWith("Профком ВМК ·") && node.children.length === 0)!;
  expect(stamp.textContent).toBe("Профком ВМК · Сезоны и ККР");
  expect(stamp.tagName).not.toBe("A");
  await mount(routes, "/seasons/season-1");
  expect(page!.container.querySelector('a[href="/seasons"]')?.textContent).toBe("Профком ВМК · Сезоны и ККР");
});

it("filters the season's events by the season and shows a closed one in the archive", async () => {
  await mount(routes, "/seasons/season-1?tab=history");
  const workflow = () => [...page!.container.querySelectorAll("details")].find(details => details.textContent?.startsWith("Работа сезона"))!;
  workflow().open = true;workflow().dispatchEvent(new Event("toggle"));await waitForPage(page!);
  const events = () => [...workflow().querySelectorAll("a")].find(link => link.textContent?.startsWith("Мероприятия"))?.getAttribute("href");
  expect(events()).toBe("/events?season_id=season-1");
  transport!.state.seasons.find(season => season.season_id === "season-1")!.state = "closed";
  await page!.client.invalidateQueries({ queryKey: ["seasons"] });await waitForPage(page!);
  expect(events()).toBe("/events?season_id=season-1&archive=true");
});

it("offers an event head the season's merits from the overview", async () => {
  const session = createFixtures("organizer").session;
  const head = { ...session, capabilities: session.capabilities.filter(cap => cap !== "view_summary" && !cap.includes("merit")), assignments: [{ role_assignment_id: "role-head", role: "event_leader", scope_kind: "event" as const, scope_id: "event-1", revision: 1, capabilities: ["create_head_merit", "view_merits"] }] };
  await page?.cleanup();transport?.restore();
  transport = installMockTransport("organizer", { delay: 0 });page = await mountWorkspace(<>{routes}<Where /></>, { path: "/seasons/season-1", session: head });await waitForPage(page);
  expect([...page.container.querySelectorAll("a")].find(link => link.textContent?.startsWith("Заслуги и волонтёрство"))?.getAttribute("href")).toBe("/seasons/season-1/merits");
});

it.each(["chair", "chair-deputy", "hr", "hr-deputy"] as const)("puts the one season switcher on the header's crumbs line of every tab for %s (D-07)", async role => {
  vi.spyOn(kkrApi, "controls").mockResolvedValue({ capabilities: [], items: [] });vi.spyOn(kkrApi, "statistics").mockResolvedValue({ items: [], preliminary: true });
  for (const tab of ["", "?tab=analytics", "?tab=history", "?tab=control"]) {
    await mount(routes, `/seasons/season-1${tab}`, role);
    const select = page!.container.querySelector<HTMLSelectElement>('header select[aria-label="Выбранный сезон"]')!;
    expect(select.value).toBe("season-1");
    // Right after the crumbs, above the title, and nowhere else on the page.
    const label = select.closest("label")!;
    expect(label.firstChild?.textContent).toBe("Сезон");
    expect(label.previousElementSibling?.getAttribute("aria-label")).toBe("Путь сезона");
    expect(label.parentElement?.nextElementSibling?.tagName).toBe("H1");
    expect(page!.container.querySelectorAll('select[aria-label="Выбранный сезон"]')).toHaveLength(1);
    expect(page!.container.querySelector('nav[aria-label="Разделы сезона"]')).not.toBeNull();
  }
});

it("shows an ordinary member the season's path without the switcher and the tabs (D-07)", async () => {
  await mount(routes, "/seasons/season-1", "organizer");
  expect(page!.container.querySelector('nav[aria-label="Путь сезона"]')).not.toBeNull();
  expect(page!.container.querySelector('select[aria-label="Выбранный сезон"]')).toBeNull();
  expect(page!.container.querySelector('nav[aria-label="Разделы сезона"]')).toBeNull();
});

it("fades an edge of the tabs only while more of them lie beyond it (D-07)", async () => {
  await mount(routes, "/seasons/season-1");
  const nav = page!.container.querySelector<HTMLElement>('nav[aria-label="Разделы сезона"]')!;
  // jsdom lays nothing out: a line that fits has no fade.
  expect(nav.hasAttribute("data-more")).toBe(false);
  let left = 0;
  Object.defineProperties(nav, { scrollWidth: { configurable: true, get: () => 520 }, clientWidth: { configurable: true, get: () => 340 }, scrollLeft: { configurable: true, get: () => left, set: (value: number) => { left = value; } } });
  await act(async () => { nav.dispatchEvent(new Event("scroll")); });
  expect(nav.getAttribute("data-more")).toBe("true");expect(nav.hasAttribute("data-before")).toBe(false);
  left = 90;await act(async () => { nav.dispatchEvent(new Event("scroll")); });
  expect(nav.getAttribute("data-more")).toBe("true");expect(nav.getAttribute("data-before")).toBe("true");
  left = 180;await act(async () => { nav.dispatchEvent(new Event("scroll")); });
  expect(nav.hasAttribute("data-more")).toBe(false);expect(nav.getAttribute("data-before")).toBe("true");
});

it("brings the current tab out of the faded edge of a phone's tab line (D-07)", async () => {
  vi.spyOn(kkrApi, "controls").mockResolvedValue({ capabilities: [], items: [] });
  await mount(routes, "/seasons/season-1");
  const nav = page!.container.querySelector<HTMLElement>('nav[aria-label="Разделы сезона"]')!;
  let left = 0;
  Object.defineProperty(nav, "scrollLeft", { configurable: true, get: () => left, set: (value: number) => { left = value; } });
  nav.getBoundingClientRect = () => ({ left: 0, right: 340 }) as DOMRect;
  const control = [...nav.querySelectorAll("a")].find(link => link.textContent === "Заполнение ККР")!;
  control.getBoundingClientRect = () => ({ left: 330, right: 470 }) as DOMRect;
  await act(async () => control.click());await waitForPage(page!);
  expect(where()).toBe("/seasons/season-1?tab=control");
  // Past the right edge by 130 px, plus the 36 px of the fade.
  expect(left).toBe(166);
});
