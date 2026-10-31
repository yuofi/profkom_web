// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { EventsListPage, EventCreatePage, EventEditPage } from "./EventPages";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { SessionContext } from "../../utils/session";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";

const { editorModuleLoaded } = vi.hoisted(() => ({ editorModuleLoaded: vi.fn() }));
vi.mock("./EventEditor", async importOriginal => {
  editorModuleLoaded();
  return await importOriginal<typeof import("./EventEditor")>();
});
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();mock?.restore(); });

it("loads the real event editor only after an authorized create action and retains its save flow", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<EventCreatePage />, { role: "organizer" });await waitForPage(page);
  expect(page.container.textContent).toContain("Создавать мероприятия могут председатель");
  expect(editorModuleLoaded).not.toHaveBeenCalled();
  await page.cleanup();mock.restore();

  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/events" element={<EventsListPage />} /><Route path="/events/new" element={<EventCreatePage />} /><Route path="/events/:id" element={<h1>Сохранённое мероприятие</h1>} /></Routes>, { role: "chair", path: "/events" });
  await waitForPage(page);expect(editorModuleLoaded).not.toHaveBeenCalled();
  expect(page.container.querySelector('[name="description"]')).toBeNull();
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/events/new"]')!.click());
  await waitForPage(page, () => !!page!.container.querySelector('[name="description"]'));
  expect(editorModuleLoaded).toHaveBeenCalledOnce();
  await change(field(page.container, "title"), "Отложенный редактор");
  await change(field(page.container, "description"), "Сохранить **Markdown**");
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(mock.state.events.at(-1)).toMatchObject({ title: "Отложенный редактор", description: { body: "Сохранить **Markdown**" } });
});
it("leaving an edited existing event can save on the way instead of offering a dead button", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  mock = installMockTransport("chair", { delay: 0 });const event = mock.state.events[0];
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [{ path: "/events/:id/edit", element: <EventEditPage /> }, { path: "/events", element: <h1>Календарь</h1> }] }], { initialEntries: [`/events/${event.event_id}/edit`] });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: mock!.state.session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  const view = { container, client, router };
  try {
    await waitForPage(view, () => !!container.querySelector('[name="description"]'));
    await change(field(container, "title"), "Новое имя при уходе");
    await act(async () => { void router.navigate("/events"); });await waitForPage(view, () => !!container.querySelector("dialog"));
    expect([...container.querySelectorAll("dialog button")].map(item => item.textContent)).toEqual(["Сохранить и перейти", "Уйти без сохранения", "Остаться"]);
    await act(async () => container.querySelector<HTMLButtonElement>("dialog button")!.click());await waitForPage(view, () => router.state.location.pathname === "/events");
    expect(mock.state.events.find(item => item.event_id === event.event_id)?.title).toBe("Новое имя при уходе");
  } finally { await act(async () => root.unmount());router.dispose();client.clear();container.remove(); }
});
