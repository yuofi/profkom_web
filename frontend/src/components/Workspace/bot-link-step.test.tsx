// @vitest-environment jsdom
import { act } from "react";
import MockAdapter from "axios-mock-adapter";
import { focusManager } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../utils/api";
import { createFixtures } from "../../mocks/fixtures";
import type { BotLinkCode, BotLinkMe, Session, SessionBotLink } from "../../utils/api/contract";
import { ERROR_TEXTS } from "../../utils/api/messages";
import { displayTime } from "../../utils/dates";
import { mountWorkspace, settle } from "../../test/workspace";
import { BotLinkStep } from "./BotLinkStep";
import { botLinkPollInterval, groupCode } from "./botLink";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, adapter: MockAdapter | undefined;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard"), execCommand = document.execCommand;
afterEach(async () => {
  await page?.cleanup();page = undefined;adapter?.restore();adapter = undefined;
  focusManager.setFocused(undefined);vi.useRealTimers();vi.restoreAllMocks();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);else delete (navigator as { clipboard?: unknown }).clipboard;
  document.execCommand = execCommand;
});

const pendingLink: SessionBotLink = { state: "none", required: true, blocked: false, deadline: null };
const me = (extra: Partial<BotLinkMe> = {}): BotLinkMe => ({
  enabled: true, state: "none", vk_user_id: null, messages_allowed: null, token_status: null, linked_at: null,
  required: true, blocked: false, deadline: null, bot_url: "https://vk.me/test_bot", code_expires_at: null, ...extra,
});
const linked = (state: BotLinkMe["state"]) => me({ state, vk_user_id: 123456, messages_allowed: state !== "messages_denied", token_status: state === "token_missing" ? "missing" : state === "token_invalid" ? "invalid" : "ok", linked_at: "2026-11-04T09:00:00Z" });
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const code = (extra: Partial<BotLinkCode> = {}): BotLinkCode => ({ code: "ABCDEFGHJK", expires_at: inMinutes(15), link_url: "https://vk.me/test_bot?ref=ABCDEFGHJK", command: "привязать ABCDE-FGHJK", ...extra });
const session = (link: Session["bot_link"]): Session => ({ ...createFixtures("pending").session, bot_link: link });

/** /bot-link/me answers with `read()` at the moment of each request. */
async function mount(read: () => BotLinkMe | [number, unknown], link: Session["bot_link"] = pendingLink) {
  adapter ??= new MockAdapter(api);
  adapter.onGet("/bot-link/me").reply(() => { const value = read();return Array.isArray(value) ? value : [200, value]; });
  page = await mountWorkspace(<BotLinkStep />, { session: session(link) });
  await settle();await settle();
  return page;
}
const text = () => page!.container.textContent ?? "";
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
const reads = () => adapter!.history.get.filter((request) => request.url === "/bot-link/me").length;
async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await settle();await settle();
}

it("renders nothing and reads nothing while the integration is off", async () => {
  await mount(() => me(), null);
  expect(page!.container.innerHTML).toBe("");
  expect(reads()).toBe(0);
  await page!.cleanup();page = undefined;
  // The server says off (or an older server has no route): still nothing.
  await mount(() => me({ enabled: false, state: null, required: false, bot_url: null }));
  expect(page!.container.innerHTML).toBe("");
  await page!.cleanup();page = undefined;adapter!.reset();
  await mount(() => [404, { detail: { code: "not_found", message: "Not Found" } }]);
  expect(page!.container.innerHTML).toBe("");
});

it.each([
  ["none", ["Бот не привязан.", "Получите код и отправьте его боту ВКонтакте"], "Получить код"],
  ["ok", ["Бот привязан.", "Страница ВКонтакте: id123456."], "Привязать заново"],
  ["messages_denied", ["сообщения от сообщества запрещены", "нажмите «Разрешить сообщения»"], "Привязать заново"],
  ["token_missing", ["у него нет вашего токена", "Бот попросит токен в личных сообщениях", "«🔑 Получить токен»"], "Привязать заново"],
  ["token_invalid", ["ваш токен больше не работает", "«🔑 Получить токен»"], "Привязать заново"],
] as const)("explains the state %s in plain words with its own way on", async (state, phrases, action) => {
  await mount(() => (state === "none" ? me() : linked(state)));
  for (const phrase of phrases) expect(text()).toContain(phrase);
  expect(button(action)).toBeDefined();
  const bot = page!.container.querySelector<HTMLAnchorElement>('a[href="https://vk.me/test_bot"]');
  if (state === "none" || state === "ok") expect(bot).toBeNull();
  else {
    // A fix happens in VK: the bot's dialog opens in a new tab without the site's window.
    expect(bot?.textContent).toBe("Открыть бота");
    expect(bot?.target).toBe("_blank");expect(bot?.rel).toBe("noopener noreferrer");
  }
});

it("shows a new code large and grouped, the bot link, the command and its expiry", async () => {
  await mount(() => me());
  const issued = code();
  adapter!.onPost("/bot-link/code").reply(200, issued);
  await click("Получить код");
  expect(adapter!.history.post.map((request) => request.url)).toEqual(["/bot-link/code"]);
  expect(text()).toContain("Ваш код");
  expect([...page!.container.querySelectorAll("p")].some((p) => p.textContent === "ABCDE-FGHJK")).toBe(true);
  const open = page!.container.querySelector<HTMLAnchorElement>(`a[href="${issued.link_url}"]`)!;
  expect(open.textContent).toBe("Открыть бота");expect(open.target).toBe("_blank");expect(open.rel).toBe("noopener noreferrer");
  expect(page!.container.querySelector("code")?.textContent).toBe("привязать ABCDE-FGHJK");
  expect(text()).toContain(`Код действует до ${displayTime(issued.expires_at)}.`);
  expect(button("Получить код")).toBeUndefined();
});

it("copies the command, and offers it selected when the browser refuses", async () => {
  await mount(() => me());
  adapter!.onPost("/bot-link/code").reply(200, code({ link_url: null }));
  await click("Получить код");
  // Without BOT_VK_URL there is only the command.
  expect(page!.container.querySelector('a[target="_blank"]')).toBeNull();
  expect(text()).toContain("Отправьте боту ВКонтакте команду ниже.");
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await click("Скопировать");
  expect(writeText).toHaveBeenCalledWith("привязать ABCDE-FGHJK");
  expect(text()).toContain("Команда скопирована.");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw Error("denied"); }) } });
  document.execCommand = vi.fn(() => false);
  await click("Скопировать");
  const manual = page!.container.querySelector<HTMLInputElement>("input[readonly]")!;
  expect(manual.value).toBe("привязать ABCDE-FGHJK");
  expect(manual.closest("label")?.textContent).toContain("Скопируйте команду вручную");
});

it("says when the code has expired and offers a new one", async () => {
  await mount(() => me());
  adapter!.onPost("/bot-link/code").reply(200, code({ expires_at: new Date(Date.now() + 300).toISOString() }));
  await click("Получить код");
  expect(text()).toContain("ABCDE-FGHJK");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  expect(text()).toContain("Код истёк — получите новый.");
  expect(text()).not.toContain("ABCDE-FGHJK");
  adapter!.onPost("/bot-link/code").reply(200, code({ code: "KMNPQ-RSTVW", command: "привязать KMNPQ-RSTVW" }));
  await click("Получить новый код");
  expect(text()).toContain("KMNPQ-RSTVW");
});

it("after a reload names the code issued before and offers a new one", async () => {
  const expires = inMinutes(10);
  await mount(() => me({ code_expires_at: expires }));
  expect(text()).toContain(`Код уже выдан и действует до ${displayTime(expires)}. Если он потерян, получите новый.`);
  expect(button("Получить код")).toBeUndefined();
  adapter!.onPost("/bot-link/code").reply(200, code());
  await click("Получить новый код");
  expect(text()).toContain("ABCDE-FGHJK");
  expect(text()).not.toContain("Код уже выдан");
});

it("polls every 3 s only while the tab is visible and stops when the link is ok", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let current = me();
  await mount(() => current);
  const invalidate = vi.spyOn(page!.client, "invalidateQueries");
  const first = reads();
  expect(first).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });await settle();
  expect(reads()).toBe(first + 1);
  // A hidden tab does not poll in the background.
  await act(async () => { focusManager.setFocused(false); });
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });await settle();
  expect(reads()).toBe(first + 1);
  await act(async () => { focusManager.setFocused(true); });await settle();
  const visible = reads();
  expect(visible).toBeGreaterThanOrEqual(first + 2);
  // The bot confirmed the link: the session and the own application reread, the poll ends.
  current = linked("ok");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });await settle();await settle();
  expect(text()).toContain("Бот привязан.");
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["registrations", "me"] });
  const done = reads();
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });await settle();
  expect(reads()).toBe(done);
});

it("keeps polling an ok link while a new code waits, and shows the result when the bot used it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let current = linked("ok");
  await mount(() => current, { state: "ok", required: false, blocked: false, deadline: null });
  const before = reads();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });await settle();
  expect(reads()).toBe(before);
  const issued = code();
  adapter!.onPost("/bot-link/code").reply(200, issued);
  await click("Привязать заново");
  current = { ...current, code_expires_at: issued.expires_at };
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });await settle();
  expect(reads()).toBe(before + 1);
  expect(text()).toContain("ABCDE-FGHJK");
  // Another VK used the code: the code goes, the new page is named, the poll ends.
  current = { ...linked("ok"), vk_user_id: 654321, linked_at: "2026-11-04T10:00:00Z" };
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });await settle();await settle();
  expect(text()).not.toContain("ABCDE-FGHJK");
  expect(text()).toContain("Страница ВКонтакте: id654321.");
  const done = reads();
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });await settle();
  expect(reads()).toBe(done);
});

it("names the code limit and a lost connection readably", async () => {
  await mount(() => me());
  adapter!.onPost("/bot-link/code").replyOnce(429, { detail: { code: "link_code_rate_limited", message: "Too many codes" } });
  await click("Получить код");
  expect(page!.container.querySelector('[role="alert"]')?.textContent).toBe(ERROR_TEXTS.link_code_rate_limited);
  expect(text()).not.toContain("Too many");
  adapter!.onPost("/bot-link/code").networkErrorOnce();
  await click("Получить код");
  expect(page!.container.querySelector('[role="alert"]')?.textContent).toBe(ERROR_TEXTS.network_error);
  await page!.cleanup();page = undefined;adapter!.reset();
  await mount(() => [503, { detail: { code: "unavailable", message: "Down" } }]);
  expect(page!.container.querySelector('[role="alert"]')?.textContent).toContain(ERROR_TEXTS.unavailable);
});

it("groups a code and decides the poll from the server's answer", () => {
  expect(groupCode("abcdefghjk")).toBe("ABCDE-FGHJK");
  expect(groupCode("ABCDE-FGHJK")).toBe("ABCDE-FGHJK");
  expect(groupCode("ABC")).toBe("ABC");
  const now = Date.parse("2026-11-04T09:00:00Z");
  expect(botLinkPollInterval(undefined, null, now)).toBe(false);
  expect(botLinkPollInterval(me({ enabled: false, state: null }), null, now)).toBe(false);
  expect(botLinkPollInterval(me(), null, now)).toBe(3000);
  expect(botLinkPollInterval(linked("token_missing"), null, now)).toBe(3000);
  expect(botLinkPollInterval(linked("ok"), null, now)).toBe(false);
  expect(botLinkPollInterval({ ...linked("ok"), code_expires_at: "2026-11-04T09:10:00Z" }, null, now)).toBe(3000);
  expect(botLinkPollInterval({ ...linked("ok"), code_expires_at: "2026-11-04T08:59:00Z" }, null, now)).toBe(false);
  expect(botLinkPollInterval(linked("ok"), "2026-11-04T09:10:00Z", now)).toBe(3000);
});
