// @vitest-environment jsdom
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import MockAdapter from "axios-mock-adapter";
import axios from "axios";
import Cookies from "js-cookie";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../utils/api";
import { UserProvider } from "../../utils/ctx";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle, change, field, submit } from "../../test/workspace";
import { GreetingPage } from "../Greeting/Greeting";
import { ProtectedRoute } from "../Wrappers/wrappers";
import { AccountStatePage } from "./SessionPages";
import { useSession } from "../../utils/session";

vi.mock("../../components/VKAuth/authButton", () => ({
  VKAuthButton: ({ onSuccess, onError }: { onSuccess: (data: { access_token: string }) => Promise<void>; onError: () => void }) => <>
    <button type="button" onClick={() => void onSuccess({ access_token: "synthetic-vk-token" })}>VK test</button>
    <button type="button" onClick={onError}>VK error</button>
  </>,
}));

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let adapter: MockAdapter | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; adapter?.restore(); Cookies.remove("access_token"); vi.restoreAllMocks(); });

it.each(["pending", "rejected", "active"] as const)("A03: password and VK login use session-first for %s", async (state) => {
  for (const channel of ["password", "vk"]) {
    const f = createFixtures(state === "active" ? "organizer" : "pending");
    if (state === "rejected") { f.session.registration_status = "rejected"; f.registration.status = "rejected"; }
    adapter = new MockAdapter(api);
    const calls: string[] = [];
    adapter.onAny().reply((config) => {
      calls.push(config.url!);
      if (config.url === "/auth/login" || config.url === "/auth/vk") return [200, { access_token: "synthetic-login-token" }];
      if (config.url === "/session") return [200, f.session];
      if (config.url === "/profile/me") return state === "active" ? [200, f.profile] : [403, { detail: "Ожидайте одобрения" }];
      if (config.url === "/registrations/me") return [200, f.registration];
      return [404, {}];
    });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(["session"], createFixtures("pending").session);
    client.setQueryData(["old-account-secret"], "private");
    page = await mountWorkspace(<HelmetProvider><UserProvider><Routes>
      <Route path="/auth" element={<GreetingPage />} />
      <Route element={<ProtectedRoute />}><Route path="/" element={<p>ACTIVE_WORKSPACE</p>} /></Route>
    </Routes></UserProvider></HelmetProvider>, { path: "/auth", client });
    if (channel === "password") {
      await act(async () => page!.container.querySelector("h5")!.click());
      await change(field(page.container, "email"), "student@example.org");
      await change(field(page.container, "password"), "synthetic-password");
      await submit(page.container.querySelector("form")!);
    } else {
      await act(async () => Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent === "VK test")!.click());
    }
    await settle(); await settle();
    expect(calls[0]).toBe(channel === "password" ? "/auth/login" : "/auth/vk");
    expect(calls[1]).toBe("/session");
    expect(client.getQueryData(["old-account-secret"])).toBeUndefined();
    if (state === "active") {
      expect(calls).toContain("/profile/me");
      expect(page.container.textContent).toContain("ACTIVE_WORKSPACE");
    } else {
      expect(calls).not.toContain("/profile/me");
      expect(calls.every((url) => ["/auth/login", "/auth/vk", "/session", "/registrations/me"].includes(url))).toBe(true);
      expect(page.container.textContent).toContain(state === "rejected" ? "Нужно уточнить сведения" : "Заявка на рассмотрении");
    }
    await page.cleanup(); page = undefined; adapter.restore();
  }
});

it("A03: VK SDK and API failures are visible", async () => {
  adapter = new MockAdapter(api);
  // As backend/vk_auth.py answers when VK ID does not respond: a legacy string detail.
  adapter.onPost("/auth/vk").reply(503, { detail: "VK ID is unavailable" });
  page = await mountWorkspace(<HelmetProvider><GreetingPage /></HelmetProvider>);
  await act(async () => Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent === "VK error")!.click());
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось войти через VK");
  await act(async () => Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent === "VK test")!.click());
  await settle();
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("VK временно недоступен");
  expect(page.container.querySelector('[role="alert"]')?.textContent).not.toContain("VK ID is");
});

it("A03: pending logout revokes the server session and clears private caches before navigation", async () => {
  const f = createFixtures("pending");
  adapter = new MockAdapter(api);
  adapter.onGet("/registrations/me").reply(200, f.registration);
  adapter.onPost("/auth/logout").reply(200, {});
  page = await mountWorkspace(<Routes><Route path="/" element={<AccountStatePage />} /><Route path="/auth" element={<p>AUTH_SCREEN</p>} /></Routes>, { role: "pending" });
  await settle();
  Cookies.set("access_token", "synthetic-token");
  page.client.setQueryData(["session"], f.session);
  page.client.setQueryData(["private"], "secret");
  await act(async () => Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent === "Ко входу")!.click());
  await settle();
  expect(adapter.history.post.map((r) => r.url)).toEqual(["/auth/logout"]);
  expect(Cookies.get("access_token")).toBeUndefined();
  expect(page.client.getQueryData(["session"])).toBeNull();
  expect(page.client.getQueryData(["private"])).toBeUndefined();
  expect(page.container.textContent).toContain("AUTH_SCREEN");
});

it("A03: logout network error stays actionable; pending refresh never reads a profile", async () => {
  const f = createFixtures("pending");
  adapter = new MockAdapter(api);
  adapter.onGet("/session").reply(200, f.session);
  adapter.onGet("/registrations/me").reply(200, f.registration);
  adapter.onPost("/auth/logout").networkError();
  function Screen() { const { refresh } = useSession(); return <><button onClick={refresh}>Refresh</button><AccountStatePage /></>; }
  page = await mountWorkspace(<UserProvider><Screen /></UserProvider>);
  await settle(); await settle();
  await act(async () => Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent === "Refresh")!.click());
  await settle();
  expect(adapter.history.get.some((r) => r.url === "/profile/me")).toBe(false);
  await act(async () => Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent === "Ко входу")!.click());
  await settle();
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось завершить сессию");
  expect(page.container.textContent).toContain("Ко входу");
});

it("A-FE-4: a session the server ended leaves nothing private in the cache", async () => {
  adapter = new MockAdapter(api);
  const refresh = new MockAdapter(axios);
  try {
    Cookies.set("access_token", "revoked");
    adapter.onGet("/session").reply(401, { detail: "Session revoked" });
    refresh.onPost(/\/auth\/refresh$/).reply(401, { detail: "Refresh token not found (revoked or already used)" });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 0, retry: false } } });
    client.setQueryData(["session"], createFixtures("organizer").session);
    client.setQueryData(["tasks", "task-1"], { title: "Закрытая задача" });
    client.setQueryData(["contacts"], [{ user_id: 101 }]);
    page = await mountWorkspace(<UserProvider><Routes>
      <Route path="/auth" element={<p>LOGIN</p>} />
      <Route element={<ProtectedRoute />}><Route path="/" element={<p>ACTIVE_WORKSPACE</p>} /></Route>
    </Routes></UserProvider>, { client });
    await settle(); await settle();
    expect(page.container.textContent).toContain("LOGIN");
    // Nothing holds data: the session is emptied, the profile read waits for one (key null).
    expect(client.getQueryCache().getAll().filter((q) => q.state.data != null).map((q) => q.queryKey)).toEqual([]);
    expect(client.getQueryData(["session"])).toBeNull();
    expect(Cookies.get("access_token")).toBeUndefined();
  } finally {
    refresh.restore();
  }
});
