// @vitest-environment jsdom
import { act } from "react";
import { useQuery } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures, mockVkId } from "../../mocks/fixtures";
import { mountWorkspace, settle, submit, waitForPage } from "../../test/workspace";
import { UserProvider } from "../../utils/ctx";
import { ProtectedRoute } from "../Wrappers/wrappers";
import { WorkspaceLayout } from "../../components/Workspace/WorkspaceLayout";
import { BotLinkBanner } from "../../components/Workspace/BotLinkBanner";
import { ProfileSettingsPage } from "../ProfilePage/ProfileSettingsPage";
import { AccountStatePage, BotLinkRequiredPage } from "./SessionPages";
import { RegistrationsPage } from "./MembershipPages";
import { membershipApi } from "../../utils/api/membership.api";
import { ApiError, normalizeApiError } from "../../utils/api/request";
import type { Session, SessionBotLink } from "../../utils/api/contract";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;sessionStorage.clear();vi.restoreAllMocks(); });

const text = () => (page!.container.textContent ?? "").replace(/\u00a0/g, " ");
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
const active = (link: SessionBotLink | null, extra: Partial<Session> = {}): Session => ({ ...createFixtures("organizer").session, bot_link: link, ...extra });
const before: SessionBotLink = { state: "none", required: false, blocked: false, deadline: "2026-12-01T00:00:00+03:00" };
const overdue: SessionBotLink = { state: "none", required: true, blocked: true, deadline: "2026-11-01T00:00:00+03:00" };
const protectedRoutes = <Routes>
  <Route element={<ProtectedRoute />}><Route path="/" element={<p>WORKSPACE_OUTLET</p>} /></Route>
</Routes>;
async function lazyPages() { await import("./SessionPages");await settle();await settle(); }

it("routes a blocked active account to the gate page with its own frame and logout", async () => {
  mock = installMockTransport("organizer", { delay: 0, bot: "blocked" });
  page = await mountWorkspace(protectedRoutes, { session: active(overdue) });
  await lazyPages();await waitForPage(page, () => !!page!.container.querySelector("h1"));
  expect(page.container.querySelector("h1")?.textContent).toBe("Привяжите бота ВКонтакте");
  expect(page.container.querySelector('[aria-current="page"]')?.textContent).toBe("Профком ВМК · Бот ВКонтакте");
  expect(text()).not.toContain("WORKSPACE_OUTLET");
  expect(page.container.querySelector('nav[aria-label="Основная навигация"]')).toBeNull();
  expect(text()).toContain("Бот не привязан.");
  expect(button("Получить код")).toBeDefined();expect(button("Выйти")).toBeDefined();
});

it("asks for the temporary password first, and lets a working session through", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(protectedRoutes, { session: active(overdue, { password_change_required: true }) });
  await lazyPages();
  expect(page.container.querySelector("h1")?.textContent).toBe("Смените временный пароль");
  await page.cleanup();
  page = await mountWorkspace(protectedRoutes, { session: active({ ...overdue, state: "ok", blocked: false }) });
  await lazyPages();
  expect(text()).toContain("WORKSPACE_OUTLET");
});

function Probe() {
  // Any working read of the workspace.
  const blocks = useQuery({ queryKey: ["blocks", "probe"], queryFn: membershipApi.blocks, retry: false });
  return <p>{blocks.error ? `PROBE_ERROR:${normalizeApiError(blocks.error).code}` : blocks.data ? "PROBE_OK" : "PROBE_LOADING"}</p>;
}
it("a 403 bot_link_required of any request rereads the session, and the gate appears", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<UserProvider><Routes><Route element={<ProtectedRoute />}><Route path="/" element={<Probe />} /></Route></Routes></UserProvider>);
  await lazyPages();await waitForPage(page, () => text().includes("PROBE_OK"));
  // The deadline passes while the page is open; only the next request learns it.
  mock.bot.overdue = true;mock.bot.state = "none";mock.syncBot();
  const sessionReads = () => mock!.adapter.history.get.filter((request) => request.url === "/session").length;
  const readsBefore = sessionReads();
  await act(async () => { await page!.client.refetchQueries({ queryKey: ["blocks", "probe"] }); });
  await lazyPages();await waitForPage(page, () => text().includes("Привяжите бота ВКонтакте"));
  expect(sessionReads()).toBeGreaterThan(readsBefore);
  expect(text()).not.toContain("PROBE_");
});

it("lets the account in once the bot confirms the code on the gate page", async () => {
  mock = installMockTransport("organizer", { delay: 0, bot: "blocked" });
  mock.bot.confirmAfterPolls = 1;
  page = await mountWorkspace(<UserProvider>{protectedRoutes}</UserProvider>);
  await lazyPages();await waitForPage(page, () => !!button("Получить код"));
  await act(async () => button("Получить код")!.click());
  await waitForPage(page, () => /[0-9A-Z]{5}-[0-9A-Z]{5}/.test(text()));
  // The next poll: the synthetic bot has used the code; the session is reread and opens.
  await act(async () => { await page!.client.refetchQueries({ queryKey: ["botLink", "me"] }); });
  await waitForPage(page, () => text().includes("WORKSPACE_OUTLET"));
  expect(mock.state.session.bot_link).toMatchObject({ state: "ok", blocked: false });
});

it("reminds an active account before the deadline and hides the reminder for the tab", async () => {
  page = await mountWorkspace(<BotLinkBanner />, { session: active(before) });
  expect(text()).toBe("Привяжите бота ВКонтакте до 1 дек. 2026 г., 00:00. Привязать Скрыть");
  expect(page.container.querySelector("a")?.getAttribute("href")).toBe("/profile/settings#bot");
  await act(async () => button("Скрыть")!.click());
  expect(page.container.innerHTML).toBe("");
  await page.cleanup();
  page = await mountWorkspace(<BotLinkBanner />, { session: active(before) });
  expect(page.container.innerHTML).toBe("");
});

it.each([
  ["without a deadline", { ...before, deadline: null }, "Привяжите бота ВКонтакте: скоро это станет обязательным. Привязать Скрыть"],
  ["a broken link", { ...before, state: "token_invalid" as const }, "Бот ВКонтакте настроен не до конца: исправьте до 1 дек. 2026 г., 00:00. Исправить Скрыть"],
  ["a working link", { ...before, state: "ok" as const }, ""],
  ["after the deadline (the gate instead)", overdue, ""],
  ["the integration off", null, ""],
])("the reminder %s", async (_name, link, expected) => {
  page = await mountWorkspace(<BotLinkBanner />, { session: active(link) });
  expect(text()).toBe(expected);
});

it("keeps the reminder off the pending screen and off the settings page it leads to", async () => {
  page = await mountWorkspace(<BotLinkBanner />, { session: { ...createFixtures("pending").session, bot_link: { ...before, required: true } } });
  expect(page.container.innerHTML).toBe("");
  await page.cleanup();
  page = await mountWorkspace(<BotLinkBanner />, { session: active(before), path: "/profile/settings" });
  expect(page.container.innerHTML).toBe("");
});

it("shows the reminder inside the workspace frame", async () => {
  mock = installMockTransport("organizer", { delay: 0, bot: "none" });
  page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/" element={<h1>Рабочий экран</h1>} /></Route></Routes>, { session: structuredClone(mock.state.session) });
  await waitForPage(page);
  expect(page.container.querySelector('main [role="note"]')?.textContent?.replace(/\u00a0/g, " ")).toContain("Привяжите бота ВКонтакте до 1 дек. 2026 г., 00:00.");
});

it("puts the «Бот ВКонтакте» block in the profile settings, before the notification channels", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<ProfileSettingsPage />, { session: structuredClone(mock.state.session), path: "/profile/settings#bot" });
  await waitForPage(page, () => text().includes("Бот привязан."));
  const cards = [...page.container.querySelectorAll("section > h2")].map((h) => h.textContent);
  expect(cards.slice(0, 2)).toEqual(["Бот ВКонтакте", "Уведомления вне сайта"]);
  expect(page.container.querySelector("#bot h2")?.textContent).toBe("Бот ВКонтакте");
  expect(text()).toContain(`Страница ВКонтакте: id${mockVkId(mock.state.session.user_id)}.`);
  expect(text()).toContain("Привязка обязательна с 1 дек. 2026 г., 00:00.");
  expect(page.container.querySelector("#bot")?.textContent).toContain("Уведомления сайта приходят в VK по настройкам ниже.");
});

it("makes the bot a required step of a pending registration, and the demo bot completes it", async () => {
  mock = installMockTransport("pending", { delay: 0 });
  mock.state.registration.fields.no_patronymic = true;
  page = await mountWorkspace(<AccountStatePage />, { session: structuredClone(mock.state.session) });
  await waitForPage(page, () => text().includes("Бот не привязан."));
  expect(page.container.querySelector('[role="status"]')?.textContent).toBe("Привяжите бота ВКонтакте ниже. Заявка уйдёт на рассмотрение, когда все сведения будут сохранены и бот будет привязан.");
  expect(text()).toContain("Обязательный шаг регистрации");
  await act(async () => button("Получить код")!.click());
  await waitForPage(page, () => text().includes("Ваш код"));
  for (let poll = 0; poll < 2; poll++) await act(async () => { await page!.client.refetchQueries({ queryKey: ["botLink", "me"] }); });
  await waitForPage(page, () => text().includes("Бот привязан."));
  // The own application was reread: it is ready and waits for the decision.
  await waitForPage(page, () => text().includes("Дождитесь решения руководства Профкома."));
  expect(mock.state.registration.bot_link).toEqual({ state: "ok", vk_user_id: mockVkId(mock.state.session.user_id) });
  // No notification settings here: the profile settings' line about them is not shown.
  expect(text()).not.toContain("по настройкам ниже");
});

it("asks a rejected applicant to link the bot before sending again", async () => {
  mock = installMockTransport("rejected", { delay: 0 });
  mock.state.registration.fields.no_patronymic = true;
  page = await mountWorkspace(<AccountStatePage />, { session: structuredClone(mock.state.session) });
  await waitForPage(page, () => text().includes("Бот не привязан."));
  expect(text()).toContain("Перед повторной отправкой привяжите бота ВКонтакте ниже.");
  await submit(button("Повторно отправить заявку")!.closest("form")!);
  await waitForPage(page, () => text().includes("Сначала привяжите бота ВКонтакте."));
  expect(mock.state.registration.attempts_used).toBe(1);
});

it("keeps the registration screen as it was while the integration is off", async () => {
  mock = installMockTransport("pending", { delay: 0, bot: "off" });
  mock.state.registration.fields.no_patronymic = true;
  page = await mountWorkspace(<AccountStatePage />, { session: structuredClone(mock.state.session) });
  await waitForPage(page);
  expect(text()).toContain("Дождитесь решения руководства Профкома.");
  expect([...page.container.querySelectorAll("h2")].map((h) => h.textContent)).not.toContain("Бот ВКонтакте");
  expect(button("Получить код")).toBeUndefined();
  expect(mock.adapter.history.get.some((request) => request.url === "/bot-link/me")).toBe(false);
});

it("shows the applicant's bot to reviewers and holds «Одобрить» until it works", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.queueApplication.bot_link = { state: "token_missing", vk_user_id: mockVkId(105) };
  page = await mountWorkspace(<RegistrationsPage />);
  await waitForPage(page);
  expect(text()).toContain("Бот: нет токена");
  const approve = button("Одобрить")!;
  expect(approve.disabled).toBe(true);
  const reason = document.getElementById(approve.getAttribute("aria-describedby")!);
  expect(reason?.textContent).toBe("Одобрить можно, когда заявитель привяжет и настроит бота ВКонтакте.");
  expect(button("Отклонить")!.disabled).toBe(false);
});

it.each([
  ["none", "не привязан"], ["ok", "привязан"], ["messages_denied", "сообщения запрещены"], ["token_missing", "нет токена"], ["token_invalid", "токен не работает"],
] as const)("labels the applicant's link %s", async (state, label) => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.queueApplication.bot_link = { state, vk_user_id: state === "none" ? null : mockVkId(105) };
  page = await mountWorkspace(<RegistrationsPage />);
  await waitForPage(page);
  expect([...page.container.querySelectorAll("summary span span")].map((badge) => badge.textContent)).toContain(`Бот: ${label}`);
  expect(button("Одобрить")!.disabled).toBe(state !== "ok");
});

it("names the server's refusal of a not-ready application", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(membershipApi, "registrationCommand").mockRejectedValueOnce(new ApiError("The application is not ready", 409, "bot_link_required"));
  page = await mountWorkspace(<RegistrationsPage />);
  await waitForPage(page);
  await act(async () => button("Одобрить")!.click());
  await waitForPage(page, () => !!page!.container.querySelector('[role="alert"]'));
  expect(page.container.querySelector('[role="alert"]')?.textContent).toBe("Одобрить можно, когда заявитель привяжет и настроит бота ВКонтакте.");
});

it("shows no bot badge or hold while the integration is off", async () => {
  mock = installMockTransport("chair", { delay: 0, bot: "off" });
  page = await mountWorkspace(<RegistrationsPage />);
  await waitForPage(page);
  expect(text()).not.toContain("Бот:");
  expect(button("Одобрить")!.disabled).toBe(false);
});

it("the gate page itself renders the step inside its card", async () => {
  mock = installMockTransport("organizer", { delay: 0, bot: "blocked" });
  page = await mountWorkspace(<BotLinkRequiredPage />, { session: structuredClone(mock.state.session) });
  await waitForPage(page, () => text().includes("Бот не привязан."));
  const card = page.container.querySelector('section[aria-label="Бот ВКонтакте"]')!;
  expect(card.closest("section:not([aria-label])")?.querySelector("button")).toBeDefined();
  expect(text()).toContain("Срок привязки прошёл.");
});
