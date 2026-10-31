// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { change, settle, waitForPage } from "../../test/workspace";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { SessionContext } from "../../utils/session";
import { workspaceQueryCache } from "../../utils/api/invalidation";
import { workspaceApi } from "../../utils/api/workspace.api";
import { EventsListPage } from "./EventPages";
import { CalendarPage, DashboardPage } from "./WorkspacePages";

type Mounted = Awaited<ReturnType<typeof mount>>;
let page: Mounted | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

/** A data router with a previous page, so "Back" shows whether filters added history entries. */
async function mount(path: string) {
  const container = document.createElement("div");document.body.append(container);
  const root = createRoot(container), client = new QueryClient({ queryCache: workspaceQueryCache(), defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const router = createMemoryRouter([
    { path: "/previous", element: <p>Предыдущая страница</p> },
    { path: "/events", element: <EventsListPage /> },
    { path: "/calendar", element: <CalendarPage /> },
    { path: "/", element: <DashboardPage /> },
  ], { initialEntries: ["/previous", path], initialIndex: 1 });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: createFixtures("chair").session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  const result = { container, client, router, cleanup: async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove(); } };
  await waitForPage(result);return result;
}
async function type(input: HTMLInputElement, text: string) { for (let length = 1; length <= text.length; length++) await change(input, text.slice(0, length)); await settle(); }
async function back() { await act(async () => { await page!.router.navigate(-1); }); await settle(); }

it("event search, participation and phase filters replace the history entry (EV-03)", async () => {
  mock = installMockTransport("chair", { delay: 0 });page = await mount("/events");
  await type(page.container.querySelector<HTMLInputElement>('input[type="search"]')!, "Посвят");
  expect(page.router.state.location.search).toBe(`?q=${encodeURIComponent("Посвят")}`);
  await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>('[aria-label="Показать мероприятия"] button')].find(item => item.getAttribute("aria-label") === "Ближайшие")!.click());
  await change([...page.container.querySelectorAll<HTMLSelectElement>("select")][0], "mine");
  expect(new URLSearchParams(page.router.state.location.search).get("phase")).toBe("upcoming");
  expect(page.router.state.historyAction).toBe("REPLACE");
  await back();
  expect(page.router.state.location.pathname).toBe("/previous");
});

it("calendar search and filters replace the entry, while period navigation still adds steps (EV-03)", async () => {
  mock = installMockTransport("chair", { delay: 0 });page = await mount("/calendar?view=week&date=2026-11-02&month=2026-11");
  await type(page.container.querySelector<HTMLInputElement>('input[placeholder="Название или ключ задачи"]')!, "Созвон");
  await change(page.container.querySelector<HTMLSelectElement>("select")!, "all");
  expect(new URLSearchParams(page.router.state.location.search).get("q")).toBe("Созвон");
  expect(new URLSearchParams(page.router.state.location.search).get("mine")).toBe("false");
  await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === "Следующая неделя")!.click());await settle();
  expect(page.router.state.historyAction).toBe("PUSH");
  expect(new URLSearchParams(page.router.state.location.search).get("date")).toBe("2026-11-09");
  await back();
  expect(new URLSearchParams(page.router.state.location.search).get("date")).toBe("2026-11-02");
  expect(new URLSearchParams(page.router.state.location.search).get("q")).toBe("Созвон");
  await back();
  expect(page.router.state.location.pathname).toBe("/previous");
});

it("the watched-tasks choice is kept in the URL across returns without a history step (EV-31)", async () => {
  mock = installMockTransport("chair", { delay: 0 });const home = vi.spyOn(workspaceApi, "home");
  page = await mount("/");
  const box = () => page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(box().checked).toBe(false);
  await act(async () => box().click());await waitForPage(page);
  expect(box().checked).toBe(true);
  expect(page.router.state.location.search).toBe("?watching=1");
  expect(page.router.state.historyAction).toBe("REPLACE");
  expect(home).toHaveBeenLastCalledWith(true);
  await act(async () => { await page!.router.navigate("/events"); });await waitForPage(page);
  await back();await waitForPage(page);
  expect(page.router.state.location.search).toBe("?watching=1");
  expect(box().checked).toBe(true);
});
