// @vitest-environment jsdom
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, waitForPage } from "../../test/workspace";
import { workspaceQueryCache } from "../../utils/api/invalidation";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { reportsApi } from "../../utils/api/reports.api";
import { ApiError } from "../../utils/api/request";
import { workspaceStaleTime } from "../../utils/routePrefetch";
import { EventPage, SubeventPage } from "./EventPages";
import { MeetingPage } from "./ReportPages";
import { TrackerTaskPage } from "./TrackerTaskDetail";
import { TaskQueuePage } from "./TaskQueuePages";

// PF-14: what depends only on the address starts with the page's main read.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });
/** Holds a read until the test releases it, to see what started meanwhile. */
function hold<T>(target: Record<string, unknown>, name: string) {
  const original = target[name] as (...args: unknown[]) => Promise<T>;
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  vi.spyOn(target as Record<string, (...args: unknown[]) => Promise<T>>, name).mockImplementation(async (...args) => { await gate; return original(...args); });
  return () => act(async () => { release(); });
}

it("an event page asks for its subevents together with the event", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  const release = hold(eventsApi as unknown as Record<string, unknown>, "get"), subevents = vi.spyOn(eventsApi, "subevents");
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /></Routes>, { path: `/events/${event.event_id}` });await settle();
  expect(subevents).toHaveBeenCalledWith(event.event_id);
  await release();await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toContain(event.title);
});

it("a subevent page names its event from the subevent itself", async () => {
  mock = installMockTransport("chair", { delay: 0 });const sub = mock.state.subevents[0], event = mock.state.events.find(item => item.event_id === sub.event_id)!;
  const get = vi.spyOn(eventsApi, "get");
  page = await mountWorkspace(<Routes><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>, { path: `/subevents/${sub.subevent_id}` });await waitForPage(page);
  expect(page.container.querySelector(`a[href="/events/${event.event_id}"]`)?.textContent).toBe(event.title);
  expect(get).not.toHaveBeenCalled();
});

it("a task page asks for its comments and seasons together with the task", async () => {
  mock = installMockTransport("chair", { delay: 0 });const task = mock.state.tasks[0];
  const release = hold(tasksApi as unknown as Record<string, unknown>, "get"), comments = vi.spyOn(tasksApi, "comments"), seasons = vi.spyOn(seasonsApi, "list");
  // The application's reads go stale at once (no staleTime): a later reader of a finished read must not ask again.
  const client = new QueryClient({ queryCache: workspaceQueryCache(), defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, client });await settle();
  expect(comments).toHaveBeenCalledWith(task.task_id);expect(seasons).toHaveBeenCalled();
  await release();await waitForPage(page);
  // The activity and the season parameter read the same entries instead of asking again.
  expect(comments).toHaveBeenCalledOnce();expect(seasons).toHaveBeenCalledOnce();
});

it("the event meeting page reads the team meetings in one request", async () => {
  mock = installMockTransport("chair", { delay: 0 });const sub = mock.state.subevents.find(item => mock!.state.meetings.some(meeting => meeting.owner_id === item.subevent_id))!;
  const teams = vi.spyOn(eventsApi, "teamMeetings"), meeting = vi.spyOn(eventsApi, "meeting"), subevents = vi.spyOn(eventsApi, "subevents");
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, { path: `/meetings/event/${sub.event_id}` });
  await waitForPage(page, () => !!page!.container.textContent?.includes("Открыть созвон команды"));
  expect(teams).toHaveBeenCalledOnce();expect(subevents).not.toHaveBeenCalled();
  expect(meeting.mock.calls.every(([kind]) => kind === "events")).toBe(true);
  expect(page.container.textContent).toContain(`${sub.title} · `);
  expect(page.container.querySelector(`a[href="/meetings/subevent/${sub.subevent_id}"]`)).not.toBeNull();
});

/** The application's query client: reads go stale at once unless a prefetch just made them. */
const appClient = () => new QueryClient({ queryCache: workspaceQueryCache(), defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: workspaceStaleTime } } });
const reportsHref = (root: ParentNode) => Array.from(root.querySelectorAll("a")).find(a => a.textContent === "Отчёты")?.getAttribute("href") ?? null;
const queuePage = (path: string) => mountWorkspace(<Routes><Route path="/tasks/queues/:id" element={<TaskQueuePage />} /></Routes>, { path, client: appClient() });

it("a queue page asks for its tasks together with the queue, and the list joins that read", async () => {
  mock = installMockTransport("chair", { delay: 0 });const queue = mock.state.queues[0], task = mock.state.tasks.find(item => item.queue?.queue_id === queue.queue_id)!;
  const release = hold(taskQueuesApi as unknown as Record<string, unknown>, "get"), pages = vi.spyOn(tasksApi, "listPage");
  page = await queuePage(`/tasks/queues/${queue.queue_id}`);await settle();
  // The list's own read, by the address: the same filters, so the same key.
  expect(pages).toHaveBeenCalledOnce();expect(pages.mock.calls[0][0]).toEqual({ queue_id: queue.queue_id, mine: "false", unfinished: "false", overdue: "false", sort: "deadline", order: "asc", limit: 20, include_facets: false });
  await release();await waitForPage(page, () => !!page!.container.textContent?.includes(task.title));
  // The list mounted after that read had answered and showed it without asking again.
  expect(pages).toHaveBeenCalledOnce();
  expect(page.container.querySelector("h1")?.textContent).toBe(queue.name);
});

it("a queue calendar starts its planning read with the queue", async () => {
  mock = installMockTransport("chair", { delay: 0 });const queue = mock.state.queues[0];
  const release = hold(taskQueuesApi as unknown as Record<string, unknown>, "get"), pages = vi.spyOn(tasksApi, "listPage");
  page = await queuePage(`/tasks/queues/${queue.queue_id}?view=calendar&month=2026-10`);await settle();
  expect(pages).toHaveBeenCalledOnce();expect(pages.mock.calls[0][0]).toMatchObject({ queue_id: queue.queue_id, limit: 100, date_from: expect.any(String), date_to: expect.any(String) });
  await release();await waitForPage(page, () => !!page!.container.querySelector('[aria-pressed="true"]'));
  expect(pages).toHaveBeenCalledOnce();
});

it("a closed or missing queue refuses its tasks as it refuses the queue, and the page shows only that", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const queue = mock.state.queues[0], titles = mock.state.tasks.filter(item => item.queue?.queue_id === queue.queue_id).map(item => item.title);
  queue.is_private = true;queue.owner = mock.state.people.find(person => person.user_id !== mock!.state.session.user_id)!;
  const pages = vi.spyOn(tasksApi, "listPage");
  page = await queuePage(`/tasks/queues/${queue.queue_id}`);
  await waitForPage(page, () => !!page!.container.textContent?.includes("Нет доступа к очереди"));
  expect(pages).toHaveBeenCalledOnce();
  const refused = await pages.mock.results[0].value.catch((error: unknown) => error);
  expect(refused).toMatchObject({ status: 403, code: "queue_access_required" });
  expect(page.client.getQueryCache().find({ queryKey: ["tasks", "page"] })?.state.data).toBeUndefined();
  for (const title of titles) expect(page.container.textContent).not.toContain(title);
  expect(page.container.textContent).toContain(queue.name);expect(page.container.querySelector("table")).toBeNull();
  await page.cleanup();pages.mockClear();

  page = await queuePage("/tasks/queues/queue-missing");
  await waitForPage(page, () => !!page!.container.textContent?.includes("Очередь не найдена."));
  expect(await pages.mock.results[0].value.catch((error: unknown) => error)).toMatchObject({ status: 404 });
  expect(page.container.querySelector("table")).toBeNull();
});

it("an event page asks for its readable reports together with the event", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const event = mock.state.events[0];
  event.capabilities = event.capabilities.filter(cap => cap !== "create_report");
  mock.state.reports.push({ ...mock.state.reports[0], report_id: "report-event-wave", owner_kind: "event", owner_id: event.event_id, state: "published" });
  const release = hold(eventsApi as unknown as Record<string, unknown>, "get"), reports = vi.spyOn(reportsApi, "list");
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /></Routes>, { path: `/events/${event.event_id}`, client: appClient() });await settle();
  expect(reports).toHaveBeenCalledWith({ owner_kind: "event", owner_id: event.event_id });
  await release();await waitForPage(page, () => !!page!.container.querySelector("h1"));
  expect(reportsHref(page.container)).toBe(`/reports?owner_kind=event&owner_id=${event.event_id}`);
  expect(reports).toHaveBeenCalledOnce();
});

it("a report creator keeps the link without reading the list again", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const event = mock.state.events[0];
  if (!event.capabilities.includes("create_report")) event.capabilities.push("create_report");
  mock.state.reports = mock.state.reports.filter(report => report.owner_id !== event.event_id);
  const reports = vi.spyOn(reportsApi, "list");
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /></Routes>, { path: `/events/${event.event_id}`, client: appClient() });
  await waitForPage(page, () => !!page!.container.querySelector("h1"));
  expect(reportsHref(page.container)).toBe(`/reports?owner_kind=event&owner_id=${event.event_id}`);
  expect(reports.mock.calls.length).toBeLessThanOrEqual(1);const before = reports.mock.calls.length;
  await act(async () => { await page!.client.invalidateQueries(); });await waitForPage(page);
  expect(reports).toHaveBeenCalledTimes(before);
});

it("a subevent page asks for its reports only once the subevent says the reader works on it", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const report = mock.state.reports.find(item => item.owner_kind === "subevent" && item.state === "published")!;
  const sub = mock.state.subevents.find(item => item.subevent_id === report.owner_id)!, me = mock.state.session.user_id;
  sub.capabilities = sub.capabilities.filter(cap => cap !== "create_report");
  if (!sub.organizer_user_ids.includes(me)) sub.organizer_user_ids.push(me);
  const release = hold(eventsApi as unknown as Record<string, unknown>, "subevent"), reports = vi.spyOn(reportsApi, "list");
  const mount = () => mountWorkspace(<Routes><Route path="/subevents/:id" element={<SubeventPage />} /></Routes>, { path: `/subevents/${sub.subevent_id}`, client: appClient() });
  page = await mount();await settle();
  // The team's work is not asked for before the subevent's answer (event-workspace.test).
  expect(reports).not.toHaveBeenCalled();
  await release();await waitForPage(page, () => !!reportsHref(page!.container));
  expect(reportsHref(page.container)).toBe(`/reports?owner_kind=subevent&owner_id=${sub.subevent_id}`);expect(reports).toHaveBeenCalledOnce();
  await page.cleanup();vi.restoreAllMocks();reports.mockClear();

  // Without the working access: no reports read at all, and no link.
  sub.organizer_user_ids = sub.organizer_user_ids.filter(uid => uid !== me);sub.leaders = sub.leaders.filter(leader => leader.user.user_id !== me && !leader.deputy_user_ids.includes(me));if (sub.hr?.user_id === me) sub.hr = null;
  const outside = vi.spyOn(reportsApi, "list");
  page = await mount();await waitForPage(page, () => !!page!.container.querySelector("h1"));
  expect(page.container.querySelector("h1")?.textContent).toBe(sub.title);
  expect(outside).not.toHaveBeenCalled();expect(reportsHref(page.container)).toBeNull();
});

it("a failed reports read leaves the link out and the event page as it is", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const event = mock.state.events[0];
  event.capabilities = event.capabilities.filter(cap => cap !== "create_report");
  vi.spyOn(reportsApi, "list").mockRejectedValue(new ApiError("Нет доступа", 403, "forbidden"));
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /></Routes>, { path: `/events/${event.event_id}`, client: appClient() });
  await waitForPage(page, () => !!page!.container.querySelector("h1"));
  expect(page.container.querySelector("h1")?.textContent).toContain(event.title);
  expect(reportsHref(page.container)).toBeNull();
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
});
