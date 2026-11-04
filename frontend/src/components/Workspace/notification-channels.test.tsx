// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport, type MockBotScenario } from "../../mocks/transport";
import { mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { UserProvider } from "../../utils/ctx";
import { botLinkApi } from "../../utils/api/botLink.api";
import { profileFeaturesApi, type NotificationPreferences as Preferences } from "../../utils/api/profileFeatures.api";
import { ProfileSettingsPage } from "../../pages/ProfilePage/ProfileSettingsPage";
import { NotificationPreferences } from "./NotificationPreferences";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });

const READY = "В VK уведомления приходят от бота сообщества: вид события, название и ссылка.";
const LINK = "Чтобы получать уведомления в VK, привяжите бота.";
const OFF = "Почта и Telegram пока не подключены: выбор сохраняется на будущее.";
const ALL_OFF = "Почта, Telegram и VK пока не подключены: выбор сохраняется на будущее.";
const FORMER = "Отправка ещё не подключена. Выбор сохраняется для будущего подключения каналов.";
const LINKED_NOTE = "Уведомления сайта приходят в VK по настройкам ниже.";
const text = () => (page!.container.textContent ?? "").replace(/\u00a0/g, " ");
const box = (label: string) => page!.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
const vkBoxes = () => ["Изменения тикетов трекера", "Новые и одобренные заявки", "Новые документы ПГАС"].map((row) => box(`${row}: VK`)!.checked);

it.each([
  ["ok", [READY, OFF], [LINK, ALL_OFF], [true, true, false]],
  ["none", [LINK, OFF], [READY, ALL_OFF], [false, false, false]],
  // Linked before, then messages denied: VK stays chosen, it needs the bot again.
  ["denied", [LINK, OFF], [READY, ALL_OFF], [true, true, false]],
  ["off", [ALL_OFF], [READY, LINK, OFF], [false, false, false]],
] as [MockBotScenario, string[], string[], boolean[]][])("says what each channel does when the demo bot is %s", async (bot, shown, hidden, vk) => {
  mock = installMockTransport("organizer", { delay: 0, bot });
  page = await mountWorkspace(<NotificationPreferences />, { session: structuredClone(mock.state.session) });
  await waitForPage(page, () => !!box("Изменения тикетов трекера: VK"));
  for (const phrase of shown) expect(text()).toContain(phrase);
  for (const phrase of hidden) expect(text()).not.toContain(phrase);
  expect(text()).not.toContain("Отправка ещё не подключена");
  expect(vkBoxes()).toEqual(vk);
  // A choice for a channel without sending is still kept: no box is locked.
  expect([...page.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((input) => input.disabled)).toEqual([]);
  // «привяжите бота» leads to the bot block of the same page.
  const link = page.container.querySelector<HTMLAnchorElement>('a[href="/profile/settings#bot"]');
  if (shown.includes(LINK)) expect(link?.textContent).toBe("привяжите бота");
  else expect(link).toBeNull();
});

it("keeps the former line and the usable table for an older server without channels", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const preferences: Preferences = { tracker: { email: false, telegram: false, vk: false }, applications: { email: false, telegram: false, vk: false }, pgas: { email: false, telegram: false, vk: false } };
  vi.spyOn(profileFeaturesApi, "preferences").mockResolvedValue({ revision: 1, preferences, delivery_status: "not_connected" });
  page = await mountWorkspace(<NotificationPreferences />, { session: structuredClone(mock.state.session) });
  await waitForPage(page, () => !!box("Новые документы ПГАС: Telegram"));
  expect(text()).toContain(FORMER);
  for (const phrase of [READY, LINK, OFF, ALL_OFF]) expect(text()).not.toContain(phrase);
  await act(async () => box("Новые документы ПГАС: Telegram")!.click());
  await submit(button("Сохранить настройки уведомлений")!.closest("form")!);
  await waitForPage(page, () => text().includes("Настройки сохранены"));
});

it("shows the bot's line only for a working link on the settings page", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<ProfileSettingsPage />, { session: structuredClone(mock.state.session), path: "/profile/settings" });
  await waitForPage(page, () => text().includes("Бот привязан.") && text().includes(READY));
  const bot = page.container.querySelector("#bot")!;
  expect(bot.textContent).toContain(LINKED_NOTE);
  await page.cleanup();mock.restore();
  mock = installMockTransport("organizer", { delay: 0, bot: "denied" });
  page = await mountWorkspace(<ProfileSettingsPage />, { session: structuredClone(mock.state.session), path: "/profile/settings" });
  await waitForPage(page, () => text().includes("сообщения от сообщества запрещены") && text().includes(LINK));
  expect(text()).not.toContain(LINKED_NOTE);
});

it("turns VK on for the tracker and applications at the first link, and the card follows at once", async () => {
  mock = installMockTransport("organizer", { delay: 0, bot: "none" });
  mock.bot.confirmAfterPolls = 1;
  page = await mountWorkspace(<UserProvider><ProfileSettingsPage /></UserProvider>, { path: "/profile/settings" });
  await waitForPage(page, () => text().includes(LINK) && !!button("Получить код"));
  expect(vkBoxes()).toEqual([false, false, false]);
  expect(text()).not.toContain(LINKED_NOTE);
  await act(async () => button("Получить код")!.click());
  await waitForPage(page, () => text().includes("Ваш код"));
  // The next poll: the synthetic bot has used the code; the session and the settings are reread.
  await act(async () => { await page!.client.refetchQueries({ queryKey: ["botLink", "me"] }); });
  await waitForPage(page, () => text().includes(READY));
  expect(text()).toContain(LINKED_NOTE);
  expect(text()).not.toContain(LINK);
  expect(vkBoxes()).toEqual([true, true, false]);
  expect(box("Изменения тикетов трекера: Почта")!.checked).toBe(false);
  // The card took the new revision: the next save is not a conflict.
  await act(async () => box("Новые документы ПГАС: VK")!.click());
  await submit(button("Сохранить настройки уведомлений")!.closest("form")!);
  await waitForPage(page, () => text().includes("Настройки сохранены"));
  const sent = JSON.parse(mock.adapter.history.put.find((request) => request.url === "/profile/me/notification-preferences")!.data);
  expect(sent.expected_revision).toBe(2);
  expect(sent.preferences.pgas.vk).toBe(true);
});

it("keeps a person's own VK choice when the bot is linked again (the demo mirrors the server rule)", async () => {
  mock = installMockTransport("organizer", { delay: 0, bot: "none" });
  mock.bot.confirmAfterPolls = 1;
  const link = async () => { await botLinkApi.createCode();await botLinkApi.me(); };
  await link();
  const first = await profileFeaturesApi.preferences();
  expect(first.revision).toBe(2);
  expect(first.channels).toEqual({ email: "not_connected", telegram: "not_connected", vk: "ready" });
  expect([first.preferences.tracker.vk, first.preferences.applications.vk, first.preferences.pgas.vk]).toEqual([true, true, false]);
  const saved = await profileFeaturesApi.savePreferences(first.revision, { ...first.preferences, tracker: { ...first.preferences.tracker, vk: false } });
  await link();
  const again = await profileFeaturesApi.preferences();
  expect(again.revision).toBe(saved.revision);
  expect(again.preferences.tracker.vk).toBe(false);
});
