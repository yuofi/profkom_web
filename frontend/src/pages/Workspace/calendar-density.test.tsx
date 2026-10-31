// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { workspaceApi } from "../../utils/api/workspace.api";
import type { CalendarItem } from "../../utils/api/contract";
import { CalendarTimeGrid } from "./CalendarViews";
import { CalendarPage } from "./WorkspacePages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks();vi.unstubAllGlobals(); });
const make = (id: string, start: string, end: string | null = null, kind: CalendarItem["kind"] = "task_deadline"): CalendarItem => ({ id, title: `Запись ${id}`, season_id: "season", kind, starts_at: start, ends_at: end, target: { kind: "task", id } });
function screen(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow && query.includes("max-width: 768px"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

it("folds simultaneous deadlines beyond the lane limit into one mark listing them (EV-08)", async () => {
  screen(false);
  const items = Array.from({ length: 71 }, (_, index) => make(`d${index}`, "2026-10-29T00:27:00Z"));
  page = await mountWorkspace(<CalendarTimeGrid days={["2026-10-29"]} items={items} today="2026-10-29" seasonTitle={() => "Сезон"} />);await waitForPage(page);
  const shown = [...page.container.querySelectorAll<HTMLElement>("[data-calendar-item]")];
  expect(shown).toHaveLength(2);
  const mark = page.container.querySelector("details")!;
  // Three equal columns: two entries and the mark, instead of 71 strips of 7 px.
  expect(new Set([...shown, mark].map(entry => (entry as HTMLElement).style.width)).size).toBe(1);
  expect(shown[0].style.width).toContain("33.33");
  expect(mark.querySelector("summary")?.textContent).toBe("+69");
  expect(mark.querySelector("summary")?.getAttribute("aria-label")).toBe("Ещё записей в это время: 69");
  await act(async () => { mark.open = true; });
  expect(mark.querySelectorAll("li a[href^='/tasks/']")).toHaveLength(69);
  expect(mark.textContent).toContain("03:27Запись d70");
  await page.cleanup();
  // The week and the phone allow two columns.
  page = await mountWorkspace(<CalendarTimeGrid days={["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]} items={items.slice(0, 3)} today="2026-10-29" seasonTitle={() => "Сезон"} />);await waitForPage(page);
  expect(page.container.querySelectorAll("[data-calendar-item]")).toHaveLength(1);
  expect(page.container.querySelector("details summary")?.textContent).toBe("+2");
});

it("shows the middle days of a multi-day event in the all-day row and keeps its first and last day on the grid (EV-09)", async () => {
  screen(false);
  const festival = make("festival", "2026-10-30T07:00:00Z", "2026-11-03T19:00:00Z", "event");
  page = await mountWorkspace(<CalendarTimeGrid days={["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]} items={[festival]} today="2026-10-31" seasonTitle={() => "Сезон"} />);await waitForPage(page);
  for (const day of ["2026-10-31", "2026-11-01", "2026-11-02"]) {
    expect(page.container.querySelector(`[aria-label="Весь день: ${day}"]`)?.textContent).toBe("↔Запись festival");
    expect(page.container.querySelector(`[aria-label="События: ${day}"] [data-calendar-item]`)).toBeNull();
  }
  expect(page.container.querySelector('[aria-label="События: 2026-10-30"] [data-calendar-item]')?.textContent).toBe("10:00–24:00Запись festival");
  expect(page.container.querySelector('[aria-label="События: 2026-11-03"] [data-calendar-item]')?.textContent).toBe("00:00–22:00Запись festival");
});

it("opens the day on a phone unless the address names a view, and a wide week starts at today inside its frame (EV-10)", async () => {
  screen(true);mock = installMockTransport("chair", { delay: 0 });vi.spyOn(workspaceApi, "calendar").mockResolvedValue({ items: [], next_cursor: null });
  page = await mountWorkspace(<CalendarPage />, { path: "/calendar" });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Календарь дня"]')).not.toBeNull();
  await page.cleanup();
  page = await mountWorkspace(<CalendarPage />, { path: "/calendar?view=month" });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Календарь месяца"]')).not.toBeNull();
  await page.cleanup();
  // A 780 px week in a 356 px frame: today's column is brought into the frame, the page does not move.
  const width = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(780), visible = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(356);
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { left: this.getAttribute("aria-current") === "date" ? 589 : 17, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  const pageScroll = vi.spyOn(window, "scrollTo");
  page = await mountWorkspace(<CalendarTimeGrid days={["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]} items={[]} today="2026-10-31" seasonTitle={() => "Сезон"} />);await waitForPage(page);
  expect(page.container.querySelector<HTMLElement>('[class*="timelineOverflow"]')!.scrollLeft).toBe(589 - 17 - 52);
  expect(pageScroll).not.toHaveBeenCalled();
  width.mockRestore();visible.mockRestore();rect.mockRestore();
});

it("offers the public task statuses once, marks archived seasons and shows the reset only for active filters (EV-16)", async () => {
  screen(false);mock = installMockTransport("chair", { delay: 0 });vi.spyOn(workspaceApi, "calendar").mockResolvedValue({ items: [], next_cursor: null });
  const past = mock.state.seasons[0];past.state = "closed";
  mock.state.events.push({ ...mock.state.events[0], event_id: "past-event", title: "Посвят — прошлый год", season_id: past.season_id });
  const reset = () => [...page!.container.querySelectorAll("button")].find(button => button.textContent === "Сбросить фильтры");
  page = await mountWorkspace(<CalendarPage />, { path: "/calendar?view=month" });await waitForPage(page);
  expect(reset()).toBeUndefined();
  const details = page.container.querySelector("details")!;
  await act(async () => { details.open = true;details.dispatchEvent(new Event("toggle")); });await waitForPage(page);
  const selects = [...page.container.querySelectorAll<HTMLSelectElement>("details select")];
  const status = selects.find(select => select.closest("label")?.textContent?.startsWith("Статус задач"))!;
  expect([...status.options].map(option => option.textContent)).toEqual(["Незавершённые", "Открыта", "В работе", "Выполнена", "Закрыта"]);
  const season = selects.find(select => select.closest("label")?.textContent?.startsWith("Сезон"))!;
  expect([...season.options].find(option => option.value === past.season_id)?.textContent).toBe(`${past.title} · архив`);
  // Without a chosen season only events of the live seasons are offered.
  const events = page.container.querySelectorAll<HTMLInputElement>('[data-entity-picker] [role="combobox"]')[1];
  await act(async () => { events.focus();events.click(); });await waitForPage(page);
  const listbox = document.getElementById(events.getAttribute("aria-controls")!)!;
  expect(listbox.textContent).toContain(mock.state.events[0].title);
  expect(listbox.textContent).not.toContain("Посвят — прошлый год");
  await page.cleanup();
  page = await mountWorkspace(<CalendarPage />, { path: `/calendar?view=month&season_id=${past.season_id}` });await waitForPage(page);
  expect(reset()).toBeDefined();
  expect(page.container.textContent).toContain(`Сезон «${past.title}» закрыт, его задачи завершены.`);
  await page.cleanup();
  page = await mountWorkspace(<CalendarPage />, { path: "/calendar?view=month&mine=false" });await waitForPage(page);
  expect(reset()).toBeDefined();
});
