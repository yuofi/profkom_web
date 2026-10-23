// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { focusManager } from "@tanstack/react-query";
import axios from "axios";
import Cookies from "js-cookie";
import { api } from "../../utils/api";
import { liveLogin, liveParticipant, livePassword } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { authApi } from "../../utils/api/auth.api";
import { adminApi } from "../../utils/api/admin.api";
import { membershipApi } from "../../utils/api/membership.api";
import type { Session } from "../../utils/api/contract";
import { UserProvider } from "../../utils/ctx";
import { ProtectedRoute } from "../Wrappers/wrappers";
import { BlockRequestsPage } from "../Workspace/MembershipPages";
import { AdminPanel } from "./AdminPage";

// Step 7 of release 1 against the live local API: the cabinet (АВ-34), the waiting
// registrations first (A-ROL-21), PGAS admins (decision 14), temporary passwords (АВ-52),
// an ended session (A-FE-4) and the rejection reason (decision 16).
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; Cookies.remove("access_token"); });
const until = (predicate: () => boolean) => waitForPage(page!, predicate);
const text = () => page!.container.textContent ?? "";
async function mount(path: string, routes: ReactNode) {
  page = await mountWorkspace(<UserProvider><Routes>
    <Route path="/auth" element={<p>LOGIN</p>} />
    <Route element={<ProtectedRoute />}>{routes}</Route>
  </Routes></UserProvider>, { path });
}
const cabinet = (path: string) => mount(path, <>
  <Route path="/admin" element={<AdminPanel />} />
  <Route path="/admin/:tab" element={<AdminPanel />} />
</>);
async function chairClient() {
  const baseURL = api.defaults.baseURL!;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL).hostname);
  const login = await axios.post(`${baseURL}/auth/login`, { email: "chair@example.com", password: livePassword });
  return axios.create({ baseURL, headers: { Authorization: `Bearer ${login.data.access_token}` } });
}
async function click(label: string, scope: ParentNode = page!.container) {
  const b = Array.from(scope.querySelectorAll("button")).find((x) => x.textContent === label);
  expect(b, label).toBeDefined(); await act(async () => b!.click()); await waitForPage(page!);
}

it("АВ-34, A-ROL-21: the cabinet opens on the waiting registrations", async () => {
  const label = `Ожидающая${crypto.randomUUID().slice(0, 6)}`;
  await authApi.register({ email: `integration-${label}@example.com`, password: livePassword, surname: "Заявка", name: label,
    patronymic: "", group_number: 305, tg: "@profkom_test", phone: "+79990000000", vk: "https://vk.com/id123", funding: "contract", residence: "Тест" });
  await liveLogin();
  await cabinet("/admin");
  await until(() => text().includes(`Заявка ${label}`));
  expect(page!.container.querySelector("h1")?.textContent).toBe("Регистрации");
  expect(field(page!.container, "status").value).toBe("pending");
  const card = Array.from(page!.container.querySelectorAll("section")).find((s) => s.querySelector("h2")?.textContent === `Заявка ${label}`)!;
  expect(card.textContent).toContain("Контракт");
  await change(field(page!.container, "status"), "approved");
  await until(() => !text().includes(`Заявка ${label}`));
});

it("decision 14: the chair gives the PGAS right in the cabinet and takes it back", async () => {
  const person = await liveParticipant("pgas");
  await cabinet("/admin/pgas");
  await until(() => !!page!.container.querySelector('[name="user"]'));
  const give = Array.from(page!.container.querySelectorAll("form")).find((f) => f.textContent?.includes("Выдать право"))!;
  await change(field(give, "user"), String(person.user_id));
  await submit(give);
  const adminCard = () => Array.from(page!.container.querySelectorAll("section")).find((s) => !!s.querySelector("h2")?.textContent?.includes("pgas"));
  await until(() => !!adminCard());
  const chair = await chairClient();
  const login = await axios.post(`${api.defaults.baseURL}/auth/login`, { email: person.email, password: livePassword });
  const own = () => axios.get<Session>(`${api.defaults.baseURL}/session`, { headers: { Authorization: `Bearer ${login.data.access_token}` } });
  expect((await own()).data.capabilities).toContain("manage_pgas");
  await click("Снять право", adminCard()!);
  await until(() => !adminCard());
  expect((await own()).data.capabilities).not.toContain("manage_pgas");
  expect((await chair.get("/pgas-admins")).data.items.map((a: { user_id: number }) => a.user_id)).not.toContain(person.user_id);
});

it("АВ-52: a temporary password signs in only to its change", async () => {
  const person = await liveParticipant("temporary");
  await liveLogin();
  const issued = await adminApi.temporaryPassword(person.user_id);
  Cookies.remove("access_token");
  const login = await authApi.login({ email: person.email, password: issued.temporary_password });
  Cookies.set("access_token", login.data.access_token);
  await mount("/", <Route path="/" element={<p>ACTIVE_WORKSPACE</p>} />);
  await until(() => text().includes("Смените временный пароль"));
  expect(text()).not.toContain("ACTIVE_WORKSPACE");
  const form = page!.container.querySelector("form")!;
  await change(field(form, "old"), issued.temporary_password);
  await change(field(form, "password"), "Own-Integration-2026");
  await change(field(form, "again"), "Own-Integration-2026");
  await submit(form);
  await until(() => text().includes("Пароль изменён"));
  await expect(authApi.login({ email: person.email, password: issued.temporary_password })).rejects.toMatchObject({ response: { status: 401 } });
  expect((await authApi.login({ email: person.email, password: "Own-Integration-2026" })).status).toBe(200);
});

it("A-FE-4: an archived participant's page keeps nothing private and goes to the login", async () => {
  const person = await liveParticipant("archived");
  await liveLogin(person.email);
  await mount("/", <Route path="/" element={<p>ACTIVE_WORKSPACE</p>} />);
  await until(() => text().includes("ACTIVE_WORKSPACE"));
  page!.client.setQueryData(["contacts"], [{ user_id: 1, surname: "Закрытый" }]);
  await (await chairClient()).post(`/accounts/${person.user_id}/archive`, { reason: "Интеграционная проверка" });
  // The window gets the focus back: the session is reread (refetchOnWindowFocus).
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
  focusManager.setFocused(undefined);
  await until(() => text().includes("LOGIN"));
  // Only the refused session read stays, and it holds nothing (dropRefusedData empties it).
  const cache = page!.client.getQueryCache().getAll();
  expect(cache.filter((q) => q.state.data != null).map((q) => q.queryKey)).toEqual([]);
  expect(cache.some((q) => q.queryKey[0] === "session")).toBe(true);
  expect(Cookies.get("access_token")).toBeUndefined();
});

it("decision 16: the applicant reads why the request was rejected", async () => {
  const person = await liveParticipant("rejected-request");
  await liveLogin(person.email);
  const it = (await membershipApi.blocks()).find((b) => b.name === "Integration IT")!;
  const request = await membershipApi.join(it.block_id);
  await liveLogin();
  await membershipApi.requestCommand(request.request_id, "reject", { expected_revision: request.revision, reason: "Набор в блок закрыт" });
  await liveLogin(person.email);
  await mount("/blocks/requests", <Route path="/blocks/requests" element={<BlockRequestsPage />} />);
  await until(() => text().includes("Мои заявки"));
  const mine = page!.container.querySelector('[aria-label="Мои заявки"]')!;
  expect(mine.textContent).toContain("Причина отказа: Набор в блок закрыт");
  expect(mine.textContent).toContain("Решение:");
});
