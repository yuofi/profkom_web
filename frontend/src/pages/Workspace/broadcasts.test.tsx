// @vitest-environment jsdom
import { act } from "react";
import { focusManager } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures, type MockRole } from "../../mocks/fixtures";
import { change, mountWorkspace, pick, settle, submit, waitForPage } from "../../test/workspace";
import { WorkspaceLayout } from "../../components/Workspace/WorkspaceLayout";
import { sectionOf } from "../../components/Workspace/sections";
import { broadcastsApi } from "../../utils/api/broadcasts.api";
import { ERROR_TEXTS } from "../../utils/api/messages";
import { ApiError } from "../../utils/api/request";
import type { Session } from "../../utils/api/contract";
import { BroadcastPage, BroadcastsPage } from "./BroadcastPages";
import {
  BROADCAST_POLL_MS, audienceHint, broadcastBadge, broadcastLength, broadcastPollInterval, excerpt, pausedBroadcastText,
  pausedComposeText, progressText, sendQuestion,
} from "./broadcastView";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => {
  await page?.cleanup();page = undefined;mock?.restore();mock = undefined;
  focusManager.setFocused(undefined);vi.useRealTimers();vi.restoreAllMocks();
});

const text = () => (page!.container.textContent ?? "").replace(/\u00a0/g, " ");
const buttons = () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find((item) => item.textContent === label);
const textarea = () => page!.container.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!;
const alertText = () => [...page!.container.querySelectorAll('[role="alert"]')].map((item) => item.textContent).join(" ");
const row = (start: string) => [...page!.container.querySelectorAll("li")].find((item) => item.textContent?.startsWith(start));
async function click(target: HTMLElement | undefined, label = "button") {
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await waitForPage(page!);
}
const pages = <Routes>
  <Route path="/broadcasts" element={<BroadcastsPage />} />
  <Route path="/broadcasts/:id" element={<BroadcastPage />} />
</Routes>;
/** The demo's sending broadcast holds still unless a test moves it. */
async function mount(role: MockRole = "chair", options: Parameters<typeof installMockTransport>[1] = {}, path = "/broadcasts", session?: Session) {
  mock = installMockTransport(role, { delay: 0, ...options });
  mock.broadcasts.step = 0;
  page = await mountWorkspace(pages, { role, path, session });
  await waitForPage(page);
  return page;
}
const posts = () => mock!.adapter.history.post.filter((request) => request.url === "/broadcasts").map((request) => JSON.parse(request.data as string) as { text: string; idempotency_key: string });
async function compose(value: string) {
  await change(textarea(), value);
  await submit(textarea().closest("form")!);
}

it("shows Рассылки in the menu only to those who send or name the senders", async () => {
  const cases: [MockRole, Partial<Session>, boolean][] = [
    ["chair", {}, true], ["chair-deputy", {}, true], ["hr", {}, true], ["organizer", {}, false], ["leader", {}, false],
    ["organizer", { capabilities: [...createFixtures("organizer").session.capabilities, "manage_broadcast_senders"] }, true],
  ];
  for (const [role, extra, visible] of cases) {
    mock = installMockTransport(role, { delay: 0 });
    page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/" element={<p>Главная</p>} /></Route></Routes>,
      { role, session: { ...createFixtures(role).session, ...extra } });
    await settle();
    const links = page.container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Основная навигация"] a[href="/broadcasts"]');
    // The desktop menu and the mobile one.
    expect(links.length, `${role} ${JSON.stringify(extra)}`).toBe(visible ? 2 : 0);
    if (visible) expect(links[0].textContent).toBe("Рассылки");
    await page.cleanup();page = undefined;mock.restore();mock = undefined;
  }
});

it("puts a broadcast's page under Рассылки for senders and under Уведомления for everyone else", async () => {
  expect(sectionOf("/broadcasts").label).toBe("Рассылки");
  expect(sectionOf("/broadcasts/broadcast-2", { broadcaster: true }).label).toBe("Рассылки");
  expect(sectionOf("/broadcasts/broadcast-2").label).toBe("Уведомления");
  for (const [role, label] of [["chair", "Рассылки"], ["organizer", "Уведомления"]] as const) {
    mock = installMockTransport(role, { delay: 0 });
    page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/broadcasts/:id" element={<BroadcastPage />} /></Route></Routes>,
      { role, path: "/broadcasts/broadcast-2" });
    await waitForPage(page, () => !!page!.container.querySelector("h1"));
    expect(page.container.querySelector("main header a")?.textContent, role).toBe(`Профком ВМК · ${label}`);
    await page.cleanup();page = undefined;mock.restore();mock = undefined;
  }
});

it("counts the characters as the server does and refuses an empty or too long text", async () => {
  await mount();
  expect(text()).toContain("Символов: 0 из 4000");
  await compose("   ");
  expect(text()).toContain("Напишите текст рассылки.");
  expect(textarea().getAttribute("aria-invalid")).toBe("true");
  // Edge spaces do not count; an emoji is one character, as on the server.
  await change(textarea(), "  Привет 👋  ");
  expect(text()).toContain("Символов: 8 из 4000");
  expect(textarea().getAttribute("aria-invalid")).toBeNull();
  await compose("я".repeat(4012));
  expect(text()).toContain("Символов: 4012 из 4000 — сократите на 12");
  expect(text()).toContain("Текст длиннее 4000 символов. Сократите его на 12.");
  expect(posts()).toEqual([]);
  expect(page!.container.querySelector('[role="alert"]')).toBeNull();
  await compose("я".repeat(4000));
  expect(text()).toContain("Символов: 4000 из 4000");
  expect(alertText()).toContain("Отправить рассылку?");
});

it("previews the text as VK shows it, line breaks kept, and says who gets it", async () => {
  await mount();
  expect(text()).toContain("Получат в VK: 412 из 430. У 18 бот не подключён — они увидят рассылку только на сайте.");
  await change(textarea(), "  Первая строка\n\nТретья строка  ");
  const preview = page!.container.querySelector('section[aria-label="Предпросмотр в VK"]')!;
  expect([...preview.querySelectorAll("p")].map((item) => item.textContent)).toContain("Первая строка\n\nТретья строка");
  expect(preview.textContent).toContain("Так сообщение будет выглядеть в VK");
});

it("asks with the VK and the site counts, can be withdrawn, and sends once on the answer", async () => {
  await mount();
  await compose("Собрание в пятницу");
  expect(alertText()).toContain("Отправить рассылку? В VK её получат 412 человек, на сайте она появится в уведомлениях у всех участников.");
  expect(button("Отправить")!.disabled).toBe(true);
  expect(document.activeElement).toBe(button("Да, отправить"));
  await click(button("Отмена"), "Отмена");
  expect(page!.container.querySelector('[role="alert"]')).toBeNull();
  // Another text withdraws the question too.
  await submit(textarea().closest("form")!);
  expect(button("Да, отправить")).toBeDefined();
  await change(textarea(), "Собрание в субботу");
  expect(button("Да, отправить")).toBeUndefined();
  expect(posts()).toEqual([]);
  mock!.broadcasts.audience = { total: 431, reachable: 413 };
  await submit(textarea().closest("form")!);
  await waitForPage(page!);
  // The question names the counts read at that moment.
  expect(alertText()).toContain("В VK её получат 413 человек, на сайте она появится в уведомлениях у всех участников.");
  await click(button("Да, отправить"), "Да, отправить");
  expect(posts().map((body) => body.text)).toEqual(["Собрание в субботу"]);
  expect(page!.container.querySelector('[role="status"]')?.textContent).toBe("Рассылка отправлена. Ход отправки — в списке ниже.");
  expect(textarea().value).toBe("");
  expect(row("Собрание в субботу")?.textContent).toContain("Идёт отправка");
});

it("reuses the draft's key after a lost answer, refuses an edited repeat, and takes a new key after a success", async () => {
  await mount();
  const create = broadcastsApi.create;
  const lost = () => vi.spyOn(broadcastsApi, "create").mockImplementationOnce(async (input) => {
    await create(input);
    throw new ApiError("Нет связи с сервером", 0, "network_error");
  });
  const before = mock!.broadcasts.items.length;
  lost();
  await compose("Субботник в 10:00");
  await click(button("Да, отправить"));
  expect(alertText()).toContain(`${ERROR_TEXTS.network_error} Если повторить отправку, вторая рассылка не появится.`);
  expect(textarea().value).toBe("Субботник в 10:00");
  // The broadcast did go out: the history learns it.
  expect(row("Субботник в 10:00")).toBeDefined();
  // The same draft again: the same key, and the server answers with the same broadcast.
  await compose("Субботник в 10:00");
  await click(button("Да, отправить"));
  expect(posts().map((body) => body.idempotency_key)).toEqual([posts()[0].idempotency_key, posts()[0].idempotency_key]);
  expect(mock!.broadcasts.items.length).toBe(before + 1);
  expect(text()).toContain("Рассылка отправлена.");
  // A new draft has a new key.
  await compose("Субботник переносится на 11:00");
  await click(button("Да, отправить"));
  const keys = posts().map((body) => body.idempotency_key);
  expect(keys[2]).not.toBe(keys[0]);
  expect(keys[2]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(mock!.broadcasts.items.length).toBe(before + 2);
  // A lost answer, then an edited text under the same key: the server refuses, nothing new goes.
  lost();
  await compose("Чистый четверг");
  await click(button("Да, отправить"));
  await compose("Чистый четверг, начало в 9:00");
  await click(button("Да, отправить"));
  expect(posts()[4].idempotency_key).toBe(posts()[3].idempotency_key);
  expect(alertText()).toContain("Рассылка из этого черновика уже отправлена с прежним текстом");
  expect(mock!.broadcasts.items.length).toBe(before + 3);
  // Asked again, it is a new broadcast with a new key.
  await compose("Чистый четверг, начало в 9:00");
  await click(button("Да, отправить"));
  expect(posts()[5].idempotency_key).not.toBe(posts()[4].idempotency_key);
  expect(mock!.broadcasts.items.length).toBe(before + 4);
});

it("names a refusal readably and keeps the draft", async () => {
  await mount();
  mock!.broadcasts.audience = { total: 430, reachable: 0 };
  await compose("Никому не дойдёт");
  // The fresh audience has no VK recipient: no question, a plain hint instead.
  expect(text()).toContain("Сейчас рассылку некому отправить в VK: ни у кого не подключён бот.");
  expect(button("Да, отправить")).toBeUndefined();
  expect(button("Отправить")!.disabled).toBe(true);
  mock!.broadcasts.audience = { total: 430, reachable: 412 };
  await act(async () => { await page!.client.refetchQueries({ queryKey: ["broadcasts", "audience"] }); });
  await submit(textarea().closest("form")!);
  await waitForPage(page!);
  // Between the question and the answer everybody unlinked.
  mock!.broadcasts.audience = { total: 430, reachable: 0 };
  await click(button("Да, отправить"));
  expect(alertText()).toContain(ERROR_TEXTS.broadcast_no_recipients);
  expect(textarea().value).toBe("Никому не дойдёт");
  expect(text()).not.toContain("Idempotency");
});

it("says who sends and who names the senders when the server refuses by the right", async () => {
  await mount("chair-deputy");
  vi.spyOn(broadcastsApi, "create").mockRejectedValueOnce(new ApiError("Broadcast sender rights required", 403, "broadcast_send_forbidden"));
  await compose("Без права");
  await click(button("Да, отправить"));
  expect(alertText()).toContain(ERROR_TEXTS.broadcast_send_forbidden);
  expect(page!.container.querySelector("details code")?.textContent).toBe("broadcast_send_forbidden: Broadcast sender rights required");
  expect(textarea().value).toBe("Без права");
  vi.spyOn(broadcastsApi, "setSender").mockRejectedValueOnce(new ApiError("Only the chair and deputies manage broadcast senders", 403, "broadcast_senders_forbidden"));
  const senders = [...page!.container.querySelectorAll("section")].find((item) => item.querySelector("h2")?.textContent === "Отправители")!;
  const form = senders.querySelector('[data-field-name="user"]')!.closest("form")!;
  await pick(form, "user", "101");
  await submit(form);
  await waitForPage(page!);
  expect(form.querySelector('[role="alert"]')?.textContent).toBe(ERROR_TEXTS.broadcast_senders_forbidden);
  // The demo answers as the server does: a member without the right, a sender who names nobody.
  mock!.state.session.capabilities = mock!.state.session.capabilities.filter((cap) => cap !== "manage_broadcast_senders");
  await expect(broadcastsApi.senders()).rejects.toMatchObject({ status: 403, code: "broadcast_senders_forbidden" });
  mock!.state.session.capabilities = mock!.state.session.capabilities.filter((cap) => cap !== "send_broadcast");
  for (const call of [broadcastsApi.audience, () => broadcastsApi.list(), () => broadcastsApi.cancel("broadcast-3"),
    () => broadcastsApi.create({ text: "x", idempotency_key: "00000000-0000-4000-8000-000000000000" })])
    await expect(call()).rejects.toMatchObject({ status: 403, code: "broadcast_send_forbidden" });
});

it("shows a short note instead of the form while the integration is off, and the history stays", async () => {
  await mount("chair", { bot: "off" });
  expect(text()).toContain("Связь с ботом ВКонтакте выключена, поэтому новую рассылку сейчас не отправить.");
  expect(page!.container.querySelector("textarea")).toBeNull();
  expect(row("Собрание актива")).toBeDefined();
  expect(text()).toContain("Отправители");
});

it("lists the history newest first with its progress, and pages on", async () => {
  await mount();
  const rows = [...page!.container.querySelectorAll("li")].filter((item) => item.querySelector('a[href^="/broadcasts/"]'));
  expect(rows).toHaveLength(20);
  expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("/broadcasts/broadcast-3");
  expect(rows[0].textContent).toContain("Собрание актива в четверг в 18:30, аудитория П-8. Возьмите студенческий");
  expect(rows[0].textContent).toContain("Алексей Соколов");
  expect(rows[0].textContent).toContain("Идёт отправка");
  expect(rows[0].textContent).toContain("Отправлено 232 из 412 · не доставлено 8");
  expect(row("До 25 октября")?.textContent).toContain("Отправлена");
  expect(row("До 25 октября")?.textContent).toContain("Отправлено 396 из 405 · не доставлено 9");
  expect(row("Тестовая рассылка")?.textContent).toContain("Отменена");
  expect(row("Тестовая рассылка")?.textContent).toContain("Отправлено 120 из 398 · не доставлено 8 · отменено 270");
  // Only a sending broadcast can be cancelled.
  expect(row("До 25 октября")?.querySelector("button")).toBeNull();
  expect(rows[0].querySelector('button[aria-label="Отменить рассылку"]')?.textContent).toBe("Отменить");
  await click(button("Показать ещё"), "Показать ещё");
  expect(page!.container.querySelectorAll('li a[href^="/broadcasts/"]')).toHaveLength(23);
  expect(button("Показать ещё")).toBeUndefined();
  expect(row("Новости профкома, выпуск 16")?.textContent).toContain("Автор неизвестен");
});

it("cancels a sending broadcast after the question, and says when it has already ended", async () => {
  await mount();
  const sending = () => row("Собрание актива")!;
  await click(sending().querySelector<HTMLButtonElement>('button[aria-label="Отменить рассылку"]')!);
  expect(sending().querySelector('[role="alert"]')?.textContent).toContain("Отменить рассылку? Ещё не отправленные сообщения не уйдут: 172. Уже отправленные останутся, уведомления на сайте тоже.");
  expect(mock!.adapter.history.post.filter((request) => request.url?.endsWith("/cancel"))).toHaveLength(0);
  await click(button("Да, отменить рассылку"));
  expect(sending().textContent).toContain("Отменена");
  expect(sending().textContent).toContain("Отправлено 232 из 412 · не доставлено 8 · отменено 172");
  expect(sending().querySelector("button")).toBeNull();
  await page!.cleanup();page = undefined;mock!.restore();
  // It ended while the question was open.
  await mount();
  await click(row("Собрание актива")!.querySelector<HTMLButtonElement>('button[aria-label="Отменить рассылку"]')!);
  mock!.broadcasts.items.find((item) => item.broadcast_id === "broadcast-3")!.state = "done";
  await click(button("Да, отменить рассылку"));
  // The row shows what the broadcast is now, and the refusal stays beside it.
  await waitForPage(page!, () => row("Собрание актива")!.textContent!.includes("Отправлена"));
  expect(row("Собрание актива")!.querySelector('[role="alert"]')?.textContent).toBe(ERROR_TEXTS.broadcast_not_sending);
  expect(row("Собрание актива")!.querySelector<HTMLButtonElement>('button[aria-label="Отменить рассылку"]')?.disabled).toBe(true);
});

it("rereads the history every 5 s only while something is sending and the tab is visible", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await mount();
  mock!.broadcasts.step = 60;
  const reads = () => mock!.adapter.history.get.filter((request) => request.url === "/broadcasts").length;
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); });await settle(); };
  const first = reads();
  await tick(BROADCAST_POLL_MS);
  expect(reads()).toBe(first + 1);
  expect(row("Собрание актива")?.textContent).toContain("Отправлено 291 из 412 · не доставлено 9");
  await act(async () => { focusManager.setFocused(false); });
  await tick(3 * BROADCAST_POLL_MS);
  expect(reads()).toBe(first + 1);
  await act(async () => { focusManager.setFocused(true); });
  await tick(BROADCAST_POLL_MS);
  expect(reads()).toBeGreaterThan(first + 1);
  // The bot sends the rest: the poll ends with the sending.
  mock!.broadcasts.step = 1000;
  await tick(BROADCAST_POLL_MS);
  expect(row("Собрание актива")?.textContent).toContain("Отправлена");
  const done = reads();
  await tick(4 * BROADCAST_POLL_MS);
  expect(reads()).toBe(done);
});

it("does not poll a history with nothing sending", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  mock = installMockTransport("chair", { delay: 0 });
  mock.broadcasts.items = mock.broadcasts.items.filter((item) => item.state !== "sending");
  page = await mountWorkspace(pages, { role: "chair", path: "/broadcasts" });
  await waitForPage(page);
  const reads = () => mock!.adapter.history.get.filter((request) => request.url === "/broadcasts").length;
  const first = reads();
  expect(first).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(6 * BROADCAST_POLL_MS); });await settle();
  expect(reads()).toBe(first);
});

it("lets the chair and deputies name and remove senders; a sender sees no such list", async () => {
  await mount("chair");
  const senders = () => [...page!.container.querySelectorAll("section")].find((item) => item.querySelector("h2")?.textContent === "Отправители")!;
  expect(senders().textContent).toContain("Мария Орлова");
  const puts = () => mock!.adapter.history.put.filter((request) => request.url?.startsWith("/broadcasts/senders/")).map((request) => [request.url, JSON.parse(request.data as string)]);
  const form = senders().querySelector('[data-field-name="user"]')!.closest("form")!;
  await pick(form, "user", "101");
  await submit(form);
  await waitForPage(page!, () => senders().textContent!.includes("Анна Смирнова"));
  expect(puts()).toEqual([["/broadcasts/senders/101", { sender: true }]]);
  await click(senders().querySelector<HTMLButtonElement>('button[aria-label="Снять право отправлять рассылки: Мария Орлова"]')!);
  await waitForPage(page!, () => !senders().textContent!.includes("Мария Орлова"));
  expect(puts()[1]).toEqual(["/broadcasts/senders/103", { sender: false }]);
  expect(mock!.broadcasts.senders).toEqual([101]);
  await page!.cleanup();page = undefined;mock!.restore();
  // The HR master is a sender: a new broadcast and the history, no senders.
  await mount("hr");
  expect(textarea()).not.toBeNull();
  expect(row("Собрание актива")).toBeDefined();
  expect(text()).not.toContain("Отправители");
  expect(mock!.adapter.history.get.some((request) => request.url === "/broadcasts/senders")).toBe(false);
});

it("opens a broadcast for any member with its text, author and time, and the counts only for senders", async () => {
  await mount("organizer", {}, "/broadcasts/broadcast-3");
  expect(page!.container.querySelector("h1")?.textContent).toBe("Рассылка");
  const full = "Собрание актива в четверг в 18:30, аудитория П-8.\nВозьмите студенческий: на входе проверяют.\n\nПовестка — в группе профкома.";
  expect([...page!.container.querySelectorAll("p")].map((item) => item.textContent)).toContain(full);
  expect(page!.container.querySelector('a[href="/contacts/104"]')?.textContent).toContain("Алексей Соколов");
  expect(page!.container.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-18T11:52:00.000Z");
  expect(text()).not.toContain("Отправка в VK");
  expect(text()).not.toContain("Идёт отправка");
  expect(button("Отменить")).toBeUndefined();
  expect(page!.container.querySelector('a[href="/notifications"]')?.textContent).toBe("Профком ВМК · Уведомления");
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("chair", {}, "/broadcasts/broadcast-3");
  expect(text()).toContain("Отправка в VK");
  expect(text()).toContain("Идёт отправка");
  const counts = [...page!.container.querySelectorAll("dl > div")].map((item) => item.textContent);
  expect(counts).toEqual(["Получателей в VK412", "Отправлено232", "Ждут отправки172", "Запретили сообщения сообщества6", "Не удалось отправить2"]);
  expect(page!.container.querySelector('button[aria-label="Отменить рассылку"]')).not.toBeNull();
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("chair", {}, "/broadcasts/broadcast-1");
  expect(text()).toContain("Отменена");
  expect(text()).toContain("Отменено до отправки270");
  expect(page!.container.querySelector('button[aria-label="Отменить рассылку"]')).toBeNull();
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("organizer", {}, "/broadcasts/missing");
  expect(text()).toContain("Рассылка не найдена.");
  expect([...page!.container.querySelectorAll("a")].find((link) => link.textContent === "Все уведомления")?.getAttribute("href")).toBe("/notifications");
});

it("polls a sending broadcast's page only for those who see its counts", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const reads = () => mock!.adapter.history.get.filter((request) => request.url === "/broadcasts/broadcast-3").length;
  await mount("organizer", {}, "/broadcasts/broadcast-3");
  await act(async () => { await vi.advanceTimersByTimeAsync(3 * BROADCAST_POLL_MS); });await settle();
  expect(reads()).toBe(1);
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("chair", {}, "/broadcasts/broadcast-3");
  await act(async () => { await vi.advanceTimersByTimeAsync(BROADCAST_POLL_MS); });await settle();
  expect(reads()).toBe(2);
});

it("words the counts, the audience and the start of a text plainly", () => {
  const counts = { total: 412, pending: 25, sent: 380, denied: 3, failed: 2, cancelled: 0, expired: 2 };
  expect(progressText(counts)).toBe("Отправлено 380 из 412 · не доставлено 7");
  expect(progressText({ ...counts, pending: 0, cancelled: 25 })).toBe("Отправлено 380 из 412 · не доставлено 7 · отменено 25");
  expect(progressText({ ...counts, denied: 0, failed: 0, expired: 0 })).toBe("Отправлено 380 из 412");
  expect(audienceHint({ total: 430, reachable: 412 })).toBe("Получат в VK: 412 из 430. У 18 бот не подключён — они увидят рассылку только на сайте.");
  expect(audienceHint({ total: 430, reachable: 430 })).toBe("Получат в VK: 430 из 430.");
  expect(audienceHint({ total: 4, reachable: 5 })).toBe("Получат в VK: 5 из 5.");
  expect(sendQuestion({ total: 21, reachable: 2 })).toContain("получат 2 человека, на сайте она появится в уведомлениях у всех участников.");
  expect(broadcastLength("  a👋b \n")).toBe(3);
  expect(excerpt("Первая\n\nвторая   строка")).toBe("Первая вторая строка");
  expect(excerpt("а".repeat(150))).toBe(`${"а".repeat(140)}…`);
  const item = { broadcast_id: "b", text: "x", author: null, created_at: "2026-11-05T00:00:00Z", state: "sending" as const, cancelled_at: null, counts, paused: null };
  expect(broadcastPollInterval([item])).toBe(BROADCAST_POLL_MS);
  expect(broadcastPollInterval([{ ...item, counts: null }])).toBe(false);
  expect(broadcastPollInterval([{ ...item, state: "done" }])).toBe(false);
  expect(broadcastPollInterval(undefined)).toBe(false);
});

it("words the console's pause on the badge, beside a broadcast and before a send", () => {
  const pause = { paused_at: "2026-11-05T07:10:00Z", paused_by: { user_id: 104, display_name: "Алексей Соколов", avatar_url: null } };
  expect(broadcastBadge({ state: "sending", paused: pause })).toEqual({ label: "Приостановлена", tone: "peach" });
  expect(broadcastBadge({ state: "sending", paused: null })).toEqual({ label: "Идёт отправка", tone: "sky" });
  expect(broadcastBadge({ state: "done", paused: pause }).label).toBe("Отправлена");
  expect(pausedBroadcastText(pause)).toMatch(/^Отправку в VK приостановили в консоли бота \(Алексей Соколов, .+\)\. Рассылка ждёт в очереди и уйдёт, когда отправку возобновят;/);
  expect(pausedBroadcastText(pause)).toContain("Возобновляют отправку мастер блока IT и сопровождающие бота.");
  expect(pausedBroadcastText({ paused_at: null, paused_by: null })).toMatch(/^Отправку в VK приостановили в консоли бота\. /);
  expect(pausedComposeText({ ...pause, paused_by: null })).toMatch(/^Отправка в VK сейчас приостановлена в консоли бота \(\d+[^)]*\d\d:\d\d\)\. Новая рассылка встанет в очередь/);
  expect(sendQuestion({ reachable: 2, paused: pause })).toContain("Сейчас отправка в VK приостановлена: рассылка уйдёт туда, когда отправку возобновят.");
  expect(sendQuestion({ reachable: 2, paused: null })).not.toContain("приостановлена");
});

it("shows senders that the console paused sending, and nobody else", async () => {
  await mount("chair");
  expect(text()).not.toContain("приостановлен");
  await page!.cleanup();page = undefined;mock!.restore();
  mock = installMockTransport("chair", { delay: 0 });
  mock.broadcasts.step = 0;
  Object.assign(mock.botConsole, { paused: true, pausedAt: "2026-11-05T07:10:00Z", pausedBy: 104 });
  page = await mountWorkspace(pages, { role: "chair", path: "/broadcasts" });
  await waitForPage(page);
  expect(text()).toContain("Отправка в VK сейчас приостановлена в консоли бота (Алексей Соколов, ");
  expect(row("Собрание актива")?.textContent).toContain("Приостановлена");
  expect(row("До 25 октября")?.textContent).toContain("Отправлена");
  await page.cleanup();page = undefined;
  page = await mountWorkspace(pages, { role: "chair", path: "/broadcasts/broadcast-3" });
  await waitForPage(page);
  expect(text()).toContain("Приостановлена");
  expect(text()).toContain("Отправку в VK приостановили в консоли бота (Алексей Соколов, ");
  // The bot sends nothing while paused: the demo holds the broadcast still.
  mock.broadcasts.step = 60;
  expect((await broadcastsApi.get("broadcast-3")).counts?.pending).toBe(172);
  await page.cleanup();page = undefined;mock.restore();
  mock = installMockTransport("organizer", { delay: 0 });
  Object.assign(mock.botConsole, { paused: true, pausedAt: "2026-11-05T07:10:00Z", pausedBy: 104 });
  page = await mountWorkspace(pages, { role: "organizer", path: "/broadcasts/broadcast-3" });
  await waitForPage(page);
  expect(text()).toContain("Собрание актива");
  expect(text()).not.toContain("приостанов");
});
