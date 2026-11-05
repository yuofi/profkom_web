import { expect, it } from "vitest";
import { ApiError } from "../../utils/api/request";
import type { BotCommand, BotConsoleStatus, BotHeartbeat, BotUpdateCheck, BotUpdates } from "../../utils/api/contract";
import {
  COMMAND_POLL_MS, DOWNTIME, RESTART_WAIT_MS, SERVER_WAIT_MS, STATUS_POLL_MS, ago, jobFinished, jobGoing, jobOutcome, restartBackText,
  restartWait, serverWait, changelogFor, checkText, commandOutcome, commandPollInterval, commandTitle,
  componentRows, connection, counterRows, databaseName, isRelease, jobRows, lastReport, levelTone, logsArgs, longPollText, newerMajor,
  pauseText, queueText, remoteText, restartQuestion, rollbackOffer, rollbackQuestion, runningVersion, statusPollInterval, updateOffer,
  updateQuestion, updatesAllowed,
} from "./botConsoleView";

const check: BotUpdateCheck = { status: "available", checked_at: "2026-11-05T08:00:00Z", running: "2.4.0", target: "2.5.0", newer_major: "",
  blocked: "", previous: "2.3.0", rollback: "bot", error_kind: "" };
const updates = (rest: Partial<BotUpdateCheck> = {}, extra: Partial<BotUpdates> = {}): BotUpdates =>
  ({ remote: "on", check: { ...check, ...rest }, changelog: null, job: null, ...extra });
// "absent": a bot older than the updates field does not send it at all.
const heartbeat = (u: BotUpdates | null | "absent" = updates(), version = "2.4.0"): BotHeartbeat => ({
  version, commit: "abc1234", started_at: "2026-11-04T08:00:00Z", interval_s: 60, stopping: false, components: {}, longpoll_connected: true,
  database: "postgresql", counters: {}, ...(u === "absent" ? {} : { updates: u }),
});
const status = (rest: Partial<BotConsoleStatus> = {}): BotConsoleStatus => ({
  enabled: true, online: true, last_seen_at: "2026-11-05T09:00:00Z", boot_id: "b".repeat(32), heartbeat: heartbeat(), errors: [],
  paused: false, paused_at: null, paused_by: null, queue: { deliveries: 0, batches: 0 }, ...rest,
});

it("offers an update only to an available release other than the running one", () => {
  expect(updateOffer(heartbeat())).toBe("2.5.0");
  expect(updateOffer(heartbeat(updates({ target: "2.4.0" })))).toBeNull();
  expect(updateOffer(heartbeat(updates({ status: "up-to-date" })))).toBeNull();
  expect(updateOffer(heartbeat(updates({ status: "blocked", blocked: "2.5.0" })))).toBeNull();
  expect(updateOffer(heartbeat(updates({ target: "2.5.0-3-gabc1234" })))).toBeNull();
  expect(updateOffer(heartbeat(updates({ target: "" })))).toBeNull();
  // The heartbeat names the running version; the server's check is the fallback.
  expect(updateOffer(heartbeat(updates(), "2.5.0"))).toBeNull();
  expect(runningVersion(heartbeat(updates(), ""))).toBe("2.4.0");
  expect(updateOffer(heartbeat(updates({ running: "2.5.0" }), ""))).toBeNull();
  expect(updateOffer(heartbeat(null))).toBeNull();
  expect(updateOffer(heartbeat("absent"))).toBeNull();
  expect(updateOffer(null)).toBeNull();
  expect(updateOffer(heartbeat({ remote: null, check: null, changelog: null, job: null }))).toBeNull();
  // Stored unchecked: a value of another type is no offer.
  expect(updateOffer(heartbeat(updates({ target: 250 as unknown as string })))).toBeNull();
});

it("offers a rollback only through the bot and to a release other than the running one", () => {
  expect(rollbackOffer(heartbeat())).toBe("2.3.0");
  expect(rollbackOffer(heartbeat(updates({ rollback: "ssh" })))).toBeNull();
  expect(rollbackOffer(heartbeat(updates({ rollback: "" })))).toBeNull();
  expect(rollbackOffer(heartbeat(updates({ previous: "2.4.0" })))).toBeNull();
  expect(rollbackOffer(heartbeat(updates({ previous: "unknown" })))).toBeNull();
  // A rollback does not depend on an available update.
  expect(rollbackOffer(heartbeat(updates({ status: "up-to-date" })))).toBe("2.3.0");
  expect(isRelease(" 2.3.0 ")).toBe(true);
  expect(isRelease("v2.3.0")).toBe(false);
  expect(updatesAllowed(updates())).toBe(true);
  expect(updatesAllowed(updates({}, { remote: "off" }))).toBe(false);
  expect(updatesAllowed(updates({}, { remote: null }))).toBe(false);
  expect(updatesAllowed(undefined)).toBe(false);
});

it("shows the changelog of the offered version only, as plain text", () => {
  const changelog = { version: "2.5.0", from: "2.4.0", truncated: true, text: "\n### Добавлено\n- Консоль сайта.\n## Исправлено\n- Повтор.\n" };
  expect(changelogFor(updates({}, { changelog }), "2.5.0")).toEqual({ text: "Добавлено\n- Консоль сайта.\nИсправлено\n- Повтор.", truncated: true });
  expect(changelogFor(updates({}, { changelog }), "2.6.0")).toBeNull();
  expect(changelogFor(updates({}, { changelog: { ...changelog, text: "  " } }), "2.5.0")).toBeNull();
  expect(changelogFor(updates(), "2.5.0")).toBeNull();
});

it("words the server's check, its channel and a newer major version as the bot's DM does", () => {
  expect(checkText(heartbeat())).toBe("Доступна версия 2.5.0.");
  expect(checkText(heartbeat(updates({ target: "2.4.0" })))).toBe("Установлена последняя версия.");
  expect(checkText(heartbeat(updates({ status: "major-available", target: "", newer_major: "3.0.0" })))).toBe("Вышла новая основная версия 3.0.0: её ставит оператор сервера.");
  expect(checkText(heartbeat(updates({ status: "blocked", blocked: "2.5.0" })))).toContain("Новее есть только 2.5.0");
  expect(checkText(heartbeat(updates({ status: "dev-build" })))).toBe("Работает тестовая сборка: через бота её не обновить.");
  expect(checkText(heartbeat(updates({ status: "no-releases" })))).toBe("Выпущенных версий ещё нет.");
  expect(checkText(heartbeat(updates({ status: "error", error_kind: "network" })))).toBe("Последняя проверка не удалась: нет связи с GitHub.");
  expect(checkText(heartbeat(updates({ status: "error", error_kind: "" })))).toBe("Последняя проверка не удалась: сервер не получил версии.");
  expect(checkText(heartbeat(updates({ status: "later" })))).toBe("Непонятный итог проверки: «later».");
  expect(checkText(heartbeat({ remote: "on", check: null, changelog: null, job: null }))).toBe("Сервер ещё не проверял обновления.");
  expect(newerMajor(heartbeat(updates({ newer_major: "3.0.0" })))).toBe("3.0.0");
  expect(newerMajor(heartbeat())).toBeNull();
  expect(remoteText(updates())).toBe("Обновление через бота включено на сервере.");
  expect(remoteText(updates({}, { remote: "off" }))).toContain("выключено на сервере");
  expect(remoteText(null)).toBe("Сервер не сообщил, можно ли обновлять бота через него.");
});

it("lists the last job on the server with its range, state, phase, reason and return", () => {
  const job = { id: "j", source: "bot", action: "update", state: "failed", phase: "health", reason: "unhealthy", from: "2.4.0", to: "2.5.0",
    running: "2.4.0", rolled_back: true, started_at: "2026-11-05T08:00:00Z", updated_at: null };
  const rows = jobRows(job);
  expect(rows.slice(0, 6)).toEqual([
    ["Что", "Обновление"], ["Версии", "2.4.0 → 2.5.0"], ["Состояние", "новая версия не заработала, сервер вернул прежнюю"],
    ["Этап", "health"], ["Причина", "unhealthy"], ["Возврат", "сервер вернул прежнюю версию"],
  ]);
  expect(rows[6][0]).toBe("Когда");
  expect(jobRows({ ...job, action: "rollback", state: "running", phase: "", reason: "", from: "", rolled_back: false, started_at: null }))
    .toEqual([["Что", "Откат"], ["Версии", "до 2.5.0"], ["Состояние", "идёт"]]);
});

it("says whether the bot is reachable and why not, and how long ago it reported", () => {
  expect(connection(status())).toEqual({ label: "На связи", tone: "mint" });
  expect(connection(status({ enabled: false, online: false })).label).toBe("Связь выключена");
  expect(connection(status({ online: false, last_seen_at: null })).note).toBe("Бот ещё ни разу не выходил на связь.");
  expect(connection(status({ online: false, heartbeat: { ...heartbeat(), stopping: true } })).note).toContain("Бот сообщил, что останавливается.");
  expect(connection(status({ online: false })).note).toContain("Бот давно не присылал отчётов.");
  const now = Date.parse("2026-11-05T09:00:00Z");
  expect(lastReport(status({ last_seen_at: "2026-11-05T08:59:40Z" }), now)).toBe("Последний отчёт — 20 с назад");
  expect(lastReport(status({ last_seen_at: null }), now)).toBe("Отчётов от бота ещё не было");
  expect([ago(-3), ago(59.4), ago(60), ago(3599), ago(7200), ago(86_400 * 3)]).toEqual(["0 с назад", "59 с назад", "1 мин назад", "59 мин назад", "2 ч назад", "3 дн. назад"]);
});

it("names the health marks, the counters in order and the bot's settings", () => {
  expect(componentRows({ ...heartbeat(), components: { site: 0, extra: null, longpoll: 4, scheduler: 75 } }))
    .toEqual([["Long Poll", "4 с назад"], ["Планировщик", "1 мин назад"], ["Обмен с сайтом", "0 с назад"], ["extra", "нет отметки"]]);
  expect(counterRows({ broadcasts_sent: 3, zeta: 1, chats: 2, tokens: null }))
    .toEqual([["Беседы", "2"], ["Токены пользователей", "—"], ["Рассылки отправлены", "3"], ["zeta", "1"]]);
  expect([databaseName("postgresql"), databaseName("sqlite"), databaseName("mysql"), databaseName("")]).toEqual(["PostgreSQL", "SQLite", "mysql", "—"]);
  expect([longPollText(true), longPollText(false), longPollText(null)]).toEqual(["подключён", "не подключён", "неизвестно"]);
  expect([levelTone("CRITICAL"), levelTone("ERROR"), levelTone("WARNING"), levelTone("INFO")]).toEqual(["rose", "rose", "peach", undefined]);
  expect(queueText({ deliveries: 1, batches: 5 })).toBe("Ждут отправки: 1 уведомление и 5 пачек рассылок.");
});

it("says who paused the sending and when", () => {
  const paused = status({ paused: true, paused_at: "2026-11-05T09:30:00Z", paused_by: { user_id: 102, display_name: "Иван Петров", avatar_url: null } });
  expect(pauseText(paused)).toMatch(/^Отправка через бота приостановлена: Иван Петров, 5\sнояб\.\s2026\sг\., 12:30\. /);
  expect(pauseText(paused)).toContain("через сутки они истекают");
  expect(pauseText({ ...paused, paused_by: null, paused_at: null })).toMatch(/^Отправка через бота приостановлена\. /);
});

it("asks before what stops the bot, naming the versions and the downtime in one line", () => {
  expect(restartQuestion()).toContain(DOWNTIME);
  expect(updateQuestion("2.4.0", "2.5.0")).toMatch(/^Обновить бота 2\.4\.0 → 2\.5\.0\?/);
  expect(updateQuestion("", "2.5.0")).toMatch(/^Обновить бота до 2\.5\.0\?/);
  expect(updateQuestion("2.4.0", "2.5.0")).toContain(DOWNTIME);
  expect(rollbackQuestion("2.4.0", "2.3.0")).toMatch(/^Откатить бота 2\.4\.0 → 2\.3\.0\? Сервер сделает бэкап базы и вернёт 2\.3\.0\. Версию 2\.4\.0 потом не предложат/);
  expect(rollbackQuestion("2.4.0", "2.3.0")).toContain(DOWNTIME);
});

it("names a command by its kind and args, and its outcome by its state", () => {
  expect(commandTitle({ kind: "logs", args: { lines: 1, level: "ERROR", contains: "timeout" } })).toBe("Журнал: 1 запись, от ERROR, «timeout»");
  expect(commandTitle({ kind: "logs", args: {} })).toBe("Журнал: 200 записей");
  expect(commandTitle({ kind: "update", args: { version: "2.5.0" } })).toBe("Обновление до 2.5.0");
  expect(commandTitle({ kind: "rollback", args: { version: "2.3.0" } })).toBe("Откат на 2.3.0");
  expect(commandTitle({ kind: "restart", args: {} })).toBe("Перезапуск");
  // A kind of a newer contract keeps its own name.
  expect(commandTitle({ kind: "reload" as BotCommand["kind"], args: {} })).toBe("reload");
  expect(commandOutcome({ kind: "logs", state: "pending", message: null })).toContain("Ждём, пока бот возьмёт команду");
  expect(commandOutcome({ kind: "update", state: "running", message: null })).toBe("Бот передал запрос серверу и ждёт ответа.");
  expect(commandOutcome({ kind: "restart", state: "running", message: null })).toBe("Бот выполняет команду.");
  expect(commandOutcome({ kind: "restart", state: "done", message: null })).toContain("перезапускается");
  expect(commandOutcome({ kind: "update", state: "done", message: null })).toBe("Сервер начал обновление. Итог появится в «Обновлениях».");
  expect(commandOutcome({ kind: "logs", state: "failed", message: "Файла журнала нет." })).toBe("Команда не выполнена.");
  expect(commandOutcome({ kind: "logs", state: "unsupported", message: null })).toBe("Эта версия бота не знает такой команды.");
  expect(commandOutcome({ kind: "restart", state: "expired", message: null })).toContain("Бот не выполнил команду вовремя");
});

it("polls an open command every 2 s and the status every 5 s, and stops when nothing can change", () => {
  const command = { state: "pending" } as BotCommand;
  expect(commandPollInterval(command)).toBe(COMMAND_POLL_MS);
  expect(commandPollInterval({ ...command, state: "running" })).toBe(COMMAND_POLL_MS);
  for (const state of ["done", "failed", "unsupported", "expired"] as const) expect(commandPollInterval({ ...command, state }), state).toBe(false);
  expect(commandPollInterval(undefined)).toBe(false);
  expect(statusPollInterval(status(), null)).toBe(STATUS_POLL_MS);
  expect(statusPollInterval(undefined, null)).toBe(STATUS_POLL_MS);
  expect(statusPollInterval(status({ online: false }), null)).toBe(STATUS_POLL_MS);
  expect(statusPollInterval(status({ enabled: false, online: false }), null)).toBe(false);
  // A lost connection is worth another look; a refused access is not.
  expect(statusPollInterval(status(), new ApiError("x", 0, "network_error"))).toBe(STATUS_POLL_MS);
  expect(statusPollInterval(status(), new ApiError("x", 403, "forbidden"))).toBe(false);
});

it("checks the log form before it becomes a command", () => {
  expect(logsArgs({ lines: " 200 ", level: "", contains: "" })).toEqual({ args: { lines: 200, level: null, contains: null } });
  expect(logsArgs({ lines: "2000", level: "WARNING", contains: " Timeout" })).toEqual({ args: { lines: 2000, level: "WARNING", contains: " Timeout" } });
  expect(logsArgs({ lines: "1", level: "TRACE", contains: "   " })).toEqual({ args: { lines: 1, level: null, contains: null } });
  for (const lines of ["0", "2001", "", "1.5", "-3", "1e3"]) expect(logsArgs({ lines, level: "", contains: "" }), lines).toMatchObject({ field: "lines" });
  // Characters as the server counts them: an emoji is one.
  expect(logsArgs({ lines: "5", level: "", contains: "👋".repeat(100) }).args?.contains).toBe("👋".repeat(100));
  expect(logsArgs({ lines: "5", level: "", contains: "я".repeat(102) })).toEqual({ field: "contains", error: "Подстрока длиннее 100 символов. Сократите её на 2." });
});

it("waits for the server's job of the request after a done update, then for nothing", () => {
  const done = { command_id: "c".repeat(32), kind: "update", args: { version: "2.5.0" }, state: "done", code: null, message: null,
    requested_by: null, created_at: "2026-11-05T09:00:00Z", updated_at: "2026-11-05T09:00:05Z", finished_at: "2026-11-05T09:00:05Z",
    has_output: false, output: null } as BotCommand;
  const at = Date.parse("2026-11-05T09:01:00Z");
  const job = { id: done.command_id, source: "bot", action: "update", state: "", phase: "build", reason: "", from: "2.4.0", to: "2.5.0",
    running: "2.4.0", rolled_back: false, started_at: "2026-11-05T09:00:10Z", updated_at: "2026-11-05T09:00:40Z" };
  expect(serverWait(done, null, at)).toEqual({ waiting: true, late: false, job: null });
  expect(serverWait(done, { ...job, id: "other" }, at)).toEqual({ waiting: true, late: false, job: null });
  expect(serverWait(done, job, at)).toEqual({ waiting: true, late: false, job });
  expect(serverWait(done, { ...job, state: "ok" }, at)).toEqual({ waiting: false, late: false, job: { ...job, state: "ok" } });
  expect(serverWait(done, null, Date.parse("2026-11-05T09:00:05Z") + SERVER_WAIT_MS + 1)).toEqual({ waiting: false, late: true, job: null });
  for (const other of [{ ...done, state: "running" }, { ...done, kind: "updates_check" }, { ...done, state: "failed" }] as BotCommand[])
    expect(serverWait(other, job, at)).toBeNull();
  expect(serverWait(undefined, job, at)).toBeNull();
  expect(jobFinished({ ...job, state: "interrupted" })).toBe(true);
  expect(jobFinished({ ...job, state: "toString" })).toBe(false);
  expect(jobGoing(job, at)).toBe(true);
  expect(jobGoing({ ...job, state: "failed" }, at)).toBe(false);
  expect(jobGoing({ ...job, action: "" }, at)).toBe(false);
  expect(jobGoing(job, Date.parse("2026-11-05T10:00:00Z"))).toBe(false);
  expect(jobOutcome({ ...job, state: "failed" })).toBe("Сервер сообщил итог: новая версия не заработала, сервер вернул прежнюю.");
});

it("waits for another boot after a done restart", () => {
  const done = { command_id: "d".repeat(32), kind: "restart", args: {}, state: "done", code: null, message: null, requested_by: null,
    created_at: "2026-11-05T09:00:00Z", updated_at: "2026-11-05T09:00:02Z", finished_at: "2026-11-05T09:00:02Z", has_output: false,
    output: null } as BotCommand;
  const at = Date.parse("2026-11-05T09:00:30Z"), old = "b".repeat(32);
  expect(restartWait(done, old, status(), at)).toEqual({ back: false, late: false });
  expect(restartWait(done, old, status({ boot_id: "e".repeat(32) }), at)).toEqual({ back: true, late: false });
  expect(restartWait(done, null, status(), at)).toEqual({ back: true, late: false });
  expect(restartWait(done, old, status(), Date.parse("2026-11-05T09:00:02Z") + RESTART_WAIT_MS + 1)).toEqual({ back: false, late: true });
  expect(restartWait({ ...done, state: "running" }, old, status(), at)).toBeNull();
  expect(restartWait({ ...done, kind: "logs" } as BotCommand, old, status(), at)).toBeNull();
  expect(restartBackText(null)).toBe("Бот снова на связи. Long Poll подключается в течение минуты.");
  expect(restartBackText("2026-11-05T09:00:03Z")).toMatch(/^Бот снова на связи, запущен .+\. Long Poll подключается в течение минуты\.$/);
});
