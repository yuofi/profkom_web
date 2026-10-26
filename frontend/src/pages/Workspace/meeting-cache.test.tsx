// @vitest-environment jsdom
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { ApiError } from "../../utils/api/request";
import { MeetingPage } from "./ReportPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; vi.restoreAllMocks(); });
const announcement = {
  meeting_id: "meeting-private", owner_kind: "event" as const, owner_id: "event-private",
  title: "Private announcement marker", starts_at: "2026-10-26T12:00:00Z", join_url: "https://example.invalid/private-meeting",
  revision: 1, capabilities: ["edit_meeting", "delete_meeting"],
};

it.each(["no-capability", "forbidden"])("drops cached meeting data and editor after owner access ends (%s)", async (failure) => {
  const event = { ...createFixtures("chair").events[0], event_id: announcement.owner_id, capabilities: ["view_meeting", "edit_meeting"] };
  const get = vi.spyOn(eventsApi, "get").mockResolvedValue(event);
  vi.spyOn(eventsApi, "subevents").mockResolvedValue({ items: [], next_cursor: null });
  const meeting = vi.spyOn(eventsApi, "meeting").mockResolvedValue(announcement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  const meetingKey = ["events", "meeting", "event", event.event_id];
  client.setQueryData(meetingKey, announcement);
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, { path: `/meetings/event/${event.event_id}`, client });
  await waitForPage(page);
  expect(page.container.textContent).toContain(announcement.title);
  if (failure === "forbidden") get.mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));
  else get.mockResolvedValue({ ...event, capabilities: [] });
  await act(async () => { await client.invalidateQueries({ queryKey: ["events", "meeting-owner", "event", event.event_id], exact: true }); });
  await waitForPage(page);
  expect(page.container.textContent).not.toContain(announcement.title);
  expect(page.container.querySelector(`a[href="${announcement.join_url}"]`)).toBeNull();
  expect(page.container.querySelector('input[name="url"]')).toBeNull();
  expect(client.getQueryData(meetingKey)).toBeUndefined();
  expect(meeting).not.toHaveBeenCalled();
});

it("retry recovers the owner before loading its meeting", async () => {
  const event = { ...createFixtures("chair").events[0], event_id: announcement.owner_id, capabilities: ["view_meeting"] };
  const get = vi.spyOn(eventsApi, "get").mockRejectedValueOnce(new ApiError("Unavailable", 503, "unavailable")).mockResolvedValue(event);
  vi.spyOn(eventsApi, "subevents").mockResolvedValue({ items: [], next_cursor: null });
  const meeting = vi.spyOn(eventsApi, "meeting").mockResolvedValue(announcement);
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, { path: `/meetings/event/${event.event_id}` });
  await waitForPage(page);
  expect(meeting).not.toHaveBeenCalled();
  const retry = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Обновить данные")!;
  await act(async () => retry.click());
  await waitForPage(page, () => !!page!.container.textContent?.includes(announcement.title));
  expect(get).toHaveBeenCalledTimes(2);
  expect(meeting).toHaveBeenCalledTimes(1);
});


it("mounts an existing meeting editor only after its first announcement response", async () => {
  const event = { ...createFixtures("chair").events[0], event_id: announcement.owner_id, capabilities: ["view_meeting", "edit_meeting"] };
  vi.spyOn(eventsApi, "get").mockResolvedValue(event);
  vi.spyOn(eventsApi, "subevents").mockResolvedValue({ items: [], next_cursor: null });
  let resolve!: (meeting: typeof announcement) => void;
  vi.spyOn(eventsApi, "meeting").mockReturnValue(new Promise((done) => { resolve = done; }));
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, { path: `/meetings/event/${event.event_id}` });
  await settle();
  expect(page.container.querySelector('input[name="url"]')).toBeNull();
  await act(async () => resolve(announcement));
  await waitForPage(page);
  expect((page.container.querySelector('input[name="title"]') as HTMLInputElement).value).toBe(announcement.title);
  expect((page.container.querySelector('input[name="url"]') as HTMLInputElement).value).toBe(announcement.join_url);
});
