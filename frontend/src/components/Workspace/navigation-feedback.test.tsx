// @vitest-environment jsdom
import { act, lazy, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryRouter, Link, Route, Routes, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle } from "../../test/workspace";
import { SessionContext } from "../../utils/session";
import { tasksApi } from "../../utils/api/tasks.api";
import { workspaceStaleTime } from "../../utils/routePrefetch";
import { ProtectedRoute } from "../../pages/Wrappers/wrappers";
import { WorkspaceLayout } from "./WorkspaceLayout";

let root: ReturnType<typeof createRoot> | undefined, client: QueryClient | undefined, router: ReturnType<typeof createMemoryRouter> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined, page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());await page?.cleanup();
  router?.dispose();client?.clear();mock?.restore();
  root = client = router = mock = page = undefined;document.body.innerHTML = "";vi.restoreAllMocks();
});

it("GL-14 and PF-04: a click shows progress at once and starts the task data beside its code", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const task = mock.state.tasks[0];
  const get = vi.spyOn(tasksApi, "get"), comments = vi.spyOn(tasksApi, "comments");
  let release: (() => void) | undefined;
  function TaskScreen() {
    const query = useQuery({ queryKey: ["tasks", task.task_id], queryFn: () => tasksApi.get(task.task_id) });
    return <h1>{query.data?.title ?? "…"}</h1>;
  }
  const Code = lazy(() => new Promise<{ default: ComponentType }>(resolve => { release = () => resolve({ default: TaskScreen }); }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: workspaceStaleTime } } });
  router = createMemoryRouter([{ element: <WorkspaceLayout />, children: [
    { path: "/", element: <Link to={`/tasks/${task.task_id}`}>Открыть задачу</Link> },
    { path: "/tasks/:id", element: <Code /> },
  ] }], { initialEntries: ["/"] });
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}><SessionContext.Provider value={{ session: mock!.state.session, loading: false, error: null, refresh() {} }}><RouterProvider router={router!} /></SessionContext.Provider></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  await act(async () => container.querySelector<HTMLAnchorElement>("main a")!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  // The old page is still shown while the code loads, but the bar and the data are under way.
  expect(container.querySelector("main")?.textContent).toContain("Открыть задачу");
  expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(get).toHaveBeenCalledWith(task.task_id);expect(comments).toHaveBeenCalledWith(task.task_id);
  await act(async () => { release!();await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.querySelector("main h1")?.textContent).toBe(task.title);
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  // The page reused the data that was started for it.
  expect(get).toHaveBeenCalledTimes(1);
});

it("GL-34: while the session is checked, the frame is drawn without its menu or user data", async () => {
  client = new QueryClient();
  router = createMemoryRouter([{ element: <ProtectedRoute />, children: [{ path: "/tasks", element: <p>Задачи</p> }] }], { initialEntries: ["/tasks"] });
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}><SessionContext.Provider value={{ session: null, loading: true, error: null, refresh() {} }}><RouterProvider router={router!} /></SessionContext.Provider></QueryClientProvider>));
  expect(container.querySelector('aside a[href="/"]')?.textContent).toContain("Профком");
  expect(container.querySelector("nav")).toBeNull();
  expect(container.querySelector('main [role="status"]')?.textContent).toBe("Загружаем данные…");
});

it("GL-19: the mobile menu closes on Escape and on a tap outside it", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/" element={<p>Главная страница</p>} /></Route></Routes>);
  await settle();
  const menu = page.container.querySelector<HTMLDetailsElement>("aside details")!;
  await act(async () => menu.setAttribute("open", ""));
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(menu.open).toBe(false);
  await act(async () => menu.setAttribute("open", ""));
  await act(async () => menu.querySelector("nav")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(menu.open).toBe(true);
  await act(async () => page!.container.querySelector("main")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(menu.open).toBe(false);
});

it("GL-36: the set-password note is not repeated on the page that sets it", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const f = createFixtures("chair");
  const { UserContext } = await import("../../utils/me");
  page = await mountWorkspace(<UserContext.Provider value={{ ...f.profile, has_password: false }}><Routes><Route element={<WorkspaceLayout />}>
    <Route path="/" element={<Link to="/profile/edit">Изменить</Link>} /><Route path="/profile/edit" element={<p>Редактор</p>} />
  </Route></Routes></UserContext.Provider>);
  await settle();
  expect(page.container.querySelector('main [role="note"]')?.textContent).toContain("Задайте пароль");
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('main > a, main p ~ a, main a[href="/profile/edit"]:not([role])')!.click());
  await settle();
  expect(page.container.textContent).toContain("Редактор");
  expect(page.container.querySelector('main [role="note"]')).toBeNull();
});
