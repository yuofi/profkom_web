// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, change, field, pick, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { filesApi } from "../../utils/api/files.api";
import { api } from "../../utils/api/index";
import { emptyCriteria, richText, type AssessmentInputs } from "../../utils/api/contract";
import { TrackerTaskCreatePage } from "./TaskCreateForm";
import { TrackerTaskPage } from "./TrackerTaskDetail";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const accounting = (inputs: AssessmentInputs) => [inputs.revision, inputs.workflow_revision, inputs.workflow_status, inputs.hours, inputs.evaluation, inputs.effective_completed_at];
const taskActionsSettled = () => ![...page!.container.querySelectorAll<HTMLButtonElement>("button")].some(button => button.disabled && (button.matches('[aria-haspopup="menu"],[aria-label^="Убрать исполнителя:"]') || ["Стать исполнителем", "Наблюдать", "Перестать наблюдать", "Взять в работу", "Нужна помощь", "Сдать результат"].includes(button.textContent?.trim() ?? "")));
async function click(title: string, root: ParentNode = page!.container) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === title)!;expect(button).toBeDefined();await act(async () => button.click());await waitForPage(page!, taskActionsSettled);
}
async function chooseStatus(title: string) {
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label^="Статус задачи:"]')!.click());await waitForPage(page!);await click(title, page!.container.querySelector('[role="menu"]')!);
}
it("creates an unassigned independent task with real draft bytes, manages its public roster/status and preserves scoped accounting", async () => {
  const worker = await liveParticipant("usability-worker");await liveLogin();
  const seasons = (await seasonsApi.list()).items;let season = seasons.find(item => item.state === "open");
  if (!season) {
    const planned = seasons.find(item => item.state === "planned") ?? await seasonsApi.create({ title: "Usability", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    const opened = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });season = "season" in opened ? opened.season : opened;
  }
  const event = await eventsApi.create({ season_id: season.season_id, title: "Сохраняемый приватный учёт", description: richText() });
  let sub = await eventsApi.createSubevent(event.event_id, { title: "Команда приватного учёта", description: richText() });sub = await eventsApi.organizers(sub.subevent_id, [worker.user_id], { expected_revision: sub.revision });
  const scoped = await tasksApi.create({ season_id: season.season_id, scope: { kind: "subevent", id: sub.subevent_id }, title: "Учёт не зависит от статуса", description: richText("Публичная постановка"), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{ user_id: worker.user_id, hours: 2 }] });
  const assignment = scoped.assignments[0], before = accounting(await tasksApi.assessment(assignment.assignment_id));
  const session = await liveLogin(worker.email), key = `U${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 9).toUpperCase()}`;
  const queue = await taskQueuesApi.create({ name: "Независимые задачи", key, is_private: false });expect(queue.scope).toBeNull();expect(queue.owner?.user_id).toBe(worker.user_id);
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/new?queue_id=${queue.queue_id}`, session });await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!;expect(field(form, "title").value).toBe("");expect(field(form, "description").value).toBe("");expect(form.querySelector('[name="hours"]')).toBeNull();
  await change(field(form, "title"), "Свободная задача из полного редактора");await change(field(form, "description"), "- [ ] Проверить файл\n\n$E=mc^2$");await change(field(form, "deadline"), "2026-10-29T18:00");
  await pick(form, "watchers", String(worker.user_id));
  const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]')!, blob = new File(["Synthetic unassigned draft"], "unassigned-plan.txt", { type: "text/plain" });
  await act(async () => { Object.defineProperty(fileInput, "files", { configurable: true, value: [blob] });fileInput.dispatchEvent(new Event("change", { bubbles: true })); });
  await waitForPage(page, () => !!form.textContent?.includes("unassigned-plan.txt") && !form.textContent?.includes("Загрузка файла:"));expect(form.querySelector('[role="alert"]')).toBeNull();
  await submit(form);await waitForPage(page, () => !page!.container.querySelector('input[name="title"]'));
  const created = await create.mock.results[0].value;expect(create.mock.calls[0][0]).toMatchObject({ queue_id: queue.queue_id, assignees: [], watcher_user_ids: [worker.user_id] });expect(create.mock.calls[0][0]).not.toHaveProperty("scope");
  let task = await tasksApi.get(created.task_id);expect(task.scope).toEqual({ kind: "queue", id: queue.queue_id });expect(task.assignees).toEqual([]);expect(task.watchers?.map(person => person.user_id)).toEqual([worker.user_id]);expect(task.attachments).toHaveLength(1);
  const download = await filesApi.download(task.attachments![0].file_id);expect(download.download_url.startsWith("/api/")).toBe(true);expect((await api.get(download.download_url.slice(4), { responseType: "text" })).data).toBe("Synthetic unassigned draft");
  expect(page.container.textContent).not.toContain("Учёт работы и ККР");await expect(tasksApi.inputs(task.task_id)).rejects.toMatchObject({ status: 422 });
  await chooseStatus("Принята");task = await tasksApi.get(task.task_id);expect(task.status).toBe("accepted");expect(task.submissions).toEqual([]);
  await chooseStatus("Отменена");await chooseStatus("Открыта");expect((await tasksApi.get(task.task_id)).status).toBe("assigned");
  await click("Стать исполнителем");task = await tasksApi.get(task.task_id);expect(task.assignees?.map(person => person.user_id)).toEqual([worker.user_id]);expect(task.watchers).toEqual([]);
  const remove = page.container.querySelector<HTMLButtonElement>(`button[aria-label="Убрать исполнителя: ${task.assignees![0].display_name}"]`)!;await act(async () => remove.click());await waitForPage(page, taskActionsSettled);
  task = await tasksApi.get(task.task_id);expect(task.assignees).toEqual([]);expect(task.watchers?.map(person => person.user_id)).toEqual([worker.user_id]);
  await click("Перестать наблюдать");expect((await tasksApi.get(task.task_id)).watchers).toEqual([]);await click("Наблюдать");
  const history = (await tasksApi.history(task.task_id)).items;expect(history.some(item => item.changes?.some(change => change.field === "assignees"))).toBe(true);expect(history.some(item => item.changes?.some(change => change.field === "watchers"))).toBe(true);await expect(tasksApi.inputs(task.task_id)).rejects.toMatchObject({ status: 422 });
  await page.cleanup();page = undefined;
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${scoped.task_id}`, session });await waitForPage(page);
  await chooseStatus("Принята");const currentScoped = await tasksApi.get(scoped.task_id);expect(currentScoped.submissions).toEqual([]);
  await act(async () => page!.container.querySelector<HTMLButtonElement>(`button[aria-label="Убрать исполнителя: ${currentScoped.assignees![0].display_name}"]`)!.click());await waitForPage(page, taskActionsSettled);expect((await tasksApi.get(scoped.task_id)).assignees).toEqual([]);
  await click("Стать исполнителем");await page.cleanup();page = undefined;await liveLogin();
  expect(accounting(await tasksApi.assessment(assignment.assignment_id))).toEqual(before);
  const restored = await tasksApi.get(scoped.task_id);expect(restored.assignments.filter(item => item.assignee.user_id === worker.user_id)).toHaveLength(1);
});
