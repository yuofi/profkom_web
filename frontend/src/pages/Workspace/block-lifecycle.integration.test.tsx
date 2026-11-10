// @vitest-environment jsdom
import { expect, it } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { blockLifecycleApi } from "../../utils/api/blockLifecycle.api";
import { membershipApi } from "../../utils/api/membership.api";
import { sessionApi } from "../../utils/api/session.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { richText } from "../../utils/api/contract";

it("uses real block DTOs for create, rename, distinct approvals, 72-hour schedule and cancellation", async () => {
  const deputy = await liveParticipant("block-approval");
  await liveLogin();
  const leadership = await sessionApi.leadership(), previous = leadership.deputies.map(p => p.user_id!);
  await sessionApi.deputies([...previous, deputy.user_id], { expected_revision: leadership.revision });
  try {
    const unique = crypto.randomUUID();
    let block = await blockLifecycleApi.create({ name: `Новый блок ${unique}` });
    expect(block.archived_at).toBeNull();expect(block.deletion_request).toBeNull();
    expect(block.capabilities).toContain("start_block_deletion");
    const id = block.block_id;
    block = await membershipApi.updateBlock(id, { name: `Переименованный блок ${unique}`, expected_revision: block.revision });
    expect(block.block_id).toBe(id);
    block = await blockLifecycleApi.startDeletion(id, { expected_revision: block.revision });
    expect(block.deletion_request?.state).toBe("pending");
    const requestId = block.deletion_request!.request_id;
    await expect(blockLifecycleApi.approveDeletion(id, { expected_revision: block.revision, request_id: requestId }))
      .rejects.toMatchObject({ status: 403, code: "block_deletion_self_approval" });
    await liveLogin(deputy.email);
    block = await blockLifecycleApi.approveDeletion(id, { expected_revision: block.revision, request_id: requestId });
    const request = block.deletion_request!;
    expect(request.state).toBe("scheduled");expect(request.approvals).toHaveLength(2);
    expect(new Set(request.approvals.map(a => a.actor.user_id)).size).toBe(2);
    expect(Date.parse(request.delete_after!) - Date.parse(request.scheduled_at!)).toBe(72 * 3600000);
    expect((await membershipApi.blocks()).some(b => b.block_id === id)).toBe(true);
    block = await blockLifecycleApi.cancelDeletion(id, { expected_revision: block.revision, request_id: requestId });
    expect(block.deletion_request?.state).toBe("cancelled");expect(block.archived_at).toBeNull();
  } finally {
    await liveLogin();
    const latest = await sessionApi.leadership();
    await sessionApi.deputies(previous, { expected_revision: latest.revision });
  }
});

it("round-trips nullable task seasons over real HTTP and atomically assigns one while closing", async () => {
  await liveLogin();
  const block = await blockLifecycleApi.create({ name: `Круглогодичный блок ${crypto.randomUUID()}` });
  const queue = await taskQueuesApi.create({ name: "Работа круглый год", key: "YR" + crypto.randomUUID().replaceAll("-", "").slice(0, 14).toUpperCase(),
    scope: { kind: "block", id: block.block_id }, is_private: false });
  expect(queue.task_creation?.available).toBe(true);
  let task = await tasksApi.create({ queue_id: queue.queue_id, title: "Задача без сезона", description: richText(), deadline_at: null, season_id: null, assignees: [] });
  expect(task.season_id).toBeNull();expect(task.capabilities).toContain("assign_season");
  await expect(tasksApi.changeStatus(task.task_id, { expected_revision: task.revision, status: "closed" }))
    .rejects.toMatchObject({ status: 409, code: "task_season_required" });
  expect((await tasksApi.get(task.task_id)).revision).toBe(task.revision);
  const season = (await seasonsApi.list()).items.find(s => s.state !== "closed") ?? await seasonsApi.create({
    title: "Учёт круглогодичной работы", type: "autumn_winter", starts_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  task = await tasksApi.changeStatus(task.task_id, { expected_revision: task.revision, status: "closed", season_id: season.season_id });
  expect(task.status).toBe("closed");expect(task.season_id).toBe(season.season_id);expect(task.revision).toBe(2);
  expect((await tasksApi.get(task.task_id)).season_id).toBe(season.season_id);
});
