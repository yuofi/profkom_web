// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { eventPeriod } from "./eventDates";
import { EventPage, SubeventPage } from "./EventPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks();vi.useRealTimers(); });
// Dates keep their words together with no-break spaces.
const plain = (text?: string | null) => (text ?? "").replace(/\u00a0/g, " ");
const routes = <Routes><Route path="/events/:id" element={<EventPage />} /><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>;

it("keeps the cards of an event and a subevent page in one spaced stack (EV-12)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0], sub = mock.state.subevents[0];
  for (const path of [`/events/${event.event_id}`, `/subevents/${sub.subevent_id}`]) {
    page = await mountWorkspace(routes, { path });await waitForPage(page);
    const stack = page.container.querySelector("header")!.parentElement!;
    expect(stack.className).toContain("stack");
    expect(stack.querySelectorAll(":scope > section").length).toBeGreaterThan(1);
    await page.cleanup();page = undefined;
  }
});

it("puts the subevent's edit and work links in one row under the header text (EV-13)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const sub = mock.state.subevents[0];
  page = await mountWorkspace(routes, { path: `/subevents/${sub.subevent_id}` });await waitForPage(page);
  const header = page.container.querySelector("header")!;
  // The header has one content column: the title is not squeezed by a side column of actions.
  expect([...header.children].filter(child => child.getAttribute("aria-hidden") !== "true")).toHaveLength(1);
  const actions = header.querySelector('[role="group"][aria-label="Действия подмероприятия"]')!;
  expect([...actions.querySelectorAll("a")].map(link => link.textContent)).toEqual(["Редактировать подмероприятие", "Задачи команды", "Отчёты", "Созвон", "Учесть волонтёрскую работу"]);
  const work = [...page.container.querySelectorAll("h2")].find(heading => heading.textContent === "Рабочая информация")!.closest("section")!;
  expect(work.querySelector("a[href^='/tasks'], a[href^='/reports'], a[href^='/meetings']")).toBeNull();
  expect(header.querySelector("nav a")?.getAttribute("title")).toBe(mock.state.events.find(event => event.event_id === sub.event_id)!.title);
});

it("drops the nearest subevents when they repeat the whole list and names one day once (EV-27)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  const children = mock.state.subevents.filter(sub => sub.event_id === event.event_id);
  children.forEach((sub, index) => { sub.starts_at = `2026-10-3${index}T15:00:00Z`;sub.ends_at = `2026-10-3${index}T17:00:00Z`; });
  page = await mountWorkspace(routes, { path: `/events/${event.event_id}` });await waitForPage(page);
  expect(page.container.textContent).not.toContain("Ближайшие подмероприятия");
  expect(plain(page.container.querySelector('[aria-label="Все подмероприятия"]')?.textContent)).toContain("30 окт. 2026 г., 18:00–20:00");
  await page.cleanup();
  // With a past subevent besides the coming ones, the shorter nearest list is useful again.
  mock.state.subevents.push({ ...structuredClone(children[0]), subevent_id: "past-sub", title: "Прошедшее", starts_at: "2026-10-01T15:00:00Z", ends_at: "2026-10-01T17:00:00Z" });
  page = await mountWorkspace(routes, { path: `/events/${event.event_id}` });await waitForPage(page);
  expect(page.container.textContent).toContain("Ближайшие подмероприятия");
  expect(plain(eventPeriod({ starts_at: "2026-10-31T15:00:00Z", ends_at: "2026-11-01T17:00:00Z" }))).toBe("31 окт. 2026 г., 18:00 — 1 нояб. 2026 г., 20:00");
});
