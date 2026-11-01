// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { EventEditPage, SubeventEditPage } from "./EventPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; });
const routes = <Routes><Route path="/events/:id/edit" element={<EventEditPage />} /><Route path="/subevents/:id/edit" element={<SubeventEditPage />} /></Routes>;
const titleField = () => page!.container.querySelector<HTMLInputElement>('[name="title"]')!;
const trail = () => [...page!.container.querySelectorAll('nav[aria-label="Навигация мероприятия"] > *')].map(item => item.textContent);

it("names a subevent as a subevent, labels its parent and keeps Cancel with the save (EV-18)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const parent = mock.state.events[0], sub = mock.state.subevents.find(item => item.event_id === parent.event_id)!;
  page = await mountWorkspace(routes, { path: `/subevents/${sub.subevent_id}/edit` });await waitForPage(page, () => !!page!.container.querySelector('[name="title"]'));
  expect(titleField().closest("label")?.firstChild?.textContent).toBe("Название подмероприятия");
  expect(titleField().placeholder).toBe("Название подмероприятия");
  const parameters = page.container.querySelector('[aria-label="Параметры мероприятия"]')!;
  expect(parameters.textContent).toContain(`Мероприятие: ${parent.title}`);
  expect(parameters.querySelector(`a[href="/events/${parent.event_id}"]`)?.textContent).toBe(parent.title);
  expect(trail()).toEqual([parent.title, "›", sub.title, "›", "Редактирование подмероприятия"]);
  // Cancel is no longer on the decorated header: it stands beside the submit in the form's row.
  const cancel = [...page.container.querySelectorAll("a")].find(link => link.textContent === "Отмена")!;
  expect(cancel.closest("header")).toBeNull();
  expect(cancel.parentElement).toBe(page.container.querySelector('button[type="submit"]')!.parentElement);
});

it("an event editor shows the event's own title in its trail (EV-18)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  page = await mountWorkspace(routes, { path: `/events/${event.event_id}/edit` });await waitForPage(page, () => !!page!.container.querySelector('[name="title"]'));
  expect(titleField().placeholder).toBe("Название мероприятия");
  expect(trail()).toEqual([event.title, "›", "Редактирование мероприятия"]);
});
