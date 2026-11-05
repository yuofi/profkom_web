/** A synthetic bot console (BOT_API.md, «Консоль бота», stages 1 and 5). Nothing reaches a bot or
 *  a server: a command moves on by itself each time it is read, as the bot would take it. */
import type { Fixtures } from "./fixtures";
import type { BotCommand, BotCommandArgs, BotCommandKind, BotConsoleStatus, BotHeartbeat, BotLogError, SendingPause, UserRef } from "../utils/api/contract";

type Reply = [number, unknown];
type Body = Record<string, unknown>;
const copy = <T,>(value: T): T => structuredClone(value);
const fail = (status: number, code: string, message: string, fields?: object): Reply => [status, { detail: { code, message, fields } }];
const PAGE = 20;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** A 32-hex id, unique for each seed. */
const hex = (seed: number) => `${seed.toString(16).padStart(8, "0")}4be0a1c2d3e4f5061728394a`;
const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
const KINDS: BotCommandKind[] = ["restart", "logs", "updates_check", "update", "rollback"];

/** The bot's log the `logs` command reads, oldest first; a record with a traceback is one record. */
const LOG = [
  "2026-10-18 14:41:02 INFO site-sync: проход: доставок 3, пачек 0",
  "2026-10-18 14:42:10 WARNING longpoll: переподключение к Long Poll после таймаута",
  "2026-10-18 14:43:55 INFO scheduler: отложенных сообщений к отправке: 0",
  "2026-10-18 14:44:30 ERROR _scheduler_loop: Critical error in the scheduler loop: timeout\nTraceback (most recent call last):\n  File \"core/bot.py\", line 1059, in _scheduler_loop\nTimeoutError: timed out",
  "2026-10-18 14:45:01 INFO site-sync: проход: доставок 1, пачек 1",
  "2026-10-18 14:46:12 DEBUG site-sync: GET /work 200 за 18 мс",
  "2026-10-18 14:47:40 INFO site-sync: проход: доставок 0, пачек 0",
];

/** `enabled()` is the demo's integration switch (the «Бот ВКонтакте» picker, «Выключен»);
 *  `linked()` says whether the reader has a VK link for the server's requests. */
export function botConsoleMock(state: Fixtures, enabled: () => boolean, linked: () => boolean) {
  // A console is about now: its times follow the clock, not the fixtures' date.
  const started = Date.now(), at = (minutesBefore: number) => iso(started - minutesBefore * 60_000);
  const person = (id: number): UserRef => copy(state.people.find((p) => p.user_id === id)!);
  const heartbeat: BotHeartbeat = {
    version: "2.4.0", commit: "abc1234", started_at: at(60 * 26), interval_s: 60, stopping: false,
    components: { longpoll: 4, scheduler: 12, site: 0 }, longpoll_connected: true, database: "postgresql",
    counters: {
      chats: 3, tokens: 41, delayed_pending: 2, delayed_failed: 0,
      deliveries_sent: 128, deliveries_denied: 2, deliveries_failed: 1, broadcasts_sent: 412, broadcasts_denied: 6, broadcasts_failed: 2,
    },
    updates: {
      remote: "on",
      check: { status: "available", checked_at: at(40), running: "2.4.0", target: "2.5.0", newer_major: "", blocked: "",
        previous: "2.3.0", rollback: "bot", error_kind: "" },
      changelog: { version: "2.5.0", from: "2.4.0", truncated: false,
        text: "### Добавлено\n- Консоль сайта: перезапуск, журнал и обновление из профкома.\n\n### Исправлено\n- Повтор отправки после таймаута VK." },
      job: { id: hex(1), source: "bot", action: "update", state: "ok", phase: "done", reason: "", from: "2.3.0", to: "2.4.0",
        running: "2.4.0", rolled_back: false, started_at: at(60 * 26 + 4), updated_at: at(60 * 26) },
    },
  };
  const errors: BotLogError[] = [
    { fingerprint: "0f3a9c2d4e5b6a70", level: "ERROR", logger: "root", where: "_scheduler_loop",
      message: "Critical error in the scheduler loop: timeout",
      traceback: "Traceback (most recent call last):\n  File \"core/bot.py\", line 1059, in _scheduler_loop\nTimeoutError: timed out",
      count: 3, first_at: at(90), last_at: at(15) },
    { fingerprint: "7c1e2b3a4d5f6e80", level: "WARNING", logger: "longpoll", where: "listen",
      message: "Long Poll reconnect after # failures", traceback: null, count: 12, first_at: at(60 * 20), last_at: at(18) },
  ];
  const command = (id: number, kind: BotCommandKind, args: BotCommandArgs, rest: Partial<BotCommand>): BotCommand => ({
    command_id: hex(id), kind, args, state: "done", code: null, message: null, requested_by: person(101),
    created_at: at(60), updated_at: at(60), finished_at: at(60), has_output: false, output: null, ...rest,
  });
  const store = {
    online: true,
    /** Seconds since the last report, at each read; null — the bot never reported. */
    reportAgo: 20 as number | null,
    bootId: hex(9),
    heartbeat,
    errors,
    paused: false,
    pausedAt: null as string | null,
    pausedBy: null as number | null,
    queue: { deliveries: 3, batches: 1 },
    maintainers: [102] as number[],
    /** Reads of an open command that move it one state on; 0 holds it still. */
    step: 1,
    /** How the next command ends: as the bot does it, or refused by the server. */
    outcome: "done" as "done" | "failed" | "unsupported",
    lastRestart: null as number | null,
    keys: new Map<string, { body: string; id: string }>(),
    log: [...LOG],
    reads: new Map<string, number>(),
    commands: [
      command(1, "logs", { lines: 200, level: "WARNING", contains: null }, {
        requested_by: person(102), created_at: at(12), updated_at: at(12), finished_at: at(12), has_output: true,
        output: LOG.filter((line) => /^\S+ \S+ (WARNING|ERROR)/.test(line)).join("\n"),
      }),
      command(2, "updates_check", {}, { created_at: at(40), updated_at: at(40), finished_at: at(40) }),
      command(3, "restart", {}, { requested_by: null, created_at: at(60 * 5), updated_at: at(60 * 5), finished_at: at(60 * 5) }),
      command(4, "update", { version: "2.4.0" }, {
        state: "failed", code: "rate_limited", message: "Сервер принимает запросы не чаще раза в минуту.",
        created_at: at(60 * 26 + 10), updated_at: at(60 * 26 + 10), finished_at: at(60 * 26 + 10),
      }),
      command(5, "update", { version: "2.4.0" }, { created_at: at(60 * 26 + 5), updated_at: at(60 * 26 + 4), finished_at: at(60 * 26 + 4) }),
      command(6, "restart", {}, { state: "expired", requested_by: person(102), created_at: at(60 * 30), updated_at: at(60 * 30), finished_at: null }),
      // Older ones, for the second page of the history.
      ...Array.from({ length: PAGE }, (_, index) => command(10 + index, index % 2 ? "updates_check" : "logs",
        index % 2 ? {} : { lines: 200, level: null, contains: null },
        { created_at: at(60 * 24 * (3 + index)), updated_at: at(60 * 24 * (3 + index)), finished_at: at(60 * 24 * (3 + index)) })),
    ],
  };
  const can = (capability: string) => state.session.capabilities.includes(capability);
  const status = (): BotConsoleStatus => ({
    enabled: enabled(), online: enabled() && store.online, boot_id: store.bootId,
    last_seen_at: store.reportAgo === null ? null : iso(Date.now() - store.reportAgo * 1000),
    heartbeat: copy(store.heartbeat), errors: copy(store.errors), paused: store.paused, paused_at: store.pausedAt,
    paused_by: store.pausedBy === null ? null : person(store.pausedBy), queue: copy(store.queue),
  });
  const now = () => iso(Date.now());
  /** The bot finishes a command: what it changes on its side and in its heartbeat. */
  const finish = (item: BotCommand) => {
    const args = item.args as { lines?: number; level?: string | null; contains?: string | null; version?: string };
    const updates = store.heartbeat.updates!, check = updates.check!;
    item.state = store.outcome;
    item.finished_at = now();
    if (store.outcome === "failed") {
      Object.assign(item, item.kind === "logs"
        ? { code: "no_log", message: "Файла журнала нет." }
        : { code: "busy", message: "На сервере идёт другая операция. Повторите через несколько минут." });
      return;
    }
    if (store.outcome === "unsupported") return;
    if (item.kind === "restart") { store.bootId = hex(Date.now() % 997);store.heartbeat.started_at = now(); }
    if (item.kind === "updates_check") check.checked_at = now();
    if (item.kind === "logs") {
      const floor = LEVELS.indexOf(args.level ?? "DEBUG"), needle = args.contains?.toLowerCase();
      const lines = store.log.filter((line) => LEVELS.indexOf(line.split(" ")[2]) >= floor && (!needle || line.toLowerCase().includes(needle)));
      item.output = lines.slice(-(args.lines ?? 200)).join("\n");
      item.has_output = true;
    }
    if (item.kind === "update" || item.kind === "rollback") {
      const from = store.heartbeat.version, to = args.version!;
      store.heartbeat.version = to;store.bootId = hex(Date.now() % 991);store.heartbeat.started_at = now();
      updates.job = { id: item.command_id, source: "bot", action: item.kind, state: "ok", phase: "done", reason: "", from, to,
        running: to, rolled_back: false, started_at: item.created_at, updated_at: now() };
      updates.check = item.kind === "update"
        ? { ...check, status: "up-to-date", running: to, target: to, previous: from, rollback: "bot", checked_at: now() }
        : { ...check, status: "blocked", running: to, target: "", blocked: from, previous: "", rollback: "", checked_at: now() };
    }
  };
  const advance = (item: BotCommand) => {
    if (!store.step || (item.state !== "pending" && item.state !== "running")) return;
    const reads = (store.reads.get(item.command_id) ?? 0) + 1;
    store.reads.set(item.command_id, reads);
    if (reads % store.step) return;
    item.updated_at = now();
    if (item.state === "pending") item.state = "running";
    else finish(item);
  };
  const view = (item: BotCommand, output: boolean): BotCommand => ({ ...copy(item), output: output ? item.output : null });
  const invalidArgs = (kind: BotCommandKind, args: unknown) => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return true;
    const values = args as Body, names = Object.keys(values);
    if (kind === "restart" || kind === "updates_check") return names.length > 0;
    if (kind === "update" || kind === "rollback")
      return names.join() !== "version" || typeof values.version !== "string" || !/^\d+\.\d+\.\d+$/.test(values.version);
    if (names.some((name) => !["lines", "level", "contains"].includes(name))) return true;
    const { lines = 200, level = null, contains = null } = values;
    return !(Number.isInteger(lines) && (lines as number) >= 1 && (lines as number) <= 2000)
      || !(level === null || LEVELS.includes(level as string))
      || !(contains === null || (typeof contains === "string" && Array.from(contains).length >= 1 && Array.from(contains).length <= 100));
  };
  const normalized = (kind: BotCommandKind, args: Body): BotCommandArgs =>
    kind === "logs" ? { lines: 200, level: null, contains: null, ...args } as BotCommandArgs : copy(args) as BotCommandArgs;
  const group = (kind: string) => (kind === "rollback" ? "update" : kind);

  const handle = (path: string, method: string, data: Body, search?: URLSearchParams): Reply | undefined => {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "bot" || !["console", "maintainers"].includes(parts[1])) return undefined;
    if (!can("view_bot_console")) return fail(403, "forbidden", "Bot console access required");
    if (parts[1] === "maintainers") {
      if (!parts[2] && method === "get") return [200, { items: store.maintainers.map((id) => person(id)), next_cursor: null }];
      if (parts[2] && method === "put") {
        if (!can("manage_bot_maintainers")) return fail(403, "forbidden", "Only the IT block master manages bot maintainers");
        const userId = Number(parts[2]), extra = Object.keys(data).filter((name) => name !== "maintainer");
        if (extra.length || typeof data.maintainer !== "boolean") return fail(422, "invalid_input", "Проверьте поля формы");
        if (!state.people.some((p) => p.user_id === userId)) return fail(404, "not_found", "Active user not found");
        store.maintainers = store.maintainers.filter((id) => id !== userId);
        if (data.maintainer) store.maintainers.push(userId);
        return [200, { user_id: userId, maintainer: data.maintainer }];
      }
      return fail(405, "method_not_allowed", "Method not allowed");
    }
    if (parts[2] === "status" && method === "get") return [200, status()];
    if (parts[2] === "pause" && method === "put") {
      if (!can("operate_bot")) return fail(403, "forbidden", "Bot console operation required");
      if (!enabled()) return fail(404, "bot_api_disabled", "Bot integration is disabled");
      if (Object.keys(data).join() !== "paused" || typeof data.paused !== "boolean") return fail(422, "validation_error", "Invalid body");
      if (data.paused !== store.paused) {
        store.paused = data.paused;
        store.pausedAt = data.paused ? now() : null;
        store.pausedBy = data.paused ? state.session.user_id : null;
      }
      return [200, status()];
    }
    if (parts[2] !== "commands") return fail(404, "not_found", "Not found");
    if (!parts[3] && method === "get") {
      const sorted = [...store.commands].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.command_id.localeCompare(a.command_id));
      const start = Number(search?.get("cursor") ?? 0) || 0;
      return [200, { items: sorted.slice(start, start + PAGE).map((item) => view(item, false)), next_cursor: start + PAGE < sorted.length ? String(start + PAGE) : null }];
    }
    if (parts[3] && method === "get") {
      const item = store.commands.find((row) => row.command_id === parts[3]);
      if (!item) return fail(404, "not_found", "No such command");
      advance(item);
      return [200, view(item, true)];
    }
    if (parts[3] || method !== "post") return fail(405, "method_not_allowed", "Method not allowed");
    if (!can("operate_bot")) return fail(403, "forbidden", "Bot console operation required");
    if (!enabled()) return fail(404, "bot_api_disabled", "Bot integration is disabled");
    const kind = data.kind as BotCommandKind, key = data.idempotency_key;
    const extra = Object.keys(data).filter((name) => !["kind", "args", "idempotency_key"].includes(name));
    if (extra.length || !KINDS.includes(kind) || invalidArgs(kind, data.args ?? {}) || (key !== undefined && (typeof key !== "string" || !/^[0-9a-f-]{36}$/i.test(key))))
      return fail(422, "validation_error", "Invalid command");
    const args = normalized(kind, (data.args ?? {}) as Body), body = JSON.stringify([kind, args]);
    const known = typeof key === "string" ? store.keys.get(key) : undefined;
    if (known) {
      if (known.body !== body) return fail(409, "duplicate_request_key", "Idempotency key has already been used");
      return [200, view(store.commands.find((item) => item.command_id === known.id)!, true)];
    }
    if (!store.online) return fail(409, "bot_offline", "The bot is offline");
    if (store.commands.some((item) => (item.state === "pending" || item.state === "running") && group(item.kind) === group(kind)))
      return fail(409, "bot_command_pending", "A command of this kind is pending");
    if (kind !== "restart" && kind !== "logs" && !linked()) return fail(409, "bot_console_vk_required", "A VK link is required");
    if (kind === "restart") {
      if (store.lastRestart !== null && Date.now() - store.lastRestart < 120_000) return fail(429, "bot_command_rate_limited", "Restarted less than 2 minutes ago");
      store.lastRestart = Date.now();
    }
    const created = now();
    const item: BotCommand = {
      command_id: hex(store.commands.length + 100 + store.keys.size), kind, args, state: "pending", code: null, message: null,
      requested_by: copy(state.user), created_at: created, updated_at: created, finished_at: null, has_output: false, output: null,
    };
    store.commands.push(item);
    if (typeof key === "string") store.keys.set(key, { body, id: item.command_id });
    return [200, view(item, true)];
  };
  /** The pause as the broadcasts show it to senders (BOT_API.md, «Пауза отправки»). */
  const pause = (): SendingPause | null => store.paused
    ? { paused_at: store.pausedAt, paused_by: store.pausedBy === null ? null : person(store.pausedBy) }
    : null;
  return Object.assign(handle, { store, pause });
}
