// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
async function api<T>(command: () => Promise<T>) { let result!: T;await act(async () => { result = await command(); });return result; }
const key = () => `QUICK${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 10).toUpperCase()}`;
async function seed() {
  const owner = await liveParticipant("quick-owner"), reader = await liveParticipant("quick-reader");
  await liveLogin();const seasons = (await seasonsApi.list()).items;
  const season = seasons.find(item => ["open", "planned"].includes(item.state)) ?? await seasonsApi.create({ title: "Quick controls", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
  await liveLogin(owner.email);const queue = await taskQueuesApi.create({ name: "Синтетическая очередь быстрых действий", key: key(), is_private: false });
  const task = await tasksApi.create({ queue_id: queue.queue_id, season_id: season.season_id, title: "Классификация и отметки читателем", description: richText("Публичная совместная работа"), deadline_at: new Date(Date.parse(season.ends_at) - 3600000).toISOString(), starts_at: new Date(Date.parse(season.ends_at) - 86400000).toISOString(), priority: "normal", task_type: "task", assignees: [], checklist: [{ text: "Первый пункт", checked: false }, { text: "Второй пункт", checked: false }] });
  return { owner, reader, queue, task };
}
async function choose(trigger: string, menuName: string, optionText: string) {
  const button = page!.container.querySelector<HTMLButtonElement>(`button[aria-label="${trigger}"]`);expect(button).not.toBeNull();
  await act(async () => button!.click());await waitForPage(page!, () => !!document.querySelector(`[role="menu"][aria-label="${menuName}"]`));
  const menu = document.querySelector(`[role="menu"][aria-label="${menuName}"]`)!, option = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(item => item.textContent?.trim() === optionText);expect(option).toBeDefined();
  await act(async () => option!.click());await waitForPage(page!, () => !document.querySelector(`[role="menu"][aria-label="${menuName}"]`));
}
it("lets a non-author unassigned reader use the real type/priority menus and checklist toggle over HTTP", async () => {
  const { reader, task } = await seed(), session = await liveLogin(reader.email);
  const initial = await tasksApi.get(task.task_id);expect(initial.assignees).toEqual([]);expect(initial.created_by?.user_id).not.toBe(reader.user_id);
  expect(initial.capabilities).toEqual(expect.arrayContaining(["change_task_type", "change_task_priority", "toggle_task_checklist"]));expect(initial.capabilities).not.toContain("edit_task_metadata");expect(initial.capabilities).not.toContain("edit_task_checklist");
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
  await choose("Приоритет: Средний", "Выбор: приоритет", "Срочный");let saved = await api(() => tasksApi.get(task.task_id));expect(saved.priority).toBe("urgent");expect(saved.revision).toBe(initial.revision + 1);
  await choose("Тип задачи: Задача", "Выбор: тип задачи", "Веха");saved = await api(() => tasksApi.get(task.task_id));expect(saved.task_type).toBe("milestone");expect(saved.starts_at).toBeNull();expect(saved.revision).toBe(initial.revision + 2);
  const checkbox = page.container.querySelector<HTMLInputElement>('section[aria-label="Чеклист задачи"] input[type="checkbox"]');expect(checkbox).not.toBeNull();await act(async () => checkbox!.click());await waitForPage(page);saved = await api(() => tasksApi.get(task.task_id));expect(saved.checklist![0]).toMatchObject({ item_id: initial.checklist![0].item_id, text: "Первый пункт", checked: true });expect(saved.checklist![1]).toMatchObject({ text: "Второй пункт", checked: false });expect(saved.revision).toBe(initial.revision + 3);
  expect(saved.status).toBe(initial.status);expect(saved.assignees).toEqual([]);
  const revision = saved.revision, historyBefore = await api(() => tasksApi.history(task.task_id));
  const replay = await api(() => tasksApi.toggleChecklist(task.task_id, saved.checklist![0].item_id, { expected_revision: revision, checked: true }));expect(replay.revision).toBe(revision);expect(await api(() => tasksApi.history(task.task_id))).toEqual(historyBefore);
  await expect(api(() => tasksApi.toggleChecklist(task.task_id, saved.checklist![0].item_id, { expected_revision: initial.revision, checked: true }))).rejects.toMatchObject({ status: 409 });
  await expect(api(() => tasksApi.update(task.task_id, { expected_revision: revision, priority: "low", starts_at: null }))).rejects.toMatchObject({ status: 403 });
  await expect(api(() => tasksApi.update(task.task_id, { expected_revision: revision, task_type: "task", checklist: [{ item_id: saved.checklist![0].item_id, text: "Подмена", checked: false }] }))).rejects.toMatchObject({ status: 403 });
  expect((await api(() => tasksApi.get(task.task_id))).revision).toBe(revision);expect((await api(() => tasksApi.get(task.task_id))).priority).toBe("urgent");
  await expect(api(() => tasksApi.inputs(task.task_id))).rejects.toMatchObject({ status: 422 });
  const events = historyBefore.items.flatMap(event => event.changes ?? []);expect(events.some(change => change.field === "task_type")).toBe(true);expect(events.some(change => change.field === "starts_at" && change.after === null)).toBe(true);expect(events.some(change => change.field === "checklist")).toBe(true);expect(events.some(change => ["hours", "evaluation", "effective_completed_at"].includes(change.field))).toBe(false);
});
it("rejects quick actions after queue access is revoked, without changing task or checklist", async () => {
  const { owner, reader, queue, task } = await seed();await liveLogin(reader.email);const known = await tasksApi.get(task.task_id);expect(known.capabilities).toContain("toggle_task_checklist");
  await liveLogin(owner.email);await taskQueuesApi.update(queue.queue_id, { expected_revision: queue.revision!, is_private: true });await liveLogin(reader.email);
  await expect(tasksApi.get(task.task_id)).rejects.toMatchObject({ status: 404 });
  await expect(tasksApi.update(task.task_id, { expected_revision: known.revision, priority: "urgent" })).rejects.toMatchObject({ status: 404 });
  await expect(tasksApi.toggleChecklist(task.task_id, known.checklist![0].item_id, { expected_revision: known.revision, checked: true })).rejects.toMatchObject({ status: 404 });
  await liveLogin(owner.email);const saved = await tasksApi.get(task.task_id);expect(saved.revision).toBe(known.revision);expect(saved.priority).toBe("normal");expect(saved.checklist).toEqual(known.checklist);
});
