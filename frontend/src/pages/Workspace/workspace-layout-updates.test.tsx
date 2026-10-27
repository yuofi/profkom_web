// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { EventCreatePage, EventEditPage, EventPage, EventsListPage } from "./EventPages";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { ApiError } from "../../utils/api/request";
import { CalendarPage } from "./WorkspacePages";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.useRealTimers();vi.restoreAllMocks(); });
it("opens the blank event editor from an explicit catalog action and creates its visible content", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/events" element={<EventsListPage />} /><Route path="/events/new" element={<EventCreatePage />} /><Route path="/events/:id" element={<EventPage />} /></Routes>, { role: "chair", path: "/events" });await waitForPage(page);
  expect(page.container.querySelector('input[name="title"]')).toBeNull();
  const create = page.container.querySelector<HTMLAnchorElement>('a[href="/events/new"]')!;expect(create.textContent).toBe("Создать мероприятие");
  await act(async () => create.click());await waitForPage(page, () => !!page!.container.querySelector('input[name="title"]'));
  expect(field(page.container, "title").value).toBe("");expect(page.container.querySelector('[aria-label="Параметры мероприятия"]')).not.toBeNull();
  await change(field(page.container, "title"), "Видимое новое мероприятие");await change(field(page.container, "description"), "Описание с **выделением**");
  await submit(page.container.querySelector("form")!);await waitForPage(page, () => !!page!.container.querySelector("strong")?.textContent?.includes("выделением"));
  expect(mock.state.events.at(-1)?.description.body).toBe("Описание с **выделением**");expect(page.container.querySelector("h1")?.textContent).toBe("Видимое новое мероприятие");
});
it("opens the leader picker by its pencil and saves the selected current roster", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /></Routes>, { role: "chair", path: `/events/${event.event_id}` });await waitForPage(page);
  expect(page.container.querySelector("dialog")).toBeNull();await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Изменить главоргов"]')!.click());await waitForPage(page, () => !!page!.container.querySelector('dialog input[name="users"]'));
  const dialog = page.container.querySelector("dialog")!;expect(dialog.textContent).toContain("Главорги мероприятия");
  const candidate = mock.state.people.find(person => !event.leaders.some(leader => leader.user.user_id === person.user_id))!;
  await pick(dialog, "users", String(candidate.user_id));await submit(dialog.querySelector("form")!);await waitForPage(page, () => !page!.container.querySelector("dialog"));
  expect(mock.state.events[0].leaders.some(leader => leader.user.user_id === candidate.user_id)).toBe(true);
});
it("does not expose event creation or leader editors to an ordinary reader", async () => {
  mock = installMockTransport("organizer", { delay: 0 });page = await mountWorkspace(<EventCreatePage />, { role: "organizer" });await waitForPage(page);
  expect(page.container.querySelector("form")).toBeNull();expect(mock.adapter.history.post).toHaveLength(0);
});
it("marks today by Moscow date and refreshes that marker across midnight on focus", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(new Date("2026-10-26T22:30:00Z"));mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<CalendarPage />, { role: "chair" });await waitForPage(page);
  expect(page.container.querySelector('[aria-current="date"]')?.getAttribute("aria-label")).toBe("2026-10-27");
  vi.setSystemTime(new Date("2026-10-27T22:30:00Z"));await act(async () => window.dispatchEvent(new Event("focus")));
  expect(page.container.querySelector('[aria-current="date"]')?.getAttribute("aria-label")).toBe("2026-10-28");
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Следующий месяц"]')!.click());await waitForPage(page);
  expect(page.container.querySelector('[aria-current="date"]')).toBeNull();
});
it("retains the actual event editor through transient object/season refetch errors and clears it on refusal", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  page = await mountWorkspace(<Routes><Route path="/events/:id/edit" element={<EventEditPage />} /></Routes>, { role: "chair", path: `/events/${event.event_id}/edit` });await waitForPage(page, () => !!page!.container.querySelector('textarea[name="description"]'));
  const editor = page.container.querySelector("form")!;await change(field(editor, "description"), "Черновик при временной ошибке");
  const read = vi.spyOn(eventsApi, "get").mockRejectedValue(new ApiError("Временная ошибка", 503));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["events", event.event_id] }); });await waitForPage(page);
  expect(page.container.querySelector("form")).toBe(editor);expect(field(editor, "description").value).toBe("Черновик при временной ошибке");
  vi.spyOn(seasonsApi, "list").mockRejectedValue(new ApiError("Временная ошибка списка сезонов", 503));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["seasons"] }); });await waitForPage(page);
  expect(page.container.querySelector("form")).toBe(editor);expect(field(editor, "description").value).toBe("Черновик при временной ошибке");
  read.mockRejectedValue(new ApiError("Нет доступа", 403));await act(async () => { await page!.client.invalidateQueries({ queryKey: ["events", event.event_id] }); });await waitForPage(page);
  expect(page.container.querySelector("form")).toBeNull();expect(page.container.textContent).not.toContain("Черновик при временной ошибке");
});
