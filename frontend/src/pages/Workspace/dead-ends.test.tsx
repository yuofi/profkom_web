// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { NotFoundRoute } from "../fallback/NotFoundPage";
import { EventCreatePage, EventPage, SubeventPage } from "./EventPages";
import { ReportsPage } from "./ReportPages";
import { TrackerTaskCreatePage } from "./TaskCreateForm";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })));
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.unstubAllGlobals();vi.restoreAllMocks(); });
const links = () => [...page!.container.querySelectorAll("a")].map(link => [link.textContent, link.getAttribute("href")]);
const heading = () => page!.container.querySelector("h1")?.textContent;

it("GL-21: a signed-in member on an unknown address keeps the workspace and gets ways out", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="*" element={<NotFoundRoute />} /></Routes>, { history: ["/tasks"], path: "/tasks/queues/x/y" });
  await waitForPage(page, () => !!page!.container.querySelector("main h1"));
  expect(heading()).toBe("Страница не найдена");
  expect(page.container.querySelector("nav a[href='/tasks']")).not.toBeNull();
  expect(links()).toContainEqual(["На главную", "/"]);
  expect([...page.container.querySelectorAll("main button")].map(node => node.textContent)).toContain("Назад");
});

it("GL-21: a visitor sees the public 404 with a link, not the login form", async () => {
  page = await mountWorkspace(<Routes><Route path="*" element={<NotFoundRoute />} /><Route path="/auth" element={<p>Вход</p>} /></Routes>, { session: null, path: "/no-such-page" });
  await waitForPage(page);
  expect(heading()).toBe("Такой страницы не существует!");
  expect(links()).toEqual([["На главную", "/"]]);
  // Opened directly: nothing to go back to.
  expect(page.container.querySelector("button")).toBeNull();
  expect(page.container.textContent).not.toContain("Вход");
});

it("GL-21: refusals and missing objects keep a title and a way to their list", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/events/new" element={<EventCreatePage />} /></Routes>, { role: "organizer", path: "/events/new" });
  await waitForPage(page);
  expect(heading()).toBe("Новое мероприятие");expect(links()).toContainEqual(["Все мероприятия", "/events"]);
  await page.cleanup();
  for (const [path, route, element, title] of [["/events/bogus", "/events/:id", <EventPage />, "Мероприятие"], ["/subevents/bogus", "/subevents/:id", <SubeventPage />, "Подмероприятие"]] as const) {
    page = await mountWorkspace(<Routes><Route path={route} element={element} /></Routes>, { role: "organizer", path });
    await waitForPage(page, () => !!page!.container.querySelector('[role="alert"]'));
    expect(heading()).toBe(title);expect(links()).toContainEqual(["Все мероприятия", "/events"]);
    await page.cleanup();
  }
  page = await mountWorkspace(<Routes><Route path="/reports" element={<ReportsPage />} /></Routes>, { role: "organizer", path: "/reports?owner_kind=subevent&owner_id=bogus" });
  await waitForPage(page, () => !!page!.container.querySelector('[role="alert"]'));
  expect(page.container.textContent).not.toContain("Отчётов пока нет");
});

it("GL-21: without a queue the new task page still says where to go", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  mock.state.queues.splice(0);
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /></Routes>, { role: "organizer", path: "/tasks/new" });
  await waitForPage(page, () => !!page!.container.querySelector("h1"));
  expect(heading()).toBe("Новая задача");expect(links()).toContainEqual(["Очереди", "/tasks/queues"]);
});
