// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { emptyCriteria, richText, type AssignmentStatus, type Task } from "../../utils/api/contract";
import { TaskPage } from "./TaskPages";
import { statusNames } from "./trackerStatus";

// A joint task has one decision for the whole work. Individual hours/evaluations remain separate.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({ title: "Task decisions", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
  const result = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });return "season" in result ? result.season : result;
}
async function submittedTasks(peopleCount: number, taskCount = 1) {
  const people = [];
  for (let i = 0;i < peopleCount;i++) people.push(await liveParticipant(`decision-${i}`));
  const season = await openSeason();
  const event = await eventsApi.create({ season_id: season.season_id, title: "Решения по задачам", description: richText() });
  const sub = await eventsApi.createSubevent(event.event_id, { title: "Команда решений", description: richText() });
  await eventsApi.organizers(sub.subevent_id, people.map(p => p.user_id), { expected_revision: sub.revision });
  const tasks: Task[] = [];
  for (let i = 0;i < taskCount;i++) tasks.push(await tasksApi.create({ season_id: season.season_id, scope: { kind: "subevent", id: sub.subevent_id }, title: `Задача для решения ${i}`, description: richText("Сдать общий результат"), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: people.map((person, index) => ({ user_id: person.user_id, hours: index + 2 })) }));
  await liveLogin(people[0].email);
  for (const task of tasks) await tasksApi.submitResult(task.task_id, { expected_revision: task.revision, text: richText("Одна общая сдача"), links: [], file_ids: [] });
  const session = await liveLogin();return { tasks: await Promise.all(tasks.map(task => tasksApi.get(task.task_id))), session };
}
const card = (name: string) => page!.container.querySelector<HTMLElement>(`[aria-label="Назначение: ${name}"]`)!;
const taskActionsSettled = () => ![...page!.container.querySelectorAll<HTMLButtonElement>("button")].some(button => button.disabled && (button.matches('[aria-haspopup="menu"],[aria-label^="Убрать исполнителя:"]') || ["Стать исполнителем", "Наблюдать", "Перестать наблюдать", "Взять в работу", "Нужна помощь", "Сдать результат"].includes(button.textContent?.trim() ?? "")));
async function click(label: string) {
  const button = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;
  expect(button, label).toBeDefined();await act(async () => button.click());await waitForPage(page!, taskActionsSettled);
}

async function choosePublic(status: AssignmentStatus) {
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await waitForPage(page!);await click(statusNames[status]);
}
it("1.1: public decisions change the joint task without changing private hours, evaluations or dates", async () => {
  const { tasks, session } = await submittedTasks(2, 4);
  const decisions: AssignmentStatus[] = ["accepted", "needs_revision", "not_completed", "cancelled"];
  for (const [index, status] of decisions.entries()) {
    const task = tasks[index], before = await Promise.all(task.assignments.map(assignment => tasksApi.assessment(assignment.assignment_id)));
    page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);await choosePublic(status);
    expect(page.container.querySelector("dialog")).toBeNull();expect(page.container.querySelector('[role="alert"]')).toBeNull();
    const saved = await tasksApi.get(task.task_id);expect(saved.status).toBe(status);expect(saved.assignments.map(assignment => assignment.status)).toEqual([status, status]);
    const after = await Promise.all(saved.assignments.map(assignment => tasksApi.assessment(assignment.assignment_id)));
    expect(after.map(input => [input.hours, input.evaluation, input.effective_completed_at, input.workflow_status, input.workflow_revision])).toEqual(before.map(input => [input.hours, input.evaluation, input.effective_completed_at, input.workflow_status, input.workflow_revision]));
    expect(after.map(input => input.hours)).toEqual([2, 3]);await page.cleanup();page = undefined;
  }
});
it("1.1: a public cancellation preserves formal acceptance while authorized private hours remain editable", async () => {
  const { tasks: [task], session } = await submittedTasks(1), assignment = task.assignments[0];
  const initial = await tasksApi.assessment(assignment.assignment_id);await tasksApi.updateAssessment(assignment.assignment_id, { expected_revision: initial.revision, evaluation: 1, reason: "Явная формальная приёмка" });
  const accepted = await tasksApi.assessment(assignment.assignment_id);expect(accepted.workflow_status).toBe("accepted");expect(accepted.evaluation).toBe(1);
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);await choosePublic("cancelled");
  const inputs = card(assignment.assignee.display_name).querySelector('[name="hours"]')!.closest("form")!;expect(inputs.querySelector('[name="evaluation"]')).not.toBeNull();
  await change(field(inputs, "hours"), "3");await change(field(inputs, "reason"), "Уточнили часы");await submit(inputs);await waitForPage(page, () => card(assignment.assignee.display_name).querySelector("[data-accounting-hours]")?.textContent === "3");
  expect((await tasksApi.get(task.task_id)).status).toBe("cancelled");const saved = await tasksApi.assessment(assignment.assignment_id);expect(saved.hours).toBe(3);expect(saved.evaluation).toBe(1);expect(saved.workflow_status).toBe("accepted");expect(saved.effective_completed_at).toBe(accepted.effective_completed_at);
});

async function feedbackTasks() {
  const worker = await liveParticipant("feedback-worker");
  const season = await openSeason(), chair = await liveLogin();
  const event = await eventsApi.create({ season_id: season.season_id, title: "Проверка правок трекера", description: richText() });
  const sub = await eventsApi.createSubevent(event.event_id, { title: "Команда правок", description: richText() });
  await eventsApi.organizers(sub.subevent_id, [worker.user_id], { expected_revision: sub.revision });
  const scope = { kind: "subevent" as const, id: sub.subevent_id };
  const create = (title: string, extra = {}) => tasksApi.create({ season_id: season.season_id, scope, title, description: richText("- [ ] Проверить документы\n- [x] Подготовить встречу"), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{ user_id: worker.user_id, hours: 2 }], ...extra });
  const task = await create("Совместно редактируемая задача");
  const key = `P${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 9).toUpperCase()}`;
  const queue = await taskQueuesApi.create({ name: "Другая очередь правок", key, scope, owner_user_id: chair.user_id, is_private: false });
  const parent = await create("Родитель из другой очереди", { queue_id: queue.queue_id });
  return { task, parent, worker, chair };
}
it("feedback: an assignee saves checklist/description and edits a shared comment with real history attribution", async () => {
  const { task, worker } = await feedbackTasks();
  const comment = await tasksApi.comment(task.task_id, richText("Комментарий автора задачи"));
  const session = await liveLogin(worker.email);
  let current = await tasksApi.get(task.task_id);
  expect(current.capabilities).toContain("edit_task_description");expect(current.capabilities).not.toContain("edit_task");
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
  const checkbox = page.container.querySelector<HTMLInputElement>('section[aria-label="Описание задачи"] input[type="checkbox"]')!;
  expect(checkbox.disabled).toBe(false);await act(async () => checkbox.click());await waitForPage(page, () => !page!.container.textContent?.includes("Сохраняем отметку"));
  current = await tasksApi.get(task.task_id);expect(current.description.body).toBe("- [x] Проверить документы\n- [x] Подготовить встречу");
  await expect(tasksApi.update(task.task_id, { expected_revision: current.revision, title: "Запрещённая смена названия" })).rejects.toMatchObject({ status: 403 });
  expect((await tasksApi.get(task.task_id)).title).toBe(task.title);
  const description = page.container.querySelector('section[aria-label="Описание задачи"]')!;
  await act(async () => [...description.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Редактировать")!.click());await waitForPage(page);
  let form = page.container.querySelector<HTMLFormElement>("dialog form")!;expect(form.querySelector('[name="title"]')).toBeNull();
  await change(field(form, "body"), "- [x] Проверить документы\nДобавлен порядок проверки");await submit(form);await waitForPage(page, () => !!form.textContent?.includes("Изменения сохранены"));
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Закрыть окно"]')!.click());await waitForPage(page, () => !page!.container.querySelector("dialog"));
  const article = [...page.container.querySelectorAll("article")].find(node => node.textContent?.includes("Комментарий автора задачи"))!;
  await act(async () => [...article.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Редактировать")!.click());await waitForPage(page);
  form = article.querySelector("form")!;await change(field(form, "body"), "Общая правка исполнителя");await submit(form);await waitForPage(page, () => !article.querySelector("form"));
  const savedComment = (await tasksApi.comments(task.task_id)).items.find(item => item.comment_id === comment.comment_id)!;
  expect(savedComment.content.body).toBe("Общая правка исполнителя");expect(savedComment.author.user_id).toBe(comment.author.user_id);
  const history = (await tasksApi.history(task.task_id)).items;
  const edits = history.filter(item => item.actor?.user_id === worker.user_id && item.changes?.some(change => ["description", "comment"].includes(change.field)));
  expect(edits.length).toBeGreaterThanOrEqual(3);expect(edits.every(item => item.actor?.user_id === worker.user_id)).toBe(true);
  expect(edits.some(item => item.changes?.some(change => change.field === "description" && change.before === "- [ ] Проверить документы\n- [x] Подготовить встречу" && change.after === "- [x] Проверить документы\n- [x] Подготовить встречу"))).toBe(true);
  expect(history.flatMap(item => item.changes ?? []).every(change => !["hours", "evaluation", "reason"].includes(change.field))).toBe(true);
});
it("feedback: a leader links a cross-queue parent in the UI and sees its genuine breadcrumb/diff", async () => {
  const { task, parent, chair } = await feedbackTasks();expect(parent.queue?.queue_id).not.toBe(task.queue?.queue_id);
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session: chair });await waitForPage(page);
  await click("Изменить родительскую задачу");const form = page.container.querySelector<HTMLFormElement>("dialog form")!;
  await change(form.querySelector<HTMLInputElement>('[role="combobox"]')!, parent.task_key!);await waitForPage(page, () => !![...form.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes(parent.task_key!)));await act(async () => [...form.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes(parent.task_key!))!.click());await submit(form);await waitForPage(page, () => !!form.textContent?.includes("Изменения сохранены"));
  let saved = await tasksApi.get(task.task_id);expect(saved.parent_task?.task_id).toBe(parent.task_id);
  const trail = page.container.querySelector('[aria-label="Путь задачи"]')!;expect(trail.querySelector(`a[href="/tasks/queues/${task.queue!.queue_id}"]`)).not.toBeNull();expect(trail.querySelector(`a[href="/tasks/${parent.task_id}"]`)?.textContent).toContain(parent.title);
  await expect(tasksApi.update(parent.task_id, { expected_revision: parent.revision, parent_task_id: task.task_id })).rejects.toMatchObject({ status: 422 });
  const history = (await tasksApi.history(task.task_id)).items;
  const linked = history.find(item => item.changes?.some(change => change.field === "parent_task_id"));expect(linked?.actor?.user_id).toBe(chair.user_id);expect(linked?.changes?.find(change => change.field === "parent_task_id")?.after).toContain(parent.task_key);
  saved = await tasksApi.update(task.task_id, { expected_revision: saved.revision, parent_task_id: null });expect(saved.parent_task).toBeNull();
});
