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
import { botConsoleApi } from "../../utils/api/botConsole.api";
import { ERROR_TEXTS } from "../../utils/api/messages";
import { ApiError } from "../../utils/api/request";
import type { BotCommand, BotUpdates, Session } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { BotConsolePage } from "./BotConsolePage";
import { COMMAND_POLL_MS, DOWNTIME, RESTART_WAIT_TEXT, SERVER_WAIT_TEXT, STATUS_POLL_MS } from "./botConsoleView";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => {
  await page?.cleanup();page = undefined;mock?.restore();mock = undefined;
  focusManager.setFocused(undefined);vi.useRealTimers();vi.restoreAllMocks();
});

const plain = (value: string | null | undefined) => (value ?? "").replace(/\u00a0/g, " ");
const text = () => plain(page!.container.textContent);
const buttons = (root: ParentNode = page!.container) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string, root?: ParentNode) => buttons(root).find((item) => item.textContent === label);
const card = (title: string) => [...page!.container.querySelectorAll("h2")].find((item) => item.textContent === title)?.closest("section") ?? null;
const alertText = (root: ParentNode = page!.container) => [...root.querySelectorAll('[role="alert"]')].map((item) => item.textContent).join(" ");
const facts = (root: ParentNode) => [...root.querySelectorAll("dl > div")].map((item) => plain(item.textContent));
async function click(target: HTMLElement | undefined, label = "button") {
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await waitForPage(page!);
}
const pages = <Routes><Route path="/bot" element={<BotConsolePage />} /></Routes>;
/** The IT master by default. A command holds still unless a test moves it. */
async function mount(role: MockRole = "it", options: Parameters<typeof installMockTransport>[1] = {}, capabilities?: string[], prepare?: () => void) {
  mock = installMockTransport(role, { delay: 0, ...options });
  mock.botConsole.step = 0;
  if (capabilities) mock.state.session.capabilities = capabilities;
  prepare?.();
  page = await mountWorkspace(pages, { role, path: "/bot", session: structuredClone(mock.state.session) as Session });
  await waitForPage(page);
  return page;
}
/** A maintainer the IT master named: sees and operates, does not name others. */
const maintainer = [...createFixtures("organizer").session.capabilities, "view_bot_console", "operate_bot"];
const reads = (url: string) => mock!.adapter.history.get.filter((request) => request.url === url).length;
const posts = () => mock!.adapter.history.post.filter((request) => request.url === "/bot/console/commands")
  .map((request) => JSON.parse(request.data as string) as { kind: string; args: object; idempotency_key: string });
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); });await settle(); };

it("shows Консоль бота in the menu only to the IT master and the maintainers, not to the chair", async () => {
  expect(sectionOf("/bot").label).toBe("Консоль бота");
  const cases: [MockRole, string[] | undefined, boolean][] = [
    ["it", undefined, true], ["organizer", maintainer, true], ["chair", undefined, false], ["chair-deputy", undefined, false],
    ["organizer", undefined, false], ["hr", undefined, false],
  ];
  for (const [role, capabilities, visible] of cases) {
    mock = installMockTransport(role, { delay: 0 });
    const session = { ...createFixtures(role).session, ...(capabilities ? { capabilities } : {}) };
    page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/" element={<p>Главная</p>} /></Route></Routes>, { role, session });
    await settle();
    const links = page.container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Основная навигация"] a[href="/bot"]');
    // The desktop menu and the mobile one.
    expect(links.length, role).toBe(visible ? 2 : 0);
    if (visible) expect(links[0].textContent).toBe("Консоль бота");
    await page.cleanup();page = undefined;mock.restore();mock = undefined;
  }
});

it("tells the chair the console is not theirs and asks the server nothing", async () => {
  await mount("chair");
  expect(page!.container.querySelector("h1")?.textContent).toBe("Консоль бота");
  expect(text()).toContain("Консоль бота видят мастер блока IT и сопровождающие, которых он назначил.");
  expect(mock!.adapter.history.get.some((request) => request.url?.startsWith("/bot/"))).toBe(false);
});

it("shows the status: the link, version, start, Long Poll, database, health, counters and the queue", async () => {
  await mount();
  const status = card("Состояние")!;
  expect(status.textContent).toContain("На связи");
  expect(status.textContent).toMatch(/Последний отчёт — 2\d с назад/);
  expect(status.textContent).toContain("Ждут отправки: 3 уведомления и 1 пачка рассылок.");
  const rows = facts(status);
  expect(rows).toContain("Версия2.4.0 · коммит abc1234");
  expect(rows).toContain("Long Pollподключён");
  expect(rows).toContain("База данныхPostgreSQL");
  expect(rows).toContain(`Запущен${plain(displayDate(mock!.botConsole.heartbeat.started_at))}`);
  expect(rows.slice(4, 7)).toEqual(["Long Poll4 с назад", "Планировщик12 с назад", "Обмен с сайтом0 с назад"]);
  expect(rows).toContain("Беседы3");
  expect(rows).toContain("Токены пользователей41");
  expect(rows).toContain("Отложенные сообщения ждут2");
  expect(rows).toContain("Уведомления отправлены128");
  expect(rows).toContain("Рассылки не ушли2");
  expect(text()).not.toContain("приостановлена");
});

it("shows an offline state when the bot is silent or the integration is off, and holds the commands", async () => {
  await mount("it", {}, undefined, () => { mock!.botConsole.online = false;mock!.botConsole.reportAgo = 3 * 3600; });
  expect(card("Состояние")!.textContent).toContain("Не на связи");
  expect(card("Состояние")!.textContent).toContain("Последний отчёт — 3 ч назад");
  expect(text()).toContain("Бот давно не присылал отчётов. Команды до него не дойдут, пока он не вернётся.");
  expect(button("Перезапустить бота")!.disabled).toBe(true);
  expect(button("Обновить до 2.5.0")!.disabled).toBe(true);
  expect(card("Журнал бота")!.querySelector("fieldset")!.disabled).toBe(true);
  // The pause is the site's own: it works without the bot.
  expect(button("Приостановить отправку")!.disabled).toBe(false);
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("it", { bot: "off" });
  expect(card("Состояние")!.textContent).toContain("Связь выключена");
  expect(text()).toContain("Связь с ботом на сайте выключена: бот не забирает работу, команды и пауза недоступны.");
  expect(button("Приостановить отправку")!.disabled).toBe(true);
  expect(button("Перезапустить бота")!.disabled).toBe(true);
});

it("offers the update and the rollback only as the server does, with the changelog of that version", async () => {
  await mount();
  const updates = () => card("Обновления")!;
  expect(facts(updates()).slice(0, 2)).toEqual(["Работает2.4.0", "Доступна2.5.0"]);
  expect(updates().textContent).toContain("Доступна версия 2.5.0.");
  expect(updates().textContent).toContain("Обновление через бота включено на сервере.");
  expect(button("Обновить до 2.5.0")).toBeDefined();
  expect(button("Откатить на 2.3.0")).toBeDefined();
  expect(button("Проверить обновления")).toBeDefined();
  const changelog = updates().querySelector('section[aria-label="Что нового в 2.5.0"]')!;
  expect(changelog.textContent).toContain("Добавлено\n- Консоль сайта");
  expect(changelog.textContent).not.toContain("#");
  expect(facts(updates())).toContain("Версии2.3.0 → 2.4.0");
  expect(facts(updates())).toContain("Состояниеготово");
  const cases: [string, (u: BotUpdates) => void, string | null, string | null, string][] = [
    // state/check not recounted after an update: the target is what runs.
    ["target runs", (u) => { u.check!.target = "2.4.0"; }, null, "Откатить на 2.3.0", "Установлена последняя версия."],
    ["up to date", (u) => { u.check!.status = "up-to-date"; }, null, "Откатить на 2.3.0", "Установлена последняя версия."],
    ["rollback over ssh", (u) => { u.check!.rollback = "ssh"; }, "Обновить до 2.5.0", null, "Доступна версия 2.5.0."],
    ["previous runs", (u) => { u.check!.previous = "2.4.0"; }, "Обновить до 2.5.0", null, "Доступна версия 2.5.0."],
    ["not a release", (u) => { u.check!.target = "2.5.0-rc1"; }, null, "Откатить на 2.3.0", "Доступна версия 2.5.0-rc1."],
    ["major", (u) => { Object.assign(u.check!, { status: "major-available", target: "", newer_major: "3.0.0" }); }, null, "Откатить на 2.3.0", "Вышла новая основная версия 3.0.0: её ставит оператор сервера."],
  ];
  for (const [label, edit, update, rollback, line] of cases) {
    await page!.cleanup();page = undefined;mock!.restore();
    await mount("it", {}, undefined, () => edit(mock!.botConsole.heartbeat.updates!));
    expect(buttons().find((item) => item.textContent?.startsWith("Обновить до"))?.textContent ?? null, label).toBe(update);
    expect(buttons().find((item) => item.textContent?.startsWith("Откатить на"))?.textContent ?? null, label).toBe(rollback);
    expect(updates().textContent, label).toContain(line);
    if (!update) expect(updates().querySelector("section[aria-label^='Что нового']"), label).toBeNull();
  }
  // Updates through the bot are off on the server: no command, as in the bot's DM.
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("it", {}, undefined, () => { mock!.botConsole.heartbeat.updates!.remote = "off"; });
  expect(updates().textContent).toContain("Обновление через бота выключено на сервере: бота обновляет оператор сервера.");
  expect(button("Обновить до 2.5.0")).toBeUndefined();
  expect(button("Проверить обновления")).toBeUndefined();
  // Another version's changelog is not shown before this update.
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("it", {}, undefined, () => { mock!.botConsole.heartbeat.updates!.changelog!.version = "2.4.1"; });
  expect(button("Обновить до 2.5.0")).toBeDefined();
  expect(updates().querySelector("section[aria-label^='Что нового']")).toBeNull();
  // An older bot does not report the update channel.
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("it", {}, undefined, () => { delete mock!.botConsole.heartbeat.updates; });
  expect(updates().textContent).toContain("Бот этой версии не сообщает, что с обновлениями.");
  expect(button("Проверить обновления")).toBeUndefined();
});

it("asks before an update, a rollback, a restart and a pause, says what happens, and sends nothing until the answer", async () => {
  await mount();
  const updates = card("Обновления")!;
  await click(button("Обновить до 2.5.0"));
  expect(alertText(updates)).toContain("Обновить бота 2.4.0 → 2.5.0? Сервер сделает бэкап базы и соберёт новую версию");
  expect(alertText(updates)).toContain(DOWNTIME);
  expect(document.activeElement).toBe(button("Да, обновить"));
  await click(button("Отмена", updates));
  expect(alertText(updates)).toBe("");
  await click(button("Откатить на 2.3.0"));
  expect(alertText(updates)).toContain("Откатить бота 2.4.0 → 2.3.0? Сервер сделает бэкап базы и вернёт 2.3.0.");
  expect(alertText(updates)).toContain(DOWNTIME);
  await click(button("Отмена", updates));
  const control = card("Управление")!;
  await click(button("Перезапустить бота"));
  expect(control.querySelector('[role="alert"] p')?.textContent).toBe(`Перезапустить бота? Он остановится и через несколько секунд поднимется снова. ${DOWNTIME}`);
  await click(button("Отмена", control));
  await click(button("Приостановить отправку"));
  expect(alertText(control)).toContain("Приостановить отправку? Уведомления и рассылки перестанут уходить в VK");
  await click(button("Отмена", control));
  expect(posts()).toEqual([]);
  expect(mock!.adapter.history.put).toHaveLength(0);
  // The answer sends the version the person saw, with a fresh key.
  await click(button("Обновить до 2.5.0"));
  await click(button("Да, обновить"));
  expect(posts()).toHaveLength(1);
  expect(posts()[0]).toMatchObject({ kind: "update", args: { version: "2.5.0" } });
  expect(posts()[0].idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(updates.textContent).toContain("Ждёт бота");
  expect(updates.textContent).toContain("Ждём, пока бот возьмёт команду");
  // While it waits, another update or rollback is not offered a second time.
  expect(button("Откатить на 2.3.0")!.disabled).toBe(true);
  await click(button("Перезапустить бота"));
  await click(button("Да, перезапустить"));
  expect(posts()[1]).toMatchObject({ kind: "restart", args: {} });
  expect(posts()[1].idempotency_key).not.toBe(posts()[0].idempotency_key);
});

it("asks the log, waits while the bot reads it, shows the output to copy, and stops polling", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await mount();
  mock!.botConsole.step = 1;
  const logs = () => card("Журнал бота")!;
  const form = logs().querySelector("form")!;
  const field = <T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string) => form.querySelector<T>(`[name="${name}"]`)!;
  expect(field("lines").value).toBe("200");
  // Refused in the page, before any request.
  for (const [lines, contains, error] of [["0", "", "Укажите число записей от 1 до 2000."], ["2001", "", "Укажите число записей от 1 до 2000."], ["1.5", "", "Укажите число записей от 1 до 2000."], ["10", "я".repeat(101), "Подстрока длиннее 100 символов. Сократите её на 1."]]) {
    await change(field("lines"), lines);
    await change(field("contains"), contains);
    await submit(form);
    expect(logs().textContent).toContain(error);
  }
  expect(posts()).toEqual([]);
  await change(field("lines"), "50");
  await change(field<HTMLSelectElement>("level"), "WARNING");
  await change(field("contains"), "Timeout");
  await submit(form);
  await waitForPage(page!);
  expect(posts()).toEqual([{ kind: "logs", args: { lines: 50, level: "WARNING", contains: "Timeout" }, idempotency_key: expect.any(String) }]);
  expect(logs().textContent).toContain("Ждёт бота");
  expect(button("Показать журнал")!.disabled).toBe(true);
  const id = mock!.botConsole.commands.at(-1)!.command_id, detail = `/bot/console/commands/${id}`;
  expect(reads(detail)).toBe(0);
  await tick(COMMAND_POLL_MS);
  expect(reads(detail)).toBe(1);
  expect(logs().textContent).toContain("Выполняется");
  await tick(COMMAND_POLL_MS);
  expect(logs().textContent).toContain("Выполнена");
  expect(logs().textContent).toContain("Журнал получен.");
  const output = logs().querySelector("pre")!;
  // Records of WARNING and above with «timeout», a traceback in its record.
  expect(output.textContent).toBe(mock!.botConsole.log.filter((line) => /WARNING|ERROR/.test(line.split(" ")[2]) && /timeout/i.test(line)).join("\n"));
  expect(output.textContent).toContain("Traceback (most recent call last)");
  expect(logs().textContent).toContain("4 строки");
  // The bot finished it: no more reads.
  const done = reads(detail);
  await tick(5 * COMMAND_POLL_MS);
  expect(reads(detail)).toBe(done);
  expect(button("Показать журнал")!.disabled).toBe(false);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  try {
    await click(button("Скопировать", logs()));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(output.textContent);
    expect(logs().textContent).toContain("Вывод скопирован.");
  } finally { Reflect.deleteProperty(navigator, "clipboard"); }
});

it("says what a failed or unknown command ended with", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await mount();
  mock!.botConsole.step = 1;mock!.botConsole.outcome = "failed";
  await submit(card("Журнал бота")!.querySelector("form")!);
  await waitForPage(page!);
  await tick(2 * COMMAND_POLL_MS);
  expect(card("Журнал бота")!.textContent).toContain("Не выполнена");
  expect(card("Журнал бота")!.textContent).toContain("Команда не выполнена.");
  expect(card("Журнал бота")!.textContent).toContain("Файла журнала нет.");
  expect(card("Журнал бота")!.querySelector("code")?.textContent).toBe("no_log");
  mock!.botConsole.outcome = "unsupported";
  await click(button("Проверить обновления"));
  await tick(2 * COMMAND_POLL_MS);
  expect(card("Обновления")!.textContent).toContain("Эта версия бота не знает такой команды.");
});

it("rereads the status every 5 s only while the tab is visible, and not while the integration is off", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await mount();
  const status = "/bot/console/status", first = reads(status);
  expect(first).toBe(1);
  mock!.botConsole.queue.deliveries = 7;
  await tick(STATUS_POLL_MS);
  expect(reads(status)).toBe(2);
  expect(card("Состояние")!.textContent).toContain("Ждут отправки: 7 уведомлений");
  await act(async () => { focusManager.setFocused(false); });
  await tick(3 * STATUS_POLL_MS);
  expect(reads(status)).toBe(2);
  await act(async () => { focusManager.setFocused(true); });
  await tick(STATUS_POLL_MS);
  expect(reads(status)).toBeGreaterThan(2);
  // Nothing else polls: the history and the maintainers are read once.
  expect(reads("/bot/console/commands")).toBe(1);
  expect(reads("/bot/maintainers")).toBe(1);
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("it", { bot: "off" });
  await tick(4 * STATUS_POLL_MS);
  expect(reads(status)).toBe(1);
});

it("shows who paused the sending and when, and pauses and resumes it", async () => {
  const pausedAt = "2026-11-05T09:30:00Z";
  await mount("it", {}, undefined, () => Object.assign(mock!.botConsole, { paused: true, pausedAt, pausedBy: 102 }));
  const banner = () => page!.container.querySelector<HTMLElement>('[role="status"] > p');
  const shown = () => plain(banner()?.textContent);
  expect(shown()).toBe(`Отправка через бота приостановлена: Иван Петров, ${plain(displayDate(pausedAt))}. ` +
    "Уведомления и рассылки не уходят в VK и копятся в очереди; через сутки они истекают. На сайте уведомления приходят как обычно.");
  expect(card("Управление")!.textContent).toContain("Отправка приостановлена: уведомления и рассылки ждут в очереди.");
  // Resuming asks nothing.
  await click(button("Возобновить отправку"));
  expect(mock!.adapter.history.put.map((request) => [request.url, JSON.parse(request.data as string)])).toEqual([["/bot/console/pause", { paused: false }]]);
  expect(shown()).not.toContain("приостановлена");
  await click(button("Приостановить отправку"));
  await click(button("Да, приостановить"));
  expect(JSON.parse(mock!.adapter.history.put[1].data as string)).toEqual({ paused: true });
  expect(shown()).toContain("Отправка через бота приостановлена: Анна Смирнова");
  expect(button("Возобновить отправку")).toBeDefined();
});

it("names the refusals of a command in Russian and reuses the key after a lost answer", async () => {
  await mount();
  const control = () => card("Управление")!;
  const restart = async () => { await click(button("Перезапустить бота"));await click(button("Да, перезапустить")); };
  // The bot went silent since the last read: the status learns it too.
  mock!.botConsole.online = false;
  await restart();
  expect(alertText(control())).toContain(ERROR_TEXTS.bot_offline);
  expect(card("Состояние")!.textContent).toContain("Не на связи");
  expect(button("Перезапустить бота")!.disabled).toBe(true);
  mock!.botConsole.online = true;
  await act(async () => { await page!.client.refetchQueries({ queryKey: ["botConsole", "status"] }); });
  await waitForPage(page!);
  // Restarted a minute ago, by someone else.
  mock!.botConsole.lastRestart = Date.now() - 60_000;
  await restart();
  expect(alertText(control())).toContain(ERROR_TEXTS.bot_command_rate_limited);
  // A rollback someone asked is still waiting: an update is the same kind.
  mock!.botConsole.commands.push({ ...mock!.botConsole.commands[0], command_id: "f".repeat(32), kind: "rollback", args: { version: "2.3.0" }, state: "pending", has_output: false, output: null } as BotCommand);
  await click(button("Обновить до 2.5.0"));
  await click(button("Да, обновить"));
  expect(alertText(card("Обновления")!)).toContain(ERROR_TEXTS.bot_command_pending);
  // The server's English stays in «Подробнее», never in the alert.
  expect(alertText()).not.toMatch(/[A-Za-z]{3,}/);
  // A lost answer: the command was made; the repeat with the same key returns it.
  mock!.botConsole.lastRestart = null;
  const create = botConsoleApi.create;
  vi.spyOn(botConsoleApi, "create").mockImplementationOnce(async (input) => {
    await create(input);
    throw new ApiError("Нет связи с сервером", 0, "network_error");
  });
  const before = mock!.botConsole.commands.length;
  await restart();
  expect(alertText(control())).toContain(`${ERROR_TEXTS.network_error} Если повторить, второй команды не будет.`);
  await restart();
  const keys = posts().filter((body) => body.kind === "restart").map((body) => body.idempotency_key);
  expect(keys.at(-1)).toBe(keys.at(-2));
  expect(mock!.botConsole.commands.length).toBe(before + 1);
  expect(control().textContent).toContain("Ждёт бота");
});

it("asks for a VK link before the server's requests", async () => {
  await mount("it", { bot: "none" });
  const updates = card("Обновления")!;
  expect(updates.textContent).toContain("Проверять и ставить обновления из консоли можно с привязанным VK");
  expect(updates.querySelector('a[href="/profile/settings#bot"]')?.textContent).toBe("Привязать VK");
  await click(button("Проверить обновления"));
  expect(alertText(updates)).toContain(ERROR_TEXTS.bot_console_vk_required);
  // The restart and the log need no VK.
  await click(button("Перезапустить бота"));
  await click(button("Да, перезапустить"));
  expect(card("Управление")!.textContent).toContain("Ждёт бота");
});

it("lists the commands newest first with who, when, state and message, pages on, and opens an output", async () => {
  await mount();
  const history = () => card("История команд")!;
  const rows = () => [...history().querySelectorAll("li")];
  expect(rows()).toHaveLength(20);
  expect(rows()[0].querySelector("strong")?.textContent).toBe("Журнал: 200 записей, от WARNING");
  expect(rows()[0].textContent).toContain("Иван Петров");
  expect(rows()[0].querySelector("time")?.getAttribute("dateTime")).toBe(mock!.botConsole.commands[0].created_at);
  expect(rows()[0].textContent).toContain("Выполнена");
  const row = (title: string) => rows().find((item) => item.querySelector("strong")?.textContent === title)!;
  expect(row("Перезапуск").textContent).toContain("Аккаунт удалён");
  const failed = rows().find((item) => item.textContent?.includes("Не выполнена"))!;
  expect(failed.querySelector("strong")?.textContent).toBe("Обновление до 2.4.0");
  expect(failed.textContent).toContain("Сервер принимает запросы не чаще раза в минуту.");
  expect(failed.querySelector("code")?.textContent).toBe("rate_limited");
  expect(rows().some((item) => item.textContent?.includes("Истекла"))).toBe(true);
  // Only a command with a kept output opens one.
  expect(row("Проверка обновлений").querySelector("button")).toBeNull();
  const detail = `/bot/console/commands/${mock!.botConsole.commands[0].command_id}`;
  expect(reads(detail)).toBe(0);
  await click(button("Показать вывод", rows()[0]));
  expect(reads(detail)).toBe(1);
  expect(rows()[0].querySelector("pre")?.textContent).toContain("WARNING longpoll: переподключение к Long Poll после таймаута");
  expect(button("Скрыть вывод", rows()[0])!.getAttribute("aria-expanded")).toBe("true");
  await click(button("Показать ещё"));
  expect(rows()).toHaveLength(26);
  expect(button("Показать ещё")).toBeUndefined();
});

it("lists the bot's log errors with level, place, message, count and last time, the traceback folded", async () => {
  await mount();
  const errors = card("Ошибки в журнале бота")!;
  const [first, second] = [...errors.querySelectorAll("li")];
  expect(first.textContent).toContain("ERROR");
  expect(first.querySelector("code")?.textContent).toBe("_scheduler_loop");
  expect(first.textContent).toContain("Critical error in the scheduler loop: timeout");
  expect(first.textContent).toContain("3 раза");
  expect(first.querySelector("time")?.getAttribute("dateTime")).toBe(mock!.botConsole.errors[0].last_at);
  const traceback = first.querySelector("details")!;
  expect(traceback.open).toBe(false);
  expect(traceback.querySelector("summary")?.textContent).toBe("Трассировка");
  expect(traceback.querySelector("pre")?.textContent).toContain("TimeoutError: timed out");
  expect(second.textContent).toContain("WARNING");
  expect(second.textContent).toContain("12 раз");
  expect(second.querySelector("details")).toBeNull();
  await page!.cleanup();page = undefined;mock!.restore();
  await mount("it", { scenario: "empty" });
  expect(card("Ошибки в журнале бота")!.textContent).toContain("Ошибок в журнале бота нет.");
  expect(card("История команд")!.textContent).toContain("Команд пока не было.");
  expect(card("Сопровождающие")!.textContent).toContain("Сопровождающих пока нет.");
});

it("lets the IT master name and remove maintainers; a maintainer sees the list and operates, a viewer only reads", async () => {
  await mount();
  const maintainers = () => card("Сопровождающие")!;
  expect(maintainers().textContent).toContain("Иван Петров");
  const puts = () => mock!.adapter.history.put.filter((request) => request.url?.startsWith("/bot/maintainers/")).map((request) => [request.url, JSON.parse(request.data as string)]);
  const form = maintainers().querySelector('[data-field-name="user"]')!.closest("form")!;
  await pick(form, "user", "103");
  await submit(form);
  await waitForPage(page!, () => maintainers().textContent!.includes("Мария Орлова"));
  expect(puts()).toEqual([["/bot/maintainers/103", { maintainer: true }]]);
  await click(maintainers().querySelector<HTMLButtonElement>('button[aria-label="Снять с сопровождения бота: Иван Петров"]')!);
  await waitForPage(page!, () => !maintainers().textContent!.includes("Иван Петров"));
  expect(puts()[1]).toEqual(["/bot/maintainers/102", { maintainer: false }]);
  expect(mock!.botConsole.maintainers).toEqual([103]);
  await page!.cleanup();page = undefined;mock!.restore();
  // A maintainer: the console and its commands, the list without changes.
  await mount("organizer", {}, maintainer);
  expect(card("Сопровождающие")!.textContent).toContain("Иван Петров");
  expect(card("Сопровождающие")!.textContent).toContain("Назначает их мастер блока IT.");
  expect(button("Снять", card("Сопровождающие")!)).toBeUndefined();
  expect(card("Сопровождающие")!.querySelector("form")).toBeNull();
  expect(reads("/contacts")).toBe(0);
  expect(card("Управление")).not.toBeNull();
  expect(button("Обновить до 2.5.0")).toBeDefined();
  await page!.cleanup();page = undefined;mock!.restore();
  // Seeing without operating: the state and the history, no command.
  await mount("organizer", {}, [...createFixtures("organizer").session.capabilities, "view_bot_console"]);
  expect(card("Состояние")).not.toBeNull();
  expect(card("Обновления")!.textContent).toContain("Доступна версия 2.5.0.");
  expect(card("Управление")).toBeNull();
  expect(card("Журнал бота")).toBeNull();
  expect(button("Обновить до 2.5.0")).toBeUndefined();
  expect(card("История команд")).not.toBeNull();
});

const spinners = (root: ParentNode) => root.querySelectorAll('[class*="spinner"]').length;

it("turns a ring while the bot has the command, then while the server works on the update", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await mount();
  mock!.botConsole.step = 1;
  const updates = () => card("Обновления")!;
  expect(spinners(updates())).toBe(0);
  await click(button("Обновить до 2.5.0"));
  await click(button("Да, обновить"));
  expect(updates().textContent).toContain("Ждёт бота");
  expect(spinners(updates())).toBe(1);
  expect(updates().querySelector('[aria-busy="true"]')).not.toBeNull();
  // The open command also turns in the history.
  expect(spinners(card("История команд")!)).toBe(1);
  await tick(COMMAND_POLL_MS);
  expect(updates().textContent).toContain("Выполняется");
  expect(spinners(updates())).toBe(1);
  await tick(COMMAND_POLL_MS);
  expect(updates().textContent).toContain("Выполнена");
  // The demo's server ended the job of this request at once: its outcome, no ring.
  expect(text()).toContain("Сервер сообщил итог: готово.");
  expect(spinners(updates())).toBe(0);
  // A heartbeat without the job yet: the console waits for the server.
  const job = mock!.botConsole.heartbeat.updates!.job!;
  mock!.botConsole.heartbeat.updates!.job = null;
  await tick(STATUS_POLL_MS);
  expect(text()).toContain(SERVER_WAIT_TEXT);
  expect(spinners(updates())).toBe(1);
  // The job is going: one ring, by the command, not a second one by the job.
  mock!.botConsole.heartbeat.updates!.job = { ...job, state: "", phase: "build" };
  await tick(STATUS_POLL_MS);
  expect(text()).toContain(SERVER_WAIT_TEXT);
  expect(spinners(updates())).toBe(1);
  mock!.botConsole.heartbeat.updates!.job = { ...job, state: "failed", phase: "health", rolled_back: true };
  await tick(STATUS_POLL_MS);
  expect(text()).toContain("Сервер сообщил итог: новая версия не заработала, сервер вернул прежнюю.");
  expect(text()).not.toContain(SERVER_WAIT_TEXT);
  expect(spinners(updates())).toBe(0);
});

it("shows a job going on the server with a ring, whoever started it", async () => {
  await mount("it", {}, undefined, () => {
    const updates = mock!.botConsole.heartbeat.updates!;
    updates.job = { id: "dm-1", source: "bot", action: "update", state: "", phase: "build", reason: "", from: "2.4.0", to: "2.5.0",
      running: "2.4.0", rolled_back: false, started_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  });
  expect(card("Обновления")!.textContent).toContain("Сервер выполняет задачу. Итог придёт с очередным отчётом бота.");
  expect(spinners(card("Обновления")!)).toBe(1);
});

it("waits with a ring for the bot to come back after a restart", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await mount();
  mock!.botConsole.step = 1;
  const control = () => card("Управление")!;
  const before = mock!.botConsole.bootId;
  await click(button("Перезапустить бота"));
  await click(button("Да, перезапустить"));
  expect(spinners(control())).toBe(1);
  await tick(COMMAND_POLL_MS);
  await tick(COMMAND_POLL_MS);
  expect(control().textContent).toContain("Выполнена");
  // The demo's bot is back at once, under a new boot.
  expect(control().textContent).toContain("Бот снова на связи, запущен ");
  expect(spinners(control())).toBe(0);
  // Still the old boot: the console waits.
  const after = mock!.botConsole.bootId;
  mock!.botConsole.bootId = before;
  await tick(STATUS_POLL_MS);
  expect(control().textContent).toContain(RESTART_WAIT_TEXT);
  expect(spinners(control())).toBe(1);
  mock!.botConsole.bootId = after;
  await tick(STATUS_POLL_MS);
  expect(control().textContent).toContain("Бот снова на связи");
  expect(control().textContent).not.toContain(RESTART_WAIT_TEXT);
});
