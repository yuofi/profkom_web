import type {
  BotCommand, BotCommandKind, BotCommandState, BotConsoleStatus, BotHeartbeat, BotLogLevel, BotLogsArgs, BotUpdateJob, BotUpdates,
} from "../../utils/api/contract";
import type { Tone } from "../../components/Workspace/sections";
import { canRetainData } from "../../utils/api/request";
import { displayDate } from "../../utils/dates";
import { plural } from "./seasonAnalyticsView";

/** The status rereads this often, only while the tab is visible. */
export const STATUS_POLL_MS = 5000;
/** A command the reader waits for rereads this often while the bot has not finished it. */
export const COMMAND_POLL_MS = 2000;
/** `logs` (BOT_API.md, «Консоль бота»): 1–2000 records, 200 by default, a substring of 1–100. */
export const LOG_LINES_DEFAULT = 200;
export const LOG_LINES_MAX = 2000;
export const LOG_CONTAINS_MAX = 100;
export const LOG_LEVELS: readonly BotLogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

/** `heartbeat.updates` is stored as the bot sent it: a value is a string or nothing. */
const word = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const length = (text: string) => Array.from(text).length;
/** A release, as `update` and `rollback` take it. */
export const isRelease = (value: unknown) => /^\d+\.\d+\.\d+$/.test(word(value));

/** «4 с назад», «3 мин назад», «2 ч назад», «5 дн. назад». */
export function ago(seconds: number) {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86_400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86_400)} дн. назад`;
}
export const secondsSince = (value: string, now = Date.now()) => (now - Date.parse(value)) / 1000;

/** What the reader is told about the link with the bot: the badge and, when it is down, why. */
export function connection(status: BotConsoleStatus): { label: string; tone?: Tone; note?: string } {
  if (!status.enabled) return {
    label: "Связь выключена",
    note: "Связь с ботом на сайте выключена: бот не забирает работу, команды и пауза недоступны. Ниже — то, что он успел прислать.",
  };
  if (status.online) return { label: "На связи", tone: "mint" };
  const away = "Команды до него не дойдут, пока он не вернётся.";
  if (!status.last_seen_at) return { label: "Не на связи", tone: "rose", note: "Бот ещё ни разу не выходил на связь." };
  if (status.heartbeat?.stopping) return { label: "Не на связи", tone: "rose", note: `Бот сообщил, что останавливается. ${away}` };
  return { label: "Не на связи", tone: "rose", note: `Бот давно не присылал отчётов. ${away}` };
}

export function lastReport(status: BotConsoleStatus, now = Date.now()) {
  return status.last_seen_at ? `Последний отчёт — ${ago(secondsSince(status.last_seen_at, now))}` : "Отчётов от бота ещё не было";
}

/** The paused banner: who and when, and what it means for the queue (BOT_API.md, «Пауза отправки»). */
export function pauseText(status: BotConsoleStatus) {
  const who = status.paused_by ? `: ${status.paused_by.display_name}` : "";
  const when = status.paused_at ? `, ${displayDate(status.paused_at)}` : "";
  return `Отправка через бота приостановлена${who}${when}. Уведомления и рассылки не уходят в VK и копятся в очереди; через сутки они истекают. На сайте уведомления приходят как обычно.`;
}
export const queueText = ({ deliveries, batches }: BotConsoleStatus["queue"]) =>
  `Ждут отправки: ${deliveries} ${plural(deliveries, "уведомление", "уведомления", "уведомлений")} и ${batches} ${plural(batches, "пачка", "пачки", "пачек")} рассылок.`;

const COMPONENTS: Record<string, string> = { longpoll: "Long Poll", scheduler: "Планировщик", site: "Обмен с сайтом" };
/** Health marks, as of the heartbeat: the known components first, then the rest by name. */
export function componentRows(heartbeat: BotHeartbeat): [string, string][] {
  const keys = Object.keys(heartbeat.components ?? {});
  const known = Object.keys(COMPONENTS).filter((key) => keys.includes(key));
  return [...known, ...keys.filter((key) => !(key in COMPONENTS)).sort()].map((key) => {
    const value = heartbeat.components[key];
    return [COMPONENTS[key] ?? key, typeof value === "number" ? ago(value) : "нет отметки"];
  });
}

const COUNTERS: Record<string, string> = {
  chats: "Беседы",
  tokens: "Токены пользователей",
  delayed_pending: "Отложенные сообщения ждут",
  delayed_failed: "Отложенные сообщения не ушли",
  deliveries_sent: "Уведомления отправлены",
  deliveries_denied: "Уведомления: сообщения запрещены",
  deliveries_failed: "Уведомления не ушли",
  broadcasts_sent: "Рассылки отправлены",
  broadcasts_denied: "Рассылки: сообщения запрещены",
  broadcasts_failed: "Рассылки не ушли",
};
/** The bot's counters in a fixed order; a counter it did not send is not shown, an unknown one keeps its name. */
export function counterRows(counters: BotHeartbeat["counters"]): [string, string][] {
  const keys = Object.keys(counters ?? {});
  const known = Object.keys(COUNTERS).filter((key) => keys.includes(key));
  return [...known, ...keys.filter((key) => !(key in COUNTERS)).sort()].map((key) => {
    const value = counters[key];
    return [COUNTERS[key] ?? key, typeof value === "number" ? String(value) : "—"];
  });
}
export const databaseName = (value: string) => ({ postgresql: "PostgreSQL", sqlite: "SQLite" })[value] ?? (value || "—");
export const longPollText = (value: boolean | null | undefined) =>
  value === true ? "подключён" : value === false ? "не подключён" : "неизвестно";
export const levelTone = (level: string): Tone | undefined =>
  level === "CRITICAL" || level === "ERROR" ? "rose" : level === "WARNING" ? "peach" : undefined;

/** The version that runs now: the heartbeat's, else the one the server last saw. */
export const runningVersion = (heartbeat: BotHeartbeat | null | undefined) =>
  word(heartbeat?.version) || word(heartbeat?.updates?.check?.running);
/** Updates through the bot are allowed on the server; otherwise the bot's DM offers no button either. */
export const updatesAllowed = (updates: BotUpdates | null | undefined) => updates?.remote === "on";
/** «Обновить до X»: only when the server offers a release other than the running one (BOT_API.md, «Обновления в heartbeat»). */
export function updateOffer(heartbeat: BotHeartbeat | null | undefined) {
  const check = heartbeat?.updates?.check, target = word(check?.target);
  return check && word(check.status) === "available" && isRelease(target) && target !== runningVersion(heartbeat) ? target : null;
}
/** «Откатить на Y»: only when the server allows a rollback through the bot to another version. */
export function rollbackOffer(heartbeat: BotHeartbeat | null | undefined) {
  const check = heartbeat?.updates?.check, previous = word(check?.previous);
  return check && word(check.rollback) === "bot" && isRelease(previous) && previous !== runningVersion(heartbeat) ? previous : null;
}
/** The changelog of `version`, if the server prepared that one. */
export function changelogFor(updates: BotUpdates | null | undefined, version: string) {
  const changelog = updates?.changelog;
  return changelog && word(changelog.version) === version && word(changelog.text)
    // Plain text, as the bot's DM shows it: Markdown headings without «#».
    ? { text: changelog.text.replace(/^\n+|\n+$/g, "").replace(/^#{1,6}\s+/gm, ""), truncated: changelog.truncated === true }
    : null;
}

export function remoteText(updates: BotUpdates | null | undefined) {
  if (updates?.remote === "on") return "Обновление через бота включено на сервере.";
  if (updates?.remote === "off") return "Обновление через бота выключено на сервере: бота обновляет оператор сервера.";
  return "Сервер не сообщил, можно ли обновлять бота через него.";
}
const ERROR_KINDS: Record<string, string> = {
  network: "нет связи с GitHub",
  denied: "GitHub не пускает сервер в репозиторий",
  hostkey: "ключ хоста GitHub не совпал",
};
/** The last check in a sentence, as the bot's DM says it. */
export function checkText(heartbeat: BotHeartbeat | null | undefined) {
  const check = heartbeat?.updates?.check;
  if (!check) return "Сервер ещё не проверял обновления.";
  const target = word(check.target);
  let status = word(check.status);
  // state/check is not recounted yet after an update.
  if (status === "available" && target === runningVersion(heartbeat)) status = "up-to-date";
  switch (status) {
    case "available": return `Доступна версия ${target}.`;
    case "up-to-date": return "Установлена последняя версия.";
    case "major-available": return `Вышла новая основная версия ${word(check.newer_major)}: её ставит оператор сервера.`;
    case "blocked": return `Новее есть только ${word(check.blocked)}, но через бота её уже не поставить: это делает оператор сервера.`;
    case "dev-build": return "Работает тестовая сборка: через бота её не обновить.";
    case "no-releases": return "Выпущенных версий ещё нет.";
    case "error": return `Последняя проверка не удалась: ${ERROR_KINDS[word(check.error_kind)] ?? "сервер не получил версии"}.`;
    default: return status ? `Непонятный итог проверки: «${status}».` : "Итог проверки неизвестен.";
  }
}
/** A newer major release beside an available one: the bot does not install it. */
export function newerMajor(heartbeat: BotHeartbeat | null | undefined) {
  const check = heartbeat?.updates?.check;
  return check && word(check.status) === "available" && isRelease(check.newer_major) ? word(check.newer_major) : null;
}

const JOB_ACTIONS: Record<string, string> = { update: "Обновление", rollback: "Откат" };
const JOB_STATES: Record<string, string> = {
  ok: "готово",
  aborted: "не выполнено, ничего не изменилось",
  failed: "новая версия не заработала, сервер вернул прежнюю",
  inconclusive: "сервер не дождался, пока бот заработает",
  interrupted: "прервано, прежняя версия возвращена",
};
/** The last update or rollback on the server, field by field. */
export function jobRows(job: BotUpdateJob): [string, string][] {
  const from = word(job.from), to = word(job.to), state = word(job.state);
  const rows: [string, string][] = [
    ["Что", JOB_ACTIONS[word(job.action)] ?? (word(job.action) || "—")],
    ["Версии", from && to ? `${from} → ${to}` : to ? `до ${to}` : from || "—"],
    ["Состояние", JOB_STATES[state] ?? (state ? "идёт" : "—")],
  ];
  if (word(job.phase)) rows.push(["Этап", word(job.phase)]);
  if (word(job.reason)) rows.push(["Причина", word(job.reason)]);
  if (job.rolled_back === true) rows.push(["Возврат", "сервер вернул прежнюю версию"]);
  const at = word(job.updated_at) || word(job.started_at);
  if (at) rows.push(["Когда", displayDate(at)]);
  return rows;
}

export const commandKindNames: Record<BotCommandKind, string> = {
  restart: "Перезапуск",
  logs: "Журнал",
  updates_check: "Проверка обновлений",
  update: "Обновление",
  rollback: "Откат",
};
export const commandStateNames: Record<BotCommandState, string> = {
  pending: "Ждёт бота",
  running: "Выполняется",
  done: "Выполнена",
  failed: "Не выполнена",
  unsupported: "Бот не знает команду",
  expired: "Истекла",
};
export const commandStateTones: Record<BotCommandState, Tone | undefined> = {
  pending: "sky",
  running: "sky",
  done: "mint",
  failed: "rose",
  unsupported: "peach",
  expired: undefined,
};
/** The status rereads every 5 s while the tab is visible (TanStack skips the ticks of a hidden
 *  one). Not while the integration is off or the access is refused: nothing would change. */
export const statusPollInterval = (status: BotConsoleStatus | undefined, error: unknown) =>
  (status && !status.enabled) || (error && !canRetainData(error)) ? false : STATUS_POLL_MS;
/** The bot has not given its result yet. */
export const commandOpen = (command: BotCommand | undefined) => command?.state === "pending" || command?.state === "running";
/** An open command rereads every 2 s until the bot finishes it; TanStack skips the ticks while
 *  the tab is hidden. A finished one is not polled. */
export const commandPollInterval = (command: BotCommand | undefined) => (commandOpen(command) ? COMMAND_POLL_MS : false);

/** «Журнал: 200 записей, от WARNING, «timeout»», «Обновление до 2.5.0». A kind of a newer
 *  contract keeps its own name. */
export function commandTitle({ kind, args }: Pick<BotCommand, "kind" | "args">) {
  const name = (commandKindNames as Record<string, string>)[kind] ?? kind;
  const values = (args ?? {}) as Partial<BotLogsArgs & { version: string }>;
  if (kind === "logs") {
    const lines = typeof values.lines === "number" ? values.lines : LOG_LINES_DEFAULT;
    const parts = [`${lines} ${plural(lines, "запись", "записи", "записей")}`];
    if (values.level) parts.push(`от ${values.level}`);
    if (values.contains) parts.push(`«${values.contains}»`);
    return `${name}: ${parts.join(", ")}`;
  }
  if ((kind === "update" || kind === "rollback") && word(values.version))
    return `${name} ${kind === "update" ? "до" : "на"} ${word(values.version)}`;
  return name;
}

const DONE: Record<string, string> = {
  restart: "Бот принял команду и перезапускается: через минуту он снова будет на связи.",
  logs: "Журнал получен.",
  updates_check: "Проверка выполнена.",
  update: "Сервер начал обновление. Итог появится в «Обновлениях».",
  rollback: "Сервер начал откат. Итог появится в «Обновлениях».",
};
/** What happened to the command, in one line. The bot's own message is shown beside it. */
export function commandOutcome(command: Pick<BotCommand, "kind" | "state" | "message">) {
  const server = ["updates_check", "update", "rollback"].includes(command.kind);
  switch (command.state) {
    case "pending": return "Ждём, пока бот возьмёт команду: он забирает работу раз в несколько секунд.";
    case "running": return server ? "Бот передал запрос серверу и ждёт ответа." : "Бот выполняет команду.";
    case "done": return DONE[command.kind] ?? "Команда выполнена.";
    case "failed": return "Команда не выполнена.";
    case "unsupported": return "Эта версия бота не знает такой команды.";
    case "expired": return "Бот не выполнил команду вовремя, и она отменена. Повторите её, когда бот будет на связи.";
    default: return "Состояние команды неизвестно.";
  }
}

/** One short line for every command that stops the bot for a while. */
export const DOWNTIME = "Пока бот перезапускается, он не видит сообщений, которые ему пишут.";
export const restartQuestion = () => `Перезапустить бота? Он остановится и через несколько секунд поднимется снова. ${DOWNTIME}`;
export const updateQuestion = (running: string, target: string) =>
  `Обновить бота ${running ? `${running} → ${target}` : `до ${target}`}? Сервер сделает бэкап базы и соберёт новую версию, обычно за 1–5 минут. ` +
  `Если она не заработает, сервер вернёт прежнюю. ${DOWNTIME}`;
export const rollbackQuestion = (running: string, target: string) =>
  `Откатить бота ${running ? `${running} → ${target}` : `на ${target}`}? Сервер сделает бэкап базы и вернёт ${target}. ` +
  `${running ? `Версию ${running}` : "Нынешнюю версию"} потом не предложат, пока не выйдет новая, а дальше назад через бота откатить нельзя. ${DOWNTIME}`;
export const PAUSE_QUESTION = "Приостановить отправку? Уведомления и рассылки перестанут уходить в VK и будут копиться в очереди; через сутки они истекают. На сайте уведомления приходят как обычно.";

/** The logs form as the command's args, or what to fix. */
export function logsArgs(values: { lines: string; level: string; contains: string }):
  | { args: BotLogsArgs; error?: undefined; field?: undefined }
  | { args?: undefined; error: string; field: "lines" | "contains" } {
  const lines = values.lines.trim();
  if (!/^\d+$/.test(lines) || Number(lines) < 1 || Number(lines) > LOG_LINES_MAX)
    return { error: `Укажите число записей от 1 до ${LOG_LINES_MAX}.`, field: "lines" };
  if (length(values.contains) > LOG_CONTAINS_MAX)
    return { error: `Подстрока длиннее ${LOG_CONTAINS_MAX} символов. Сократите её на ${length(values.contains) - LOG_CONTAINS_MAX}.`, field: "contains" };
  const level = LOG_LEVELS.find((item) => item === values.level) ?? null;
  return { args: { lines: Number(lines), level, contains: values.contains.trim() ? values.contains : null } };
}
