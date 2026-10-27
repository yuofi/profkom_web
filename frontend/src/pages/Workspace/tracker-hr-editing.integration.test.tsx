// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { directoryApi } from "../../utils/api/directory.api";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
async function api<T>(command: () => Promise<T>) { let result!: T;await act(async () => { result = await command(); });return result; }
it("lets the actual HR master edit a foreign private-queue task and its Markdown checklist through the real page", async () => {
  const actor = await liveParticipant("hr-public-editor");await liveLogin();
  const block = (await membershipApi.blocks()).find(item => item.is_hr)!;expect(block).toBeDefined();
  const oldMaster = block.master?.user.user_id;
  await eventsApi.blockLeader(block.block_id, actor.user_id, { expected_revision: block.revision });
  try {
    const season = (await seasonsApi.list()).items.find(item => ["open", "planned"].includes(item.state)) ?? await seasonsApi.create({ title: "HR tracker editing", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    const queue = await taskQueuesApi.create({ name: "Foreign private queue", key: "HRTEST" + crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 10).toUpperCase(), is_private: true });
    let task = await tasksApi.create({ queue_id: queue.queue_id, season_id: season.season_id, title: "Задача другого автора", description: richText("- [ ] Проверить доступ\n- [x] Сохранённый пункт"), deadline_at: new Date(Date.parse(season.ends_at) - 3600000).toISOString(), assignees: [] });
    const session = await liveLogin(actor.email);task = await tasksApi.get(task.task_id);
    expect(task.capabilities).toContain("edit_task");expect(task.capabilities).toContain("edit_task_description");expect(task.created_by?.user_id).not.toBe(actor.user_id);expect(task.assignees).toEqual([]);
    page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
    const checkbox = page.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')!;expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());await waitForPage(page);task = await api(() => tasksApi.get(task.task_id));expect(task.description.body).toContain("- [x] Проверить доступ");
    const edit = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Редактировать")!;await act(async () => edit.click());await waitForPage(page);
    const dialog = page.container.querySelector<HTMLDialogElement>("dialog")!;await change(dialog.querySelector<HTMLInputElement>('input[name="title"]')!, "Изменено мастером HR");await submit(dialog.querySelector("form")!);await waitForPage(page);
    const saved = await api(() => tasksApi.get(task.task_id));expect(saved.title).toBe("Изменено мастером HR");expect(saved.assignees).toEqual([]);expect(saved.status).toBe(task.status);
    const history = (await api(() => tasksApi.history(task.task_id))).items;expect(history.some(event => event.actor?.user_id === actor.user_id && event.changes?.some(item => item.field === "description"))).toBe(true);expect(history.flatMap(event => event.changes ?? []).some(item => item.field === "title")).toBe(true);
  } finally {
    await page?.cleanup();page = undefined;await liveLogin();
    if (oldMaster) { const current = await membershipApi.block(block.block_id);await eventsApi.blockLeader(block.block_id, oldMaster, { expected_revision: current.revision }); }
    else await directoryApi.archive(actor.user_id, "Завершение синтетической HTTP-проверки HR");
  }
});
