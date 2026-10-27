// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
it("takes an already running unassigned task through HTTP and the real detail action without implicit status joins", async () => {
  const worker = await liveParticipant("atomic-take");await liveLogin();
  const seasons = (await seasonsApi.list()).items, season = seasons.find(item => ["open", "planned"].includes(item.state)) ?? await seasonsApi.create({ title: "Atomic take", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
  const session = await liveLogin(worker.email), queue = await taskQueuesApi.create({ name: "Синтетическая очередь TAKE", key: `TAKE${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 9).toUpperCase()}`, is_private: false });
  let task = await tasksApi.create({ queue_id: queue.queue_id, season_id: season.season_id, title: "Атомарное начало совместной работы", description: richText("Рабочий статус не начисляет ККР"), deadline_at: new Date(Date.parse(season.ends_at) - 3600000).toISOString(), assignees: [], watcher_user_ids: [worker.user_id] });
  task = await tasksApi.changeStatus(task.task_id, { expected_revision: task.revision, status: "in_progress" });expect(task.assignees).toEqual([]);expect(task.watchers?.map(person => person.user_id)).toEqual([worker.user_id]);expect(task.capabilities).toContain("take_task");
  const previousRevision = task.revision, take = vi.spyOn(tasksApi, "take");
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
  const header = page.container.querySelector("header")!;expect(header.querySelector('[aria-label^="Статус задачи:"]')).toBeNull();
  const button = [...header.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Взять в работу")!;expect(button).toBeDefined();await act(async () => button.click());await waitForPage(page, () => ![...page!.container.querySelectorAll("button")].some(item => item.textContent === "Взять в работу"));
  expect(take).toHaveBeenCalledExactlyOnceWith(task.task_id, { expected_revision: previousRevision });task = await tasksApi.get(task.task_id);expect(task.revision).toBe(previousRevision + 1);expect(task.status).toBe("in_progress");expect(task.assignees?.map(person => person.user_id)).toEqual([worker.user_id]);expect(task.watchers).toEqual([]);
  expect((await tasksApi.take(task.task_id, { expected_revision: task.revision })).revision).toBe(task.revision);await expect(tasksApi.take(task.task_id, { expected_revision: previousRevision })).rejects.toMatchObject({ status: 409 });expect((await tasksApi.get(task.task_id)).assignees).toHaveLength(1);
  await expect(tasksApi.inputs(task.task_id)).rejects.toMatchObject({ status: 422 });
  const events = (await tasksApi.history(task.task_id)).items;expect(events.some(event => event.changes?.some(change => change.field === "assignees"))).toBe(true);
});
