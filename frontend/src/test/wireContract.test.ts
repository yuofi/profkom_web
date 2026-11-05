import { expect, it } from "vitest";
import { createFixtures } from "../mocks/fixtures";
import { wireIssues } from "./wireContract";

it("rejects extra public fields at every level, including array items", () => {
  const event = createFixtures("chair").events[0];
  expect(wireIssues("Event", { ...event, private_score: 9 })).toContain("Event.private_score: unexpected field");
  const nested = structuredClone(event);
  Object.assign(nested.leaders[0].user, { private_score: 9 });
  expect(wireIssues("Event", nested)).toContain("Event.leaders[0].user.private_score: unexpected field");
  const task = createFixtures("chair").tasks[0];
  Object.assign(task.assignments[0], { hours: 4, evaluation: 1 });
  const issues = wireIssues("Task", task);
  expect(issues).toContain("Task.assignments[0].hours: unexpected field");
  expect(issues).toContain("Task.assignments[0].evaluation: unexpected field");
});

it("keeps required, optional and nullable DTO fields exact", () => {
  const task = createFixtures("chair").tasks[0];
  expect(wireIssues("Task", task)).toEqual([]);
  expect(wireIssues("Task", { ...task, season_id: null, deadline_at: null })).toEqual([]);
  expect(wireIssues("UserRef", { user_id: null, display_name: "Архивный участник", avatar_url: null })).toEqual([]);
  expect(wireIssues("RichText", { format: "markdown" })).toContain("RichText.body: expected string");
  expect(wireIssues("RichText", { format: "markdown", body: "", extra: undefined })).toContain("RichText.extra: unexpected field");
});

it("checks each declared union branch without permitting unrelated keys", () => {
  expect(wireIssues("TaskScopeRef", { kind: "queue", id: "service" })).toEqual([]);
  expect(wireIssues("TaskScopeRef", { kind: "block", id: "team" })).toEqual([]);
  expect(wireIssues("TaskScopeRef", { kind: "queue", id: "service", private_score: 1 })).not.toEqual([]);
  expect(wireIssues("UserRef", [])).toEqual(["UserRef: expected object"]);
});

it("validates declared legacy compatibility fields without opening arbitrary metadata", () => {
  const session = createFixtures("chair").session;
  expect(wireIssues("Session", { ...session, permissions: [], leadership: { is_chair: true, is_deputy: false }, super_user: true, admin: false, pgas_admin: false })).toEqual([]);
  expect(wireIssues("Session", { ...session, permissions: [1] })).not.toEqual([]);
  expect(wireIssues("Session", { ...session, leadership: { is_chair: true, is_deputy: false, private_score: 3 } })).not.toEqual([]);
});

it("accepts the site-wide bot and broadcast grants among session assignments", () => {
  const session = createFixtures("chair").session;
  const site = { role_assignment_id: "site-1", user_id: session.user_id, role: "bot_maintainer", scope_kind: "site",
    scope_id: null, principal_assignment_id: null, revision: 1, capabilities: [] };
  expect(wireIssues("Session", { ...session, assignments: [...(session.assignments ?? []), site] })).toEqual([]);
  expect(wireIssues("Session", { ...session, assignments: [{ ...site, scope_kind: "galaxy" }] })).not.toEqual([]);
});

it("checks the stage 2 VK link in the session and the application, including null", () => {
  const session = createFixtures("organizer").session;
  const link = { state: "token_missing", required: true, blocked: true, deadline: "2026-12-01T00:00:00+03:00" };
  expect(wireIssues("Session", { ...session, bot_link: link })).toEqual([]);
  expect(wireIssues("Session", { ...session, bot_link: null })).toEqual([]);
  expect(wireIssues("Session", { ...session, bot_link: { ...link, deadline: null } })).toEqual([]);
  // A nullable object reports the whole field: neither the object nor null.
  expect(wireIssues("Session", { ...session, bot_link: { ...link, vk_user_id: 1 } })).toEqual([expect.stringMatching(/^Session\.bot_link: expected /)]);
  expect(wireIssues("Session", { ...session, bot_link: { ...link, state: "linked" } })).not.toEqual([]);
  expect(wireIssues("Session", { ...session, bot_link: { state: "ok", required: false, deadline: null } })).not.toEqual([]);
  const application = createFixtures("pending").registration;
  expect(wireIssues("RegistrationApplication", { ...application, bot_link: { state: "ok", vk_user_id: 123456 } })).toEqual([]);
  expect(wireIssues("RegistrationApplication", { ...application, bot_link: { state: "none", vk_user_id: null } })).toEqual([]);
  expect(wireIssues("RegistrationApplication", { ...application, bot_link: null })).toEqual([]);
  expect(wireIssues("RegistrationApplication", { ...application, bot_link: { state: "ok", vk_user_id: 1, token: "x" } })).toEqual([expect.stringMatching(/^RegistrationApplication\.bot_link: expected /)]);
  expect(wireIssues("ApplicationBotLink", { state: "ok", vk_user_id: 1, token: "x" })).toContain("ApplicationBotLink.token: unexpected field");
  expect(wireIssues("SessionBotLink", { ...link, vk_user_id: 1 })).toContain("SessionBotLink.vk_user_id: unexpected field");
});

it("checks GET /bot-link/me on and off, and POST /bot-link/code", () => {
  const on = { enabled: true, state: "ok", vk_user_id: 123456, messages_allowed: true, token_status: "unknown", linked_at: "2026-11-04T09:00:00Z",
    required: false, blocked: false, deadline: "2026-12-01T00:00:00+03:00", bot_url: "https://vk.me/test_bot", code_expires_at: null };
  const off = { enabled: false, state: null, vk_user_id: null, messages_allowed: null, token_status: null, linked_at: null,
    required: false, blocked: false, deadline: null, bot_url: null, code_expires_at: null };
  expect(wireIssues("BotLinkMe", on)).toEqual([]);
  expect(wireIssues("BotLinkMe", off)).toEqual([]);
  expect(wireIssues("BotLinkMe", { ...on, code_expires_at: "2026-11-04T09:15:00Z", messages_allowed: null })).toEqual([]);
  expect(wireIssues("BotLinkMe", { ...on, token_status: "expired" })).not.toEqual([]);
  expect(wireIssues("BotLinkMe", { ...on, code: "ABCDE-FGHJK" })).toContain("BotLinkMe.code: unexpected field");
  expect(wireIssues("BotLinkMe", { ...on, bot_url: undefined })).toContain("BotLinkMe.bot_url: expected string | null");
  const code = { code: "ABCDE-FGHJK", expires_at: "2026-11-04T09:15:00Z", link_url: "https://vk.me/test_bot?ref=ABCDEFGHJK", command: "привязать ABCDE-FGHJK" };
  expect(wireIssues("BotLinkCode", code)).toEqual([]);
  expect(wireIssues("BotLinkCode", { ...code, link_url: null })).toEqual([]);
  expect(wireIssues("BotLinkCode", { ...code, code_hash: "x" })).toContain("BotLinkCode.code_hash: unexpected field");
});

it("keeps every fixture session and application, and the demo bot answers, on the wire contract", async () => {
  const { mockRoles } = await import("../mocks/fixtures");
  const { installMockTransport } = await import("../mocks/transport");
  const { botLinkApi } = await import("../utils/api/botLink.api");
  for (const role of mockRoles) {
    const fixture = createFixtures(role);
    expect(wireIssues("Session", fixture.session), role).toEqual([]);
    expect(wireIssues("RegistrationApplication", fixture.registration), role).toEqual([]);
  }
  for (const bot of ["ok", "none", "denied", "blocked", "off"] as const) {
    const mock = installMockTransport("pending", { delay: 0, bot });
    try {
      expect(wireIssues("BotLinkMe", await botLinkApi.me()), bot).toEqual([]);
      expect(wireIssues("Session", mock.state.session), bot).toEqual([]);
      if (bot !== "off") expect(wireIssues("BotLinkCode", await botLinkApi.createCode()), bot).toEqual([]);
    } finally { mock.restore(); }
  }
});

it("checks the notification settings with the stage 3 channels and from an older server without them", () => {
  const off = { email: false, telegram: false, vk: false };
  const settings = { revision: 1, preferences: { tracker: off, applications: off, pgas: off }, delivery_status: "not_connected" };
  const channels = { email: "not_connected", telegram: "not_connected", vk: "ready" };
  expect(wireIssues("PreferenceSettings", settings)).toEqual([]);
  for (const vk of ["ready", "link_required", "not_connected"]) expect(wireIssues("PreferenceSettings", { ...settings, channels: { ...channels, vk } }), vk).toEqual([]);
  expect(wireIssues("PreferenceSettings", { ...settings, channels: { ...channels, vk: "linked" } })).toEqual([expect.stringMatching(/^PreferenceSettings\.channels: expected /)]);
  expect(wireIssues("PreferenceSettings", { ...settings, channels: { ...channels, max: "ready" } })).not.toEqual([]);
  expect(wireIssues("PreferenceSettings", { ...settings, channels: { email: "not_connected", vk: "ready" } })).not.toEqual([]);
  expect(wireIssues("PreferenceSettings", { ...settings, channels: null })).not.toEqual([]);
  expect(wireIssues("NotificationChannelState", "linked")).not.toEqual([]);
  // The Record-typed settings are checked key by key, as declared fields.
  expect(wireIssues("PreferenceSettings", { ...settings, preferences: { ...settings.preferences, pgas: { ...off, vk: "yes" } } })).toEqual(["PreferenceSettings.preferences.pgas.vk: expected boolean"]);
  expect(wireIssues("PreferenceSettings", { ...settings, preferences: { ...settings.preferences, pgas: { ...off, max: true } } })).toEqual(["PreferenceSettings.preferences.pgas.max: unexpected field"]);
});

it("keeps the demo notification settings on the wire contract, with VK as the demo bot is", async () => {
  const { installMockTransport } = await import("../mocks/transport");
  const { profileFeaturesApi } = await import("../utils/api/profileFeatures.api");
  const cases = [["ok", "ready"], ["none", "link_required"], ["denied", "link_required"], ["off", "not_connected"]] as const;
  for (const [bot, vk] of cases) {
    const mock = installMockTransport("organizer", { delay: 0, bot });
    try {
      const settings = await profileFeaturesApi.preferences();
      expect(wireIssues("PreferenceSettings", settings), bot).toEqual([]);
      expect(settings.channels, bot).toEqual({ email: "not_connected", telegram: "not_connected", vk });
      expect(wireIssues("PreferenceSettings", await profileFeaturesApi.savePreferences(settings.revision, settings.preferences)), bot).toEqual([]);
      // Messages allowed without a working token still deliver (BOT_API.md, stage 3).
      if (bot === "ok") for (const state of ["token_missing", "token_invalid"] as const) {
        mock.bot.state = state;mock.syncBot();
        expect((await profileFeaturesApi.preferences()).channels?.vk, state).toBe("ready");
      }
    } finally { mock.restore(); }
  }
});

it("checks the stage 4 broadcasts: a broadcast with and without counts, the audience and a sender change", () => {
  const counts = { total: 412, pending: 25, sent: 380, denied: 3, failed: 2, cancelled: 0, expired: 2 };
  const broadcast = { broadcast_id: "b-1", text: "Собрание\nв четверг", author: { user_id: 104, display_name: "Алексей Соколов", avatar_url: null },
    created_at: "2026-11-05T09:00:00Z", state: "sending", cancelled_at: null, counts, paused: null };
  // The bot console's pause beside a sending broadcast (stage 5).
  const pause = { paused_at: "2026-11-05T07:10:00Z", paused_by: { user_id: 104, display_name: "Алексей Соколов", avatar_url: null } };
  expect(wireIssues("Broadcast", broadcast)).toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, paused: pause })).toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, paused: { paused_at: null, paused_by: null } })).toEqual([]);
  expect(wireIssues("SendingPause", { ...pause, paused: true })).toContain("SendingPause.paused: unexpected field");
  expect(wireIssues("Broadcast", { ...broadcast, paused: undefined })).not.toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, counts: null, author: null })).toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, state: "cancelled", cancelled_at: "2026-11-05T09:03:00Z" })).toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, state: "paused" })).not.toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, recipients: [] })).toContain("Broadcast.recipients: unexpected field");
  // A nullable object reports the whole field: neither the counts nor null.
  expect(wireIssues("Broadcast", { ...broadcast, counts: { ...counts, vk_message_ids: [] } })).toEqual([expect.stringMatching(/^Broadcast\.counts: expected /)]);
  expect(wireIssues("BroadcastCounts", { ...counts, vk_message_ids: [] })).toContain("BroadcastCounts.vk_message_ids: unexpected field");
  expect(wireIssues("BroadcastCounts", { ...counts, expired: undefined })).toContain("BroadcastCounts.expired: expected number");
  expect(wireIssues("Broadcast", { ...broadcast, cancelled_at: undefined })).not.toEqual([]);
  expect(wireIssues("BroadcastAudience", { total: 430, reachable: 412, paused: null })).toEqual([]);
  expect(wireIssues("BroadcastAudience", { total: 430, reachable: 412, paused: pause })).toEqual([]);
  expect(wireIssues("BroadcastAudience", { total: 430, reachable: 412 })).not.toEqual([]);
  expect(wireIssues("BroadcastAudience", { total: 430, reachable: 412, paused: null, missing: 18 })).toContain("BroadcastAudience.missing: unexpected field");
  expect(wireIssues("BroadcastSenderChange", { user_id: 101, sender: true })).toEqual([]);
  expect(wireIssues("BroadcastSenderChange", { user_id: 101, sender: "yes" })).not.toEqual([]);
});

it("keeps the demo broadcasts on the wire contract for senders, the chair and other members", async () => {
  const { installMockTransport } = await import("../mocks/transport");
  const { broadcastsApi } = await import("../utils/api/broadcasts.api");
  for (const role of ["chair", "hr"] as const) {
    const mock = installMockTransport(role, { delay: 0 });
    try {
      const first = await broadcastsApi.list();
      const rest = await broadcastsApi.list(first.next_cursor);
      for (const item of [...first.items, ...rest.items]) expect(wireIssues("Broadcast", item), `${role} ${item.broadcast_id}`).toEqual([]);
      expect(first.items.every((item) => item.counts !== null)).toBe(true);
      expect(wireIssues("BroadcastAudience", await broadcastsApi.audience()), role).toEqual([]);
      const created = await broadcastsApi.create({ text: "Проверка", idempotency_key: "2806d837-7862-47db-9658-10c0ba31f12c" });
      expect(wireIssues("Broadcast", created), role).toEqual([]);
      expect(wireIssues("Broadcast", await broadcastsApi.cancel(created.broadcast_id)), role).toEqual([]);
      if (role === "chair") {
        for (const person of (await broadcastsApi.senders()).items) expect(wireIssues("UserRef", person)).toEqual([]);
        expect(wireIssues("BroadcastSenderChange", await broadcastsApi.setSender(101, true))).toEqual([]);
      }
    } finally { mock.restore(); }
  }
  const mock = installMockTransport("organizer", { delay: 0 });
  try {
    const item = await broadcastsApi.get("broadcast-3");
    expect(wireIssues("Broadcast", item)).toEqual([]);
    expect(item.counts).toBeNull();
  } finally { mock.restore(); }
});

it("checks the stage 5 console: the status with and without the updates, a command of each args shape and a maintainer change", () => {
  const check = { status: "available", checked_at: "2026-11-05T08:00:00Z", running: "2.4.0", target: "2.5.0", newer_major: "", blocked: "",
    previous: "2.3.0", rollback: "bot", error_kind: "" };
  const job = { id: "j-1", source: "bot", action: "update", state: "ok", phase: "", reason: "", from: "2.3.0", to: "2.4.0", running: "2.4.0",
    rolled_back: false, started_at: "2026-11-04T08:00:00Z", updated_at: null };
  const updates = { remote: "on", check, changelog: { version: "2.5.0", from: "2.4.0", truncated: false, text: "- Консоль." }, job };
  const heartbeat = { version: "2.4.0", commit: "abc1234", started_at: "2026-11-04T08:00:00Z", interval_s: 60, stopping: false,
    components: { longpoll: 4, site: null }, longpoll_connected: null, database: "postgresql", counters: { chats: 3, tokens: null }, updates };
  const error = { fingerprint: "f", level: "ERROR", logger: "bot", where: "loop.py:10", message: "Ошибка", traceback: null, count: 1,
    first_at: "2026-11-05T08:00:00Z", last_at: "2026-11-05T08:00:00Z" };
  const status = { enabled: true, online: true, last_seen_at: "2026-11-05T09:00:00Z", boot_id: "b-1", heartbeat, errors: [error], paused: true,
    paused_at: "2026-11-05T09:00:00Z", paused_by: { user_id: 101, display_name: "Анна Смирнова", avatar_url: null }, queue: { deliveries: 3, batches: 1 } };
  expect(wireIssues("BotConsoleStatus", status)).toEqual([]);
  // An older bot leaves the updates out; a bot that read none of its files sends every field null.
  const older = Object.fromEntries(Object.entries(heartbeat).filter(([key]) => key !== "updates"));
  expect(wireIssues("BotConsoleStatus", { ...status, heartbeat: older })).toEqual([]);
  expect(wireIssues("BotHeartbeat", { ...heartbeat, updates: null })).toEqual([]);
  expect(wireIssues("BotUpdates", { remote: null, check: null, changelog: null, job: null })).toEqual([]);
  expect(wireIssues("BotUpdates", { ...updates, remote: "maybe" })).not.toEqual([]);
  expect(wireIssues("BotConsoleStatus", { ...status, heartbeat: null, last_seen_at: null, boot_id: null, paused: false, paused_at: null, paused_by: null })).toEqual([]);
  expect(wireIssues("BotConsoleStatus", { ...status, token: "x" })).toContain("BotConsoleStatus.token: unexpected field");
  expect(wireIssues("BotConsoleStatus", { ...status, queue: { deliveries: 3 } })).toContain("BotConsoleStatus.queue.batches: expected number");
  expect(wireIssues("BotHeartbeat", { ...heartbeat, counters: { chats: "3" } })).not.toEqual([]);
  expect(wireIssues("BotLogError", { ...error, traceback: "Traceback…", ip: "10.0.0.1" })).toContain("BotLogError.ip: unexpected field");

  const command = { command_id: "c-1", kind: "logs", args: { lines: 200, level: null, contains: null }, state: "done", code: null, message: null,
    requested_by: null, created_at: "2026-11-05T09:00:00Z", updated_at: "2026-11-05T09:00:04Z", finished_at: "2026-11-05T09:00:04Z", has_output: true, output: null };
  expect(wireIssues("BotCommand", command)).toEqual([]);
  expect(wireIssues("BotCommand", { ...command, output: "2026-11-05 09:00:00 INFO start" })).toEqual([]);
  expect(wireIssues("BotCommand", { ...command, kind: "restart", args: {}, has_output: false, finished_at: null, state: "pending" })).toEqual([]);
  expect(wireIssues("BotCommand", { ...command, kind: "update", args: { version: "2.5.0" }, state: "failed", code: "rate_limited", message: "Подождите." })).toEqual([]);
  expect(wireIssues("BotCommand", { ...command, args: { lines: 200, level: "TRACE", contains: null } })).not.toEqual([]);
  expect(wireIssues("BotCommand", { ...command, args: { version: "2.5.0", force: true } })).not.toEqual([]);
  expect(wireIssues("BotCommand", { ...command, state: "cancelled" })).not.toEqual([]);
  expect(wireIssues("BotCommand", { ...command, kind: "shell" })).not.toEqual([]);
  expect(wireIssues("BotCommand", { ...command, idempotency_key: "k" })).toContain("BotCommand.idempotency_key: unexpected field");
  expect(wireIssues("BotMaintainerChange", { user_id: 102, maintainer: false })).toEqual([]);
  expect(wireIssues("BotMaintainerChange", { user_id: 102, maintainer: "no" })).not.toEqual([]);
});

it("keeps the demo console on the wire contract: status, history, an open command to its end, the pause and maintainers", async () => {
  const { installMockTransport } = await import("../mocks/transport");
  const { botConsoleApi } = await import("../utils/api/botConsole.api");
  const mock = installMockTransport("it", { delay: 0 });
  try {
    expect(wireIssues("BotConsoleStatus", await botConsoleApi.status())).toEqual([]);
    const first = await botConsoleApi.commands();
    const rest = await botConsoleApi.commands(first.next_cursor);
    for (const item of [...first.items, ...rest.items]) expect(wireIssues("BotCommand", item), item.command_id).toEqual([]);
    expect(new Set(first.items.map((item) => item.kind))).toEqual(new Set(["logs", "updates_check", "restart", "update"]));
    const created = await botConsoleApi.create({ kind: "logs", args: { lines: 5, level: "WARNING" }, idempotency_key: "8a7bd2c6-3d55-4d6c-9a7c-0f9c3fd7a6e1" });
    expect(wireIssues("BotCommand", created)).toEqual([]);
    let item = created;
    for (let i = 0; i < 5 && (item.state === "pending" || item.state === "running"); i += 1) {
      item = await botConsoleApi.command(created.command_id);
      expect(wireIssues("BotCommand", item), item.state).toEqual([]);
    }
    expect(item).toMatchObject({ state: "done", has_output: true, output: expect.any(String) });
    const restart = await botConsoleApi.create({ kind: "restart", args: {}, idempotency_key: "0c1f4a54-55b7-4a59-8a1c-8e3c1b7f0d2a" });
    expect(wireIssues("BotCommand", restart)).toEqual([]);
    expect(wireIssues("BotConsoleStatus", await botConsoleApi.pause(true))).toEqual([]);
    expect(wireIssues("BotConsoleStatus", await botConsoleApi.pause(false))).toEqual([]);
    for (const person of (await botConsoleApi.maintainers()).items) expect(wireIssues("UserRef", person)).toEqual([]);
    expect(wireIssues("BotMaintainerChange", await botConsoleApi.setMaintainer(104, true))).toEqual([]);
    // A bot that has never reported: no heartbeat, no report time.
    Object.assign(mock.botConsole, { online: false, reportAgo: null, heartbeat: null });
    expect(wireIssues("BotConsoleStatus", await botConsoleApi.status())).toEqual([]);
  } finally { mock.restore(); }
});
