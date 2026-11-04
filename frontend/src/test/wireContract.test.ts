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
    created_at: "2026-11-05T09:00:00Z", state: "sending", cancelled_at: null, counts };
  expect(wireIssues("Broadcast", broadcast)).toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, counts: null, author: null })).toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, state: "cancelled", cancelled_at: "2026-11-05T09:03:00Z" })).toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, state: "paused" })).not.toEqual([]);
  expect(wireIssues("Broadcast", { ...broadcast, recipients: [] })).toContain("Broadcast.recipients: unexpected field");
  // A nullable object reports the whole field: neither the counts nor null.
  expect(wireIssues("Broadcast", { ...broadcast, counts: { ...counts, vk_message_ids: [] } })).toEqual([expect.stringMatching(/^Broadcast\.counts: expected /)]);
  expect(wireIssues("BroadcastCounts", { ...counts, vk_message_ids: [] })).toContain("BroadcastCounts.vk_message_ids: unexpected field");
  expect(wireIssues("BroadcastCounts", { ...counts, expired: undefined })).toContain("BroadcastCounts.expired: expected number");
  expect(wireIssues("Broadcast", { ...broadcast, cancelled_at: undefined })).not.toEqual([]);
  expect(wireIssues("BroadcastAudience", { total: 430, reachable: 412 })).toEqual([]);
  expect(wireIssues("BroadcastAudience", { total: 430, reachable: 412, missing: 18 })).toContain("BroadcastAudience.missing: unexpected field");
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
