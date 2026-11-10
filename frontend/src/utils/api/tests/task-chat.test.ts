import { afterEach, expect, it } from "vitest";
import MockAdapter from "axios-mock-adapter";
import { api } from "../../api";
import { taskChatApi } from "../taskChat.api";
import { wireIssues } from "../../../test/wireContract";

let mock: MockAdapter | undefined;
afterEach(() => { mock?.restore();mock = undefined; });
const scope = { kind: "event" as const, id: "event-1" };
const binding = { binding_id: "b-1", revision: 4, provider: "vk", bot_identity: 123, peer_id: 2000000001, title: "Команда", state: "linked", confirmed_at: "2026-11-10T10:00:00Z", observed_at: "2026-11-10T10:00:00Z" };
const context = { scope, binding, available: true, reason: null, can_manage: true, bot_online: true, recipient_mode: "assignees", missing_vk_user_ids: [] };
it("serializes only the selected queue/scope and intended recipients into the context request", async () => {
  mock = new MockAdapter(api);mock.onGet("/tasks/chat-context").reply(200, context);
  const result = await taskChatApi.context("queue-1", scope, [101, 102]);
  expect(mock.history.get[0].params).toEqual({ queue_id: "queue-1", assignee_user_ids: "101,102" });
  expect(wireIssues("TaskChatContext", result)).toEqual([]);
  await taskChatApi.context(undefined, scope, []);
  expect(mock.history.get[1].params).toEqual({ scope_kind: "event", scope_id: "event-1" });
  expect(wireIssues("TaskChatContext", { ...context, binding: { ...binding, access_token: "must-never-be-returned" } })).not.toEqual([]);
});
it("uses revision-checked settings writes and accepts a null revoked binding", async () => {
  mock = new MockAdapter(api);
  const settings = { scope, revision: 4, binding, capabilities: ["manage_chat", "link_chat", "unlink_chat"] };
  const code = { code: "SYNTHETIC-ONLY", command: "/site_bind SYNTHETIC-ONLY", expires_at: "2026-11-10T10:10:00Z", revision: 4 };
  mock.onGet("/scopes/event/event-1/chat").reply(200, settings);
  mock.onPost("/scopes/event/event-1/chat/link-code").reply(200, code);
  mock.onDelete("/scopes/event/event-1/chat").reply(200, { ...settings, revision: 5, binding: null });
  expect(wireIssues("ChatSettings", await taskChatApi.settings(scope))).toEqual([]);
  expect(wireIssues("ChatLinkCode", await taskChatApi.linkCode(scope, { expected_revision: 4 }))).toEqual([]);
  expect(wireIssues("ChatSettings", await taskChatApi.unlink(scope, { expected_revision: 4 }))).toEqual([]);
  expect(JSON.parse(mock.history.post[0].data)).toEqual({ expected_revision: 4 });
  expect(JSON.parse(mock.history.delete[0].data)).toEqual({ expected_revision: 4 });
});
it("keeps delivery retry separate from task creation and validates nested creator fields", async () => {
  mock = new MockAdapter(api);
  const summary = { announcement_id: "a-1", state: "pending", revision: 6, error_code: null, sent_at: null, created_at: "2026-11-10T10:00:00Z", created_by: { user_id: 101, display_name: "Автор", avatar_url: null }, capabilities: [] };
  mock.onPost("/tasks/task-1/chat-announcement/retry").reply(200, summary);
  const result = await taskChatApi.retry("task-1", { expected_revision: 5 });
  expect(wireIssues("TaskChatAnnouncement", result)).toEqual([]);
  expect(JSON.parse(mock.history.post[0].data)).toEqual({ expected_revision: 5 });
  expect(wireIssues("TaskChatAnnouncement", { ...summary, created_by: { ...summary.created_by, vk_token: "unexpected" } })).not.toEqual([]);
});
