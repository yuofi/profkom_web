import { afterEach, expect, it } from "vitest";
import MockAdapter from "axios-mock-adapter";
import { api } from "../../api";
import { blockLifecycleApi } from "../blockLifecycle.api";
import { tasksApi } from "../tasks.api";
import { createFixtures } from "../../../mocks/fixtures";
import { wireIssues } from "../../../test/wireContract";

let mock: MockAdapter | undefined;
afterEach(() => { mock?.restore();mock = undefined; });
const fixture = createFixtures("chair");
it("lifecycle writes use the block CAS and explicit request ID, returning an ordinary Block DTO", async () => {
  const request = { request_id: "request-1", state: "scheduled", revision: 2, created_at: "2026-11-10T10:00:00Z", scheduled_at: "2026-11-10T11:00:00Z", delete_after: "2026-11-13T11:00:00Z", finished_at: null, cancel_reason: null, approvals: [{ actor: fixture.user, at: "2026-11-10T10:00:00Z" }], capabilities: ["cancel_block_deletion"] };
  const block = { ...fixture.blocks[0], revision: 15, archived_at: null, deletion_request: request };
  mock = new MockAdapter(api);mock.onPost().reply(200, block);
  expect(wireIssues("Block", await blockLifecycleApi.startDeletion("block-info", { expected_revision: 14 }))).toEqual([]);
  await blockLifecycleApi.approveDeletion("block-info", { expected_revision: 15, request_id: request.request_id });
  await blockLifecycleApi.cancelDeletion("block-info", { expected_revision: 16, request_id: request.request_id });
  expect(mock.history.post.map(config => [config.url, JSON.parse(config.data)])).toEqual([
    ["/blocks/block-info/deletion-request", { expected_revision: 14 }],
    ["/blocks/block-info/deletion-request/approve", { expected_revision: 15, request_id: "request-1" }],
    ["/blocks/block-info/deletion-request/cancel", { expected_revision: 16, request_id: "request-1" }],
  ]);
  expect(wireIssues("BlockDeletionRequest", { ...request, approvals: [{ actor: { ...fixture.user, secret: "unexpected" }, at: "now" }] })).not.toEqual([]);
});
it("season assignment remains a PATCH while atomic close carries season in exactly one status POST", async () => {
  mock = new MockAdapter(api);const task = { ...fixture.tasks[0], scope: { kind: "block", id: "block-info" }, season_id: null };
  mock.onPatch(`/tasks/${task.task_id}`).reply(200, { ...task, season_id: "season-1", revision: 2 });mock.onPost(`/tasks/${task.task_id}/status`).reply(200, { ...task, season_id: "season-1", status: "closed", revision: 3 });
  expect(wireIssues("Task", task)).toEqual([]);
  await tasksApi.update(task.task_id, { expected_revision: 1, season_id: "season-1" });
  await tasksApi.changeStatus(task.task_id, { expected_revision: 2, status: "closed", season_id: "season-1" });
  expect(JSON.parse(mock.history.patch[0].data)).toEqual({ expected_revision: 1, season_id: "season-1" });
  expect(JSON.parse(mock.history.post[0].data)).toEqual({ expected_revision: 2, status: "closed", season_id: "season-1" });
  expect(wireIssues("CalendarItem", { id: "deadline", season_id: null, kind: "task_deadline", title: "Работа", starts_at: "2026-11-10T11:00:00Z", ends_at: null, target: { kind: "task", id: task.task_id } })).toEqual([]);
  expect(wireIssues("UnresolvedAssignment", { assignment: task.assignments[0], task_id: task.task_id, task_title: task.title, season_id: null, scope: task.scope, deadline_at: task.deadline_at })).toEqual([]);
});
