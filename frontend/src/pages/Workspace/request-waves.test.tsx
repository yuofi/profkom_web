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
import { EventPage, SubeventPage } from "./EventPages";
import { MeetingPage } from "./ReportPages";
import { TrackerTaskPage } from "./TrackerTaskDetail";

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
