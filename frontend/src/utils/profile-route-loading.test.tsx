// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { UserProvider } from "./ctx";
import { ProtectedRoute } from "../pages/Wrappers/wrappers";
import MockAdapter from "axios-mock-adapter";
import { createFixtures } from "../mocks/fixtures";
import { api } from "./api";
import { workspaceApi } from "./api/workspace.api";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let transport: { adapter: MockAdapter; state: ReturnType<typeof createFixtures> };
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let router: ReturnType<typeof createMemoryRouter>;
let releaseProfile: (() => void) | undefined;

afterEach(async () => {
  await act(async () => { releaseProfile?.();root?.unmount(); });
  router?.dispose();client?.clear();transport?.adapter.restore();
  document.body.innerHTML = "";releaseProfile = undefined;
});

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(predicate()).toBe(true);
}

async function mount(path: string) {
  transport = { adapter: new MockAdapter(api), state: createFixtures("organizer") };
  transport.adapter.onGet("/session").reply(200, transport.state.session);
  transport.adapter.onGet("/workspace/home").reply(200, {
    today: "2026-10-29", agenda: [], tasks: [], overdue_tasks: [],
    overdue_count: 0, undated_count: 0, approvals: [], merit_entries: [],
  });
  transport.adapter.onGet("/profile/me").reply(() => new Promise<[number, unknown]>(resolve => {
    releaseProfile = () => resolve([200, transport.state.profile]);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  function Screen() {
    const data = useQuery({ queryKey: ["test-workspace-data"], queryFn: () => workspaceApi.home() });
    return <span>{data.data ? "Workspace ready" : "Workspace waiting"}</span>;
  }
  router = createMemoryRouter([{ element: <ProtectedRoute />, children: [{ path, element: <Screen /> }] }], { initialEntries: [path] });
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={client}><UserProvider><RouterProvider router={router} /></UserProvider></QueryClientProvider>));
  await until(() => !!releaseProfile);
  return container;
}

it("loads authorized workspace data alongside the pending personal profile", async () => {
  const container = await mount("/tasks");
  await until(() => container.textContent === "Workspace ready");
  expect(transport.adapter.history.get.some(request => request.url === "/workspace/home")).toBe(true);
  expect(client.getQueryData(["currentUser", transport.state.session.user_id])).toBeUndefined();
  await act(async () => releaseProfile!());
  await until(() => client.isFetching() === 0);
});

it.each(["/profile", "/profile/edit", "/profile/settings"])("keeps %s unmounted until its profile initial values are ready", async path => {
  const container = await mount(path);
  expect(container.textContent).not.toContain("Workspace");
  expect(transport.adapter.history.get.some(request => request.url === "/workspace/home")).toBe(false);
  await act(async () => releaseProfile!());
  await until(() => container.textContent === "Workspace ready");
});
