// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { workspaceApi } from "../../utils/api/workspace.api";
import { CalendarPage, DashboardPage } from "./WorkspacePages";
import { CalendarTimeGrid } from "./CalendarViews";
import { EventsListPage } from "./EventPages";
import type { CalendarItem } from "../../utils/api/contract";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks();vi.useRealTimers(); });
function Location() { return <output data-location>{useLocation().search}</output>; }
function seed() { vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(new Date("2026-10-29T11:00:00Z"));mock = installMockTransport("chair", { delay: 0 });return mock; }
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label || button.getAttribute("aria-label") === label)!;
async function click(label: string) { await act(async () => button(label).click());await waitForPage(page!); }
it("keeps an empty Today widget as a complete shared day calendar", async () => {
  seed();vi.spyOn(workspaceApi, "home").mockResolvedValue({ today: "2026-10-29", agenda: [], tasks: [], overdue_tasks: [], overdue_count: 0, approvals: [], merit_entries: [] });
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  const today = page.container.querySelector('[aria-label="Календарь дня"]')!;
  expect(today).not.toBeNull();expect(today.querySelector('[aria-label="Шкала часов"]')?.children).toHaveLength(24);
  expect(today.className).toContain("timelineCompact");expect(today.querySelector('[class*="timelineScroller"]')).not.toBeNull();
  expect(today.textContent).toContain("00:00");expect(today.textContent).toContain("23:00");expect(today.textContent).toContain("Весь день");
  expect([...page.container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toContain("/calendar?view=day&date=2026-10-29");
});
it.each([
  { mode: "day", days: ["2026-10-29"] },
  { mode: "week", days: ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"] },
])("keeps the full $mode grid in page flow without automatic scrolling", async ({ days }) => {
  seed();const internalScroll = vi.spyOn(Element.prototype, "scrollTop", "set"), pageScroll = vi.spyOn(window, "scrollTo");
  page = await mountWorkspace(<CalendarTimeGrid days={days} items={[]} today="2026-10-29" seasonTitle={() => "Сезон"} />);await waitForPage(page);
  expect(page.container.querySelector('[class*="timelineBody"]')).not.toBeNull();expect(page.container.querySelector('[class*="timelineScroller"]')).toBeNull();
  expect(page.container.querySelector('[aria-label="Шкала часов"]')?.children).toHaveLength(24);
  expect(page.container.textContent).toContain("00:00");expect(page.container.textContent).toContain("23:00");
  expect(internalScroll).not.toHaveBeenCalled();expect(pageScroll).not.toHaveBeenCalled();
});
it("preserves Today hour scrolling through data refresh and only recenters for a new day", async () => {
  seed();const internalScroll = vi.spyOn(Element.prototype, "scrollTop", "set"), pageScroll = vi.spyOn(window, "scrollTo");
  function Today() {
    const [day, setDay] = useState("2026-10-29"), [items, setItems] = useState<CalendarItem[]>([]);
    return <><CalendarTimeGrid compact days={[day]} items={items} today="2026-10-29" seasonTitle={() => "Сезон"} />
      <button onClick={() => setItems([...items])}>Обновить данные</button><button onClick={() => setDay("2026-10-30")}>Изменить день</button></>;
  }
  page = await mountWorkspace(<Today />);await waitForPage(page);
  expect(internalScroll).toHaveBeenCalledTimes(1);expect(internalScroll).toHaveBeenLastCalledWith(12 * 48);
  const scroller = page.container.querySelector<HTMLElement>('[class*="timelineScroller"]')!;
  scroller.scrollTop = 200;internalScroll.mockClear();
  await click("Обновить данные");expect(internalScroll).not.toHaveBeenCalled();expect(scroller.scrollTop).toBe(200);
  await click("Изменить день");expect(internalScroll).toHaveBeenCalledTimes(1);expect(internalScroll).toHaveBeenLastCalledWith(8 * 48);
  expect(pageScroll).not.toHaveBeenCalled();
});
it("preserves filters and selected day in URL when views and their arrow periods change", async () => {
  seed();const get = vi.spyOn(workspaceApi, "calendar").mockResolvedValue({ items: [], next_cursor: null });
  const internalScroll = vi.spyOn(Element.prototype, "scrollTop", "set"), pageScroll = vi.spyOn(window, "scrollTo");
  page = await mountWorkspace(<><CalendarPage /><Location /></>, { path: "/calendar?view=week&date=2026-10-29&mine=false&kind=meeting" });await waitForPage(page);
  expect(get).toHaveBeenLastCalledWith("2026-10-25T21:00:00.000Z", "2026-11-01T21:00:00.000Z", expect.objectContaining({ mine: false, kind: "meeting" }), expect.any(AbortSignal));
  expect(page.container.querySelector('[aria-label="Календарь недели"]')).not.toBeNull();
  await click("Следующая неделя");expect(page.container.querySelector('[data-location]')?.textContent).toContain("date=2026-11-05");
  await click("День");expect(page.container.querySelector('[aria-label="Календарь дня"]')).not.toBeNull();await click("Предыдущий день");expect(page.container.querySelector('[data-location]')?.textContent).toContain("date=2026-11-04");
  await click("Месяц");expect(page.container.querySelector('[aria-label="Календарь месяца"]')).not.toBeNull();await click("Сегодня");
  const url = new URLSearchParams(page.container.querySelector('[data-location]')!.textContent!);expect(url.get("month")).toBe("2026-10");expect(url.get("kind")).toBe("meeting");expect(url.get("mine")).toBe("false");expect(url.get("view")).toBe("month");
  expect(internalScroll).not.toHaveBeenCalled();expect(pageScroll).not.toHaveBeenCalled();
});
it("shows details on keyboard focus without fetching private participant or meeting information", async () => {
  const state = seed().state, season = state.seasons[0];
  const item: CalendarItem = { id: "meeting", season_id: season.season_id, kind: "meeting", title: "Открытая дата созвона", starts_at: "2026-10-29T11:00:00Z", ends_at: null, target: { kind: "subevent", id: "team-preview" } };
  vi.spyOn(workspaceApi, "calendar").mockResolvedValue({ items: [item], next_cursor: null });
  page = await mountWorkspace(<Routes><Route path="/calendar" element={<CalendarPage />} /><Route path="/meetings/subevent/:id" element={<h1>Созвон открыт</h1>} /></Routes>, { path: "/calendar" });await waitForPage(page);
  const link = page.container.querySelector<HTMLAnchorElement>('a[href="/meetings/subevent/team-preview"]')!;
  expect(page.container.querySelector('a[aria-label^="Открыть сезон:"]')).toBeNull();expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => link.focus());await waitForPage(page);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(`Сезон:${season.title}`);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("14:00");
  expect(mock!.adapter.history.get.some(request => /\/meeting$|\/profiles\//.test(request.url ?? ""))).toBe(false);
  await act(async () => link.click());expect(page.container.querySelector("h1")?.textContent).toBe("Созвон открыт");
});
it("renders all-day rows, real overlapping intervals and point markers together", async () => {
  seed();const make = (id: string, start: string, end: string | null, all_day = false): CalendarItem => ({ id, title: id, season_id: "season", kind: "event", starts_at: start, ends_at: end, all_day, target: { kind: "event", id } });
  const items = [make("one", "2026-10-29T09:00:00+03:00", "2026-10-29T11:00:00+03:00"), make("two", "2026-10-29T10:00:00+03:00", "2026-10-29T12:00:00+03:00"), make("point", "2026-10-29T14:00:00+03:00", null), make("all-day", "2026-10-29T00:00:00+03:00", "2026-10-29T00:00:00+03:00", true)];
  page = await mountWorkspace(<CalendarTimeGrid days={["2026-10-29"]} items={items} today="2026-10-29" seasonTitle={() => "Сезон"} />);await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Весь день: 2026-10-29"]')?.textContent).toContain("all-day");
  const first = page.container.querySelector<HTMLElement>('[data-calendar-item="one"]')!, second = page.container.querySelector<HTMLElement>('[data-calendar-item="two"]')!;
  expect(first.style.width).toBe(second.style.width);expect(first.style.left).not.toBe(second.style.left);
  const point = page.container.querySelector('[data-calendar-item="point"]')!;expect(point.getAttribute("data-point")).toBe("true");expect(point.textContent).toBe("14:00point");
});
it("shows each event once in the chronological feed and labels undated entries", async () => {
  const state = seed().state;state.events[0].starts_at = "2026-10-28T12:00:00Z";state.events[0].ends_at = "2026-10-30T12:00:00Z";
  state.events.push({ ...state.events[0], event_id: "undated-widget", title: "Без известного периода", starts_at: null, ends_at: null });
  page = await mountWorkspace(<EventsListPage />);await waitForPage(page);
  const feed = page.container.querySelector('[aria-label="Лента мероприятий"]')!;
  expect(feed).not.toBeNull();
  expect(feed.querySelector('ul[aria-label="Сейчас идут"] a')?.textContent).toContain(state.events[0].title);
  expect(feed.querySelectorAll(`a[href="/events/${state.events[0].event_id}"]`)).toHaveLength(1);
  expect(feed.querySelector('ul[aria-label="Все мероприятия"]')).toBeNull();
  const undated = feed.querySelector('ul[aria-label="Даты уточняются"] a[href="/events/undated-widget"]')!;
  expect(undated).not.toBeNull();
  expect(undated.textContent?.match(/Даты уточняются/g)).toHaveLength(1);
});
