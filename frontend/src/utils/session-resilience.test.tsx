// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import Cookies from "js-cookie";
import { afterEach, expect, it, vi } from "vitest";
import { UserProvider } from "./ctx";
import { ProtectedRoute } from "../pages/Wrappers/wrappers";
import { GreetingPage } from "../pages/Greeting/Greeting";
import { createFixtures } from "../mocks/fixtures";
import { api } from "./api";
import { request } from "./api/request";
import { returnPath } from "./returnPath";

vi.mock("../components/VKAuth/authButton", () => ({ VKAuthButton: () => <span>VK</span> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined, client: QueryClient | undefined, router: ReturnType<typeof createMemoryRouter> | undefined;
let adapter: MockAdapter | undefined, global: MockAdapter | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  router?.dispose();client?.clear();adapter?.restore();global?.restore();
  root = client = router = adapter = global = undefined;
  Cookies.remove("access_token");localStorage.clear();window.history.replaceState(null, "", "/");
  document.body.innerHTML = "";vi.restoreAllMocks();
});
async function until(predicate: () => boolean, timeout = 4000) {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeout)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(predicate()).toBe(true);
}
function Draft() {
  const data = useQuery({ queryKey: ["materials"], queryFn: () => request<{ items: unknown[] }>("get", "/materials") });
  return <><textarea name="draft" defaultValue="" /><p>{data.error ? "Ошибка страницы" : "Материалы"}</p></>;
}
function AuthProbe() {
  const state = useLocation().state as { from?: string } | null;
  return <p>Страница входа {state?.from ?? "без возврата"}</p>;
}
async function mount(path: string, auth = <AuthProbe />) {
  const f = createFixtures("organizer");
  adapter = new MockAdapter(api);global = new MockAdapter(axios);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  router = createMemoryRouter([
    { path: "/auth", element: auth },
    { element: <ProtectedRoute />, children: [{ path: "/tasks/:id", element: <Draft /> }, { path: "/profile", element: <p>Профиль</p> }] },
  ], { initialEntries: [path] });
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  return { f, container, render: () => act(async () => root!.render(<QueryClientProvider client={client!}><UserProvider><RouterProvider router={router!} /></UserProvider></QueryClientProvider>)) };
}

it("GL-02: one failed session poll keeps the page and the typed draft", async () => {
  const { f, container, render } = await mount("/tasks/task-1");
  let failures = 0;
  adapter!.onGet("/session").reply(() => failures-- > 0 ? [502, {}] : [200, f.session]);
  adapter!.onGet("/profile/me").reply(200, f.profile);
  adapter!.onGet("/materials").reply(200, { items: [], next_cursor: null });
  await render();
  await until(() => container.textContent!.includes("Материалы"));
  const draft = container.querySelector<HTMLTextAreaElement>("textarea")!;draft.value = "Черновик комментария";
  failures = 2;
  await act(async () => { await client!.refetchQueries({ queryKey: ["session"] }); });
  expect(failures).toBe(0);
  await until(() => !!container.querySelector('[role="status"]'));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Нет связи с сервером");
  expect(container.querySelector("textarea")).toBe(draft);expect(draft.value).toBe("Черновик комментария");
  await act(async () => container.querySelector<HTMLButtonElement>('[role="status"] button')!.click());
  await until(() => !container.querySelector('[role="status"]'));
  expect(container.querySelector("textarea")?.value).toBe("Черновик комментария");
}, 10_000);

it("GL-02: a failed profile read closes only the own profile pages", async () => {
  const { f, container, render } = await mount("/profile");
  adapter!.onGet("/session").reply(200, f.session);
  adapter!.onGet("/profile/me").reply(500, {});
  await render();
  await until(() => !!container.querySelector('[role="alert"]'));
  expect(container.textContent).not.toContain("Профиль");
  adapter!.onGet("/materials").reply(200, { items: [], next_cursor: null });
  await act(async () => { await router!.navigate("/tasks/task-1"); });
  await until(() => container.textContent!.includes("Материалы"));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("GL-06 and GL-13: a refused refresh routes to the login at once and remembers the page", async () => {
  const { f, container, render } = await mount("/tasks/task-1?tab=comments");
  let ended = false;
  adapter!.onGet("/session").reply(() => ended ? [401, {}] : [200, f.session]);
  adapter!.onGet("/profile/me").reply(200, f.profile);
  adapter!.onGet("/materials").reply(() => ended ? [401, {}] : [200, { items: [], next_cursor: null }]);
  global!.onPost(/\/auth\/refresh$/).reply(401, {});
  await render();
  await until(() => container.textContent!.includes("Материалы"));
  ended = true;
  await act(async () => { await client!.invalidateQueries({ queryKey: ["materials"] }); });
  await until(() => container.textContent!.includes("Страница входа"));
  expect(container.textContent).toContain("Страница входа /tasks/task-1?tab=comments");
  expect(client!.getQueryData(["materials"])).toBeUndefined();
});

it("GL-06: a refresh refused for a banned or archived account closes the page at once", async () => {
  const { f, container, render } = await mount("/tasks/task-1");
  let ended = false;
  adapter!.onGet("/session").reply(() => ended ? [401, {}] : [200, f.session]);
  adapter!.onGet("/profile/me").reply(200, f.profile);
  adapter!.onGet("/materials").reply(() => ended ? [401, {}] : [200, { items: [], next_cursor: null }]);
  global!.onPost(/\/auth\/refresh$/).reply(403, { detail: "Account is archived" });
  await render();
  await until(() => container.textContent!.includes("Материалы"));
  const reads = () => adapter!.history.get.filter(item => item.url === "/session").length, before = reads();
  ended = true;
  await act(async () => { await client!.invalidateQueries({ queryKey: ["materials"] }); });
  await until(() => reads() > before);
  await until(() => !container.querySelector("textarea"));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it("GL-06: a refused action rereads the session without waiting for the poll", async () => {
  const { f, container, render } = await mount("/tasks/task-1");
  adapter!.onGet("/session").reply(200, f.session);
  adapter!.onGet("/profile/me").reply(200, f.profile);
  adapter!.onGet("/materials").reply(200, { items: [], next_cursor: null });
  adapter!.onPost("/tasks/task-1/comments").reply(403, { detail: { code: "forbidden", message: "Нет доступа" } });
  await render();
  await until(() => container.textContent!.includes("Материалы"));
  const reads = () => adapter!.history.get.filter(item => item.url === "/session").length, before = reads();
  await act(async () => { await request("post", "/tasks/task-1/comments", { body: "x" }).catch(() => undefined); });
  await until(() => reads() === before + 1);
});

it("GL-26: a signed-in user leaves the login page for the remembered page", async () => {
  const { f, container, render } = await mount("/tasks/task-1", <GreetingPage />);
  adapter!.onGet("/session").reply(200, f.session);
  adapter!.onGet("/profile/me").reply(200, f.profile);
  adapter!.onGet("/materials").reply(200, { items: [], next_cursor: null });
  await render();
  await until(() => container.textContent!.includes("Материалы"));
  await act(async () => { await router!.navigate("/auth", { state: { from: "/tasks/task-1" } }); });
  await until(() => router!.state.location.pathname === "/tasks/task-1");
});

it("GL-26 and GL-12: an anonymous visitor gets one session check and a keyboard switch", async () => {
  window.history.replaceState(null, "", "/auth");
  const { container, render } = await mount("/auth", <GreetingPage />);
  adapter!.onGet("/session").reply(401, {});
  global!.onPost(/\/auth\/refresh$/).reply(401, {});
  await render();
  await until(() => adapter!.history.get.length === 1 && !!container.querySelector("button[aria-expanded]"));
  expect(global!.history.post).toHaveLength(0);
  const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(toggle.getAttribute("type")).toBe("button");expect(toggle.textContent).toBe("или войти с паролем");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await act(async () => toggle.click());
  expect(container.querySelector('input[name="password"]')).not.toBeNull();expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

it("GL-26: a browser that signed in before still tries the refresh on the login page", async () => {
  window.history.replaceState(null, "", "/auth");localStorage.setItem("profkom-signed-in", "1");
  const { container, render } = await mount("/auth", <GreetingPage />);
  adapter!.onGet("/session").reply(401, {});
  global!.onPost(/\/auth\/refresh$/).reply(401, {});
  await render();
  await until(() => !!container.querySelector("button[aria-expanded]") && global!.history.post.length === 1);
  await until(() => localStorage.getItem("profkom-signed-in") === null);
});

it("GL-13: only a path of this site other than the login is a return target", () => {
  expect(returnPath("/tasks/task-1?tab=comments#c1")).toBe("/tasks/task-1?tab=comments#c1");
  for (const unsafe of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "/auth", "/auth/vk", "tasks", null, 5])
    expect(returnPath(unsafe)).toBe("/");
});
