// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, change, field, settle, submit } from "../../test/workspace";
import { AdminPanel } from "./AdminPage";
import { AccountStatePage } from "../Workspace/SessionPages";
import { BlockRequestsPage } from "../Workspace/MembershipPages";
import { ProtectedRoute } from "../Wrappers/wrappers";
import { WorkspaceLayout } from "../../components/Workspace/WorkspaceLayout";
import { UserContext } from "../../utils/me";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; });

const cabinet = (role: Parameters<typeof installMockTransport>[0], path: string) => {
  mock = installMockTransport(role, { delay: 0 });
  return mountWorkspace(
    <Routes>
      <Route path="/admin" element={<AdminPanel />} />
      <Route path="/admin/:tab" element={<AdminPanel />} />
    </Routes>,
    { role, path },
  );
};
const tabs = () => Array.from(page!.container.querySelectorAll('nav[aria-label="Администрирование"] a')).map((a) => a.textContent);
const heading = () => page!.container.querySelector("h1")?.textContent;
async function clickButton(text: string) {
  const button = Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!button) throw Error(`Missing button: ${text}`);
  await act(async () => button.click()); await settle();
}
async function openPeople(container: ParentNode) {
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => input.focus()); await settle();
  return input;
}
async function choosePerson(container: ParentNode, value: string) {
  await openPeople(container);
  const option = document.querySelector<HTMLElement>(`[role="option"][data-option-value="${value}"]`)!;
  expect(option).not.toBeNull();
  expect(option.querySelector("img")).not.toBeNull();
  await act(async () => option.click()); await settle();
}

it("АВ-34: the cabinet opens on the registrations and shows the chair every tab", async () => {
  page = await cabinet("chair", "/admin");
  await settle(); await settle();
  expect(heading()).toBe("Регистрации");
  expect(tabs()).toEqual([
    "Заявки на регистрацию", "Председатель и замы", "Архив аккаунтов",
    "Администраторы ПГАС", "Сброс пароля",
  ]);
});

it("АВ-34: a deputy sees no archive; a participant sees no cabinet", async () => {
  page = await cabinet("chair-deputy", "/admin/accounts");
  await settle(); await settle();
  expect(heading()).toBe("Регистрации");
  expect(tabs()).not.toContain("Архив аккаунтов");
  await page.cleanup(); mock!.restore();
  page = await cabinet("organizer", "/admin/registrations");
  await settle();
  expect(page.container.textContent).toContain("Разделов администрирования для вас нет.");
  expect(tabs()).toEqual([]);
});

it("A-ROL-21: waiting registrations come first; the status filter asks the server", async () => {
  page = await cabinet("chair", "/admin/registrations");
  await settle(); await settle();
  expect(mock!.adapter.history.get.find((r) => r.url?.endsWith("/registrations"))?.params).toMatchObject({ status: "pending" });
  expect(page.container.textContent).toContain("Ожидает решения");
  expect(page.container.textContent).toContain("Отправок: 1/5");
  await change(field(page.container, "status"), "rejected");
  await settle(); await settle();
  expect(page.container.textContent).toContain("Отклонённые: заявок нет.");
  await change(field(page.container, "status"), "");
  await settle(); await settle();
  expect(page.container.textContent).toContain("Ожидает решения");
});

it("decision 14: the chair gives the PGAS right and takes it back", async () => {
  page = await cabinet("chair", "/admin/pgas");
  await settle(); await settle();
  expect(page.container.textContent).toContain("Иван Петров");
  const give = Array.from(page.container.querySelectorAll("form")).find((f) => f.textContent?.includes("Выдать право"))!;
  await choosePerson(give, "103");
  await submit(give);
  expect(JSON.parse(mock!.adapter.history.put.at(-1)!.data)).toEqual({ pgas_admin: true });
  expect(mock!.adapter.history.put.at(-1)!.url).toMatch(/\/users\/103\/pgas-admin$/);
  await clickButton("Снять право");
  expect(JSON.parse(mock!.adapter.history.put.at(-1)!.data)).toEqual({ pgas_admin: false });
});

it("АВ-52: a temporary password is shown once, and not for the chair or deputies", async () => {
  page = await cabinet("chair", "/admin/passwords");
  await settle(); await settle();
  const form = page.container.querySelector("form")!;
  await openPeople(form);
  const choices = Array.from(document.querySelectorAll('[role="option"]')).map(o => o.getAttribute("data-option-value"));
  expect(choices).not.toContain("104");
  expect(choices).not.toContain("105");
  await choosePerson(form, "101");
  await submit(form);
  expect(page.container.textContent).toContain("Временный пароль: synthetic-temporary");
  expect(page.container.textContent).toContain("Почта для входа: member101@example.com");
  await clickButton("Скрыть");
  expect(page.container.textContent).not.toContain("synthetic-temporary");
});

it("A-ROL-20: an unfinished VK application lists what to fill and preselects no basis", async () => {
  mock = installMockTransport("pending", { delay: 0 });
  Object.assign(mock.state.registration.fields, { group_number: "", funding: null, tg: "" });
  page = await mountWorkspace(<AccountStatePage />, { role: "pending" });
  await settle(); await settle();
  expect(page.container.textContent).toContain("Заполните обязательные поля: Группа, Telegram, Основа обучения.");
  expect(page.container.textContent).not.toContain("Дождитесь решения");
  expect(field(page.container, "funding").value).toBe("");
});

it("АВ-52: a temporary password opens only its change", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  mock.adapter.onPost(/\/auth\/change-password$/).reply(200, { detail: "Password updated successfully" });
  const session = { ...createFixtures("organizer").session, capabilities: [], password_change_required: true };
  page = await mountWorkspace(
    <Routes><Route element={<ProtectedRoute />}><Route path="/" element={<p>Рабочий экран</p>} /></Route></Routes>,
    { session },
  );
  expect(heading()).toBe("Смените временный пароль");
  expect(page.container.textContent).not.toContain("Рабочий экран");
  const form = page.container.querySelector("form")!;
  await change(field(form, "old"), "temporary-1");
  await change(field(form, "password"), "temporary-1");
  await change(field(form, "again"), "temporary-1");
  await submit(form);
  expect(form.textContent).toContain("Новый пароль должен отличаться от временного");
  await change(field(form, "password"), "Own-New-Pass-2026");
  await change(field(form, "again"), "Own-New-Pass-2026");
  await submit(form);
  expect(JSON.parse(mock.adapter.history.post.at(-1)!.data)).toEqual({ old_password: "temporary-1", new_password: "Own-New-Pass-2026" });
  expect(page.container.textContent).toContain("Пароль изменён. Войдите с новым паролем.");
});

it("АВ-52: a VK-only account is asked to set a password; the cabinet is one menu item", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const fixtures = createFixtures("chair");
  page = await mountWorkspace(
    <UserContext.Provider value={{ ...fixtures.profile, has_password: false }}>
      <Routes><Route path="/" element={<WorkspaceLayout />}><Route index element={<p>Главная</p>} /></Route></Routes>
    </UserContext.Provider>,
  );
  await settle();
  expect(page.container.querySelector('[role="note"]')?.textContent).toContain("Задайте пароль");
  const links = Array.from(page.container.querySelectorAll("nav a")).map((a) => a.textContent);
  expect(links).toContain("Администрирование");
  expect(links).not.toContain("Регистрации");
  expect(links).not.toContain("Руководство");
});

it("A-ROL-3, decision 16: requests split into my decisions and history, with the wait and the reason", async () => {
  // The chair sees every request (a leader sees only those to decide).
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.requests.push({
    ...mock.state.requests[0], request_id: "request-old", state: "rejected", capabilities: [],
    decided_at: "2026-10-15T09:00:00Z", decision_reason: "Набор в блок закрыт", substitute_available_at: null,
  });
  page = await mountWorkspace(<BlockRequestsPage />, { role: "chair" });
  await settle(); await settle();
  const open = page.container.querySelector("section[aria-label]")!;
  expect(open.getAttribute("aria-label")).toMatch(/моё решение|Прочие открытые/);
  expect(open.textContent).toMatch(/ждёт \d+ дн\. \d+ ч/);
  const history = Array.from(page.container.querySelectorAll("details")).find((d) => d.querySelector("summary")?.textContent === "История · 1")!;
  expect(history.textContent).toContain("Причина отказа: Набор в блок закрыт");
  expect(history.textContent).toContain("Решение:");
});
