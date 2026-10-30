// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { reportsApi } from "../../utils/api/reports.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { richText, type Event, type Subevent } from "../../utils/api/contract";
import { ReportHistoryPage, ReportPage } from "./ReportPages";
import { EventCreatePage, EventPage, EventsListPage, SubeventPage } from "./EventPages";
import { DashboardPage } from "./WorkspacePages";

// Step 5 of release 1: report history (FIX_PLAN 2.2), a series chosen on creation (2.21)
// and the personal participation home. The suite's API pages lists by 3.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });

async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");
  if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Event history", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const result = await seasonsApi.command(planned.season_id, "open", {expected_revision: planned.revision});
  return "season" in result ? result.season : result;
}
/** At most one season may be planned, so another test's planned season is reused. */
async function plannedSeason() {
  await liveLogin();
  return (await seasonsApi.list()).items.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Следующий сезон", type: "winter_spring", starts_at: new Date(Date.now() + 40 * 86400000).toISOString(), ends_at: new Date(Date.now() + 90 * 86400000).toISOString(),
  });
}
/** «Посвят» led by `head` with «Лекции» led by `resp` and organized by `org`. */
async function instance(head: number, resp: number, org: number, title = "Посвят") {
  const season = await openSeason();
  let event = await eventsApi.create({season_id: season.season_id, title, description: richText("")});
  event = await eventsApi.leaders("events", event.event_id, [head], {expected_revision: event.revision}) as Event;
  let sub = await eventsApi.createSubevent(event.event_id, {title: `Лекции: ${title}`, description: richText("")});
  sub = await eventsApi.leaders("subevents", sub.subevent_id, [resp], {expected_revision: sub.revision}) as Subevent;
  await eventsApi.organizers(sub.subevent_id, [org], {expected_revision: sub.revision});
  return {season, event, sub};
}
async function publish(owner_kind: "event" | "subevent", owner_id: string, title: string) {
  const report = await reportsApi.create({owner_kind, owner_id, kind: "regular", title, content: richText(title), file_ids: []});
  return reportsApi.publish(report.report_id, {expected_revision: report.revision});
}
async function mount(email: string, element: ReactNode, path: string) {
  const session = await liveLogin(email);
  page = await mountWorkspace(element, {path, session});
  await waitForPage(page);
}
const text = () => page!.container.textContent ?? "";
const links = () => Array.from(page!.container.querySelectorAll("a"), a => a.textContent?.trim());
const options = (select: HTMLSelectElement) => Array.from(select.options, o => [o.value, o.textContent ?? ""] as const);

it("2.2: the history is offered to its readers only, labelled by season and fully paged", async () => {
  const head = await liveParticipant("history-head"), resp = await liveParticipant("history-resp");
  const org = await liveParticipant("history-org"), newhead = await liveParticipant("history-newhead");
  const {season, event, sub} = await instance(head.user_id, resp.user_id, org.user_id);
  await liveLogin(head.email);
  let report = await publish("event", event.event_id, "Отчёт 1");
  for (const version of [2, 3, 4]) {
    report = await reportsApi.update(report.report_id, {expected_revision: report.revision, content: richText(`Редакция ${version}`)});
    report = await reportsApi.publish(report.report_id, {expected_revision: report.revision});
  }
  for (const n of [2, 3, 4]) await publish("event", event.event_id, `Отчёт ${n}`);
  await liveLogin(resp.email);
  const subReport = await publish("subevent", sub.subevent_id, "Отчёт лекций");
  const next = await plannedSeason();
  const copy = await eventsApi.copy(event.event_id, {season_id: next.season_id, title: "Посвят следующего года"});
  await eventsApi.leaders("events", copy.event.event_id, [newhead.user_id], {expected_revision: copy.event.revision});

  // Four versions are more than a page: the report page shows all of them.
  await mount(head.email, <Routes><Route path="/reports/:id" element={<ReportPage />} /></Routes>, `/reports/${report.report_id}`);
  await waitForPage(page!, () => text().includes("Опубликованные версии"));
  expect(page!.container.querySelectorAll("details summary").length).toBeGreaterThanOrEqual(4);
  for (const version of [1, 2, 3, 4]) expect(text()).toContain(`Версия ${version} ·`);
  expect(links()).toContain("Все годы этой серии");
  await page!.cleanup(); page = undefined;

  // The lead of the next instance reads the previous one while its season is open (A-EVT-3).
  await mount(newhead.email, <Routes><Route path="/reports/history" element={<ReportHistoryPage />} /></Routes>, `/reports/history?series_id=${event.report_series_id}`);
  await waitForPage(page!, () => page!.container.querySelectorAll("ul li").length >= 4);
  const items = Array.from(page!.container.querySelectorAll("ul li"), li => li.textContent ?? "");
  expect(items.filter(item => item.startsWith("Отчёт"))).toHaveLength(4);
  for (const item of items) expect(item).toContain(`Сезон: ${season.title}`);
  await page!.cleanup(); page = undefined;

  // An organizer reads the current report but not the series history (A-EVT-6).
  await mount(org.email, <Routes><Route path="/reports/:id" element={<ReportPage />} /></Routes>, `/reports/${subReport.report_id}`);
  await waitForPage(page!, () => text().includes("Отчёт лекций"));
  expect(links()).not.toContain("Все годы этой серии");
  await page!.cleanup(); page = undefined;
  await mount(org.email, <Routes><Route path="/reports/history" element={<ReportHistoryPage />} /></Routes>, "/reports/history");
  expect(options(field(page!.container, "series") as HTMLSelectElement).map(([value]) => value)).not.toContain(sub.report_series_id);
});

it("2.21: a new event and its subevent continue chosen series and show their history", async () => {
  const head = await liveParticipant("series-head"), resp = await liveParticipant("series-resp");
  const org = await liveParticipant("series-org"), newhead = await liveParticipant("series-newhead");
  const old = await instance(head.user_id, resp.user_id, org.user_id, "Посвят с серией");
  const foreign = await instance(head.user_id, resp.user_id, org.user_id, "Другое мероприятие");
  await liveLogin(resp.email);
  const oldReport = await publish("subevent", old.sub.subevent_id, "Отчёт старых лекций");
  const next = await plannedSeason();

  await mount("chair@example.com", <Routes><Route path="/events" element={<EventsListPage />} /><Route path="/events/new" element={<EventCreatePage />} /><Route path="/events/:id" element={<p>Мероприятие создано</p>} /></Routes>, "/events");
  expect(page!.container.querySelector("form")).toBeNull();
  const createLink = [...page!.container.querySelectorAll("a")].find(link => link.textContent?.trim() === "Создать мероприятие")!;
  expect(createLink.getAttribute("href")).toBe("/events/new");
  await act(async () => createLink.click());await waitForPage(page!, () => !!page!.container.querySelector('[name="series"]'));
  expect(page!.container.querySelector("h1")?.textContent).toBe("Новое мероприятие");
  const form = field(page!.container, "series").closest("form")!;
  await waitForPage(page!, () => options(field(form, "series") as HTMLSelectElement).some(([value]) => value === old.event.report_series_id));
  const label = options(field(form, "series") as HTMLSelectElement).find(([value]) => value === old.event.report_series_id)![1];
  expect(label).toContain(`Посвят с серией, ${old.season.title}`);
  await change(field(form, "title"), "Посвят следующего года с серией");
  await change(field(form, "season") as HTMLSelectElement, next.season_id);
  await change(field(form, "series") as HTMLSelectElement, old.event.report_series_id);
  await submit(form);
  await waitForPage(page!, () => text().includes("Мероприятие создано"));
  await page!.cleanup(); page = undefined;
  await liveLogin();
  const created = (await eventsApi.list()).items.find(e => e.title === "Посвят следующего года с серией")!;
  expect(created.report_series_id).toBe(old.event.report_series_id);
  await eventsApi.leaders("events", created.event_id, [newhead.user_id], {expected_revision: created.revision});

  // The head of the new instance is offered the child series of its own series only.
  await mount(newhead.email, <Routes><Route path="/events/:id" element={<EventPage />} /><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>, `/events/${created.event_id}`);
  await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Добавить подмероприятие")!.click());
  await waitForPage(page!, () => !!page!.container.querySelector('[name="series"]'));
  const subForm = field(page!.container, "series").closest("form")!;
  await waitForPage(page!, () => options(field(subForm, "series") as HTMLSelectElement).some(([value]) => value === old.sub.report_series_id));
  const offered = options(field(subForm, "series") as HTMLSelectElement).map(([value]) => value);
  expect(offered).not.toContain(foreign.sub.report_series_id);
  expect(offered).not.toContain(old.event.report_series_id);
  await change(field(subForm, "title"), "Лекции следующего года");
  expect(old.sub.report_series_id).not.toBeNull();
  await change(field(subForm, "series") as HTMLSelectElement, old.sub.report_series_id!);
  await submit(subForm);
  await waitForPage(page!, () => !subForm.isConnected && text().includes("Лекции следующего года"));
  expect(subForm.querySelector('[role="alert"]')).toBeNull();
  const subs = (await eventsApi.subevents(created.event_id)).items;
  expect(subs.find(s => s.title === "Лекции следующего года")?.report_series_id).toBe(old.sub.report_series_id);
  await page!.cleanup(); page = undefined;

  await mount(newhead.email, <Routes><Route path="/reports/history" element={<ReportHistoryPage />} /></Routes>, `/reports/history?series_id=${old.sub.report_series_id}`);
  await waitForPage(page!, () => text().includes("Отчёт старых лекций"));
  expect(text()).toContain(`Сезон: ${old.season.title}`);
  expect(oldReport.report_series_id).toBe(old.sub.report_series_id);
});

it("the home page lists actual participation for every role, including the chair", async () => {
  const head = await liveParticipant("home-head"), resp = await liveParticipant("home-resp"), org = await liveParticipant("home-org");
  const {event} = await instance(head.user_id, resp.user_id, org.user_id, "Мероприятие для главной");
  const outsider = await liveParticipant("home-outsider");
  for (const [email, listed] of [["chair@example.com", false], [outsider.email, false], [org.email, true]] as const) {
    await mount(email, <Routes><Route path="/" element={<DashboardPage />} /></Routes>, "/");
    await waitForPage(page!, () => text().includes("Рабочее пространство"));
    const card = Array.from(page!.container.querySelectorAll("section")).find(s => s.querySelector(":scope > h2")?.textContent?.startsWith("Мои мероприятия ·"))!;
    expect(!!card.textContent?.includes(event.title), email).toBe(listed);
    if (email === "chair@example.com") { const blocks = Array.from(page!.container.querySelectorAll("section")).find(section => section.querySelector(":scope > h2")?.textContent?.startsWith("Мои блоки ·"))!;expect(blocks.textContent).not.toContain("Integration vacant"); }
    if (email === org.email) expect(card.textContent).toContain("Организатор");
    await page!.cleanup(); page = undefined;
  }
});
