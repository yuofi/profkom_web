// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { takeTask } from "../../test/taskResults";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { eventsApi } from "../../utils/api/events.api";
import { richText } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
it("the real task page offers no «Взять в работу»; the kept HTTP TAKE still joins atomically without implicit status joins", async () => {
  const worker = await liveParticipant("atomic-take");await liveLogin();
  const seasons = (await seasonsApi.list()).items, season = seasons.find(item => ["open", "planned"].includes(item.state)) ?? await seasonsApi.create({ title: "Atomic take", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
  const event=await eventsApi.create({season_id:season.season_id,title:"TAKE source",description:richText()});
  await eventsApi.leaders("events",event.event_id,[worker.user_id],{expected_revision:event.revision});
  const session = await liveLogin(worker.email), queue = await taskQueuesApi.create({ scope:{kind:"event",id:event.event_id}, name: "Синтетическая очередь TAKE", key: `TAKE${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 9).toUpperCase()}`, is_private: false });
  let task = await tasksApi.create({ queue_id: queue.queue_id, season_id: season.season_id, title: "Атомарное начало совместной работы", description: richText("Рабочий статус не начисляет ККР"), deadline_at: new Date(Date.parse(season.ends_at) - 3600000).toISOString(), assignees: [], watcher_user_ids: [worker.user_id] });
  task = await tasksApi.changeStatus(task.task_id, { expected_revision: task.revision, status: "in_progress" });expect(task.assignees).toEqual([]);expect(task.watchers?.map(person => person.user_id)).toEqual([worker.user_id]);expect(task.capabilities).toContain("take_task");
  const previousRevision = task.revision;
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
  // The action is gone everywhere (owner 2026-11-08, В6); joining stays «Стать исполнителем», the status stays the chip.
  const buttons = () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].map(item => item.textContent?.trim());
  expect(buttons()).not.toContain("Взять в работу");expect(buttons()).not.toContain("Сдать результат");expect(buttons()).toContain("Стать исполнителем");
  expect(page.container.querySelector('[aria-label^="Статус задачи:"]')).not.toBeNull();
  task = await takeTask(task.task_id, { expected_revision: previousRevision });expect(task.revision).toBe(previousRevision + 1);expect(task.status).toBe("in_progress");expect(task.assignees?.map(person => person.user_id)).toEqual([worker.user_id]);expect(task.watchers).toEqual([]);
  expect((await takeTask(task.task_id, { expected_revision: task.revision })).revision).toBe(task.revision);await expect(takeTask(task.task_id, { expected_revision: previousRevision })).rejects.toMatchObject({ status: 409 });expect((await tasksApi.get(task.task_id)).assignees).toHaveLength(1);
  expect((await tasksApi.inputs(task.task_id)).task_id).toBe(task.task_id);
  const events = (await tasksApi.history(task.task_id)).items;expect(events.some(event => event.changes?.some(change => change.field === "assignees"))).toBe(true);
});
