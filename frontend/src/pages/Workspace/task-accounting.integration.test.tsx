// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { liveLogin, liveParticipant, liveCloseSeasons, CLOSES_SEASONS_TIMEOUT } from "../../test/liveApi";
import { mountWorkspace, change, field, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { TrackerTaskPage } from "./TrackerTaskDetail";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
const card = (name: string) => page!.container.querySelector<HTMLElement>(`[aria-label="Назначение: ${name}"]`)!;
const state = (name: string) => card(name).querySelector<HTMLElement>("[data-accounting-state]")?.dataset.accountingState;
it("makes private KKR decisions explicit per assignee and versions a closed correction without changing the public task", async () => {
  const people = [];
  for (let index = 0;index < 3;index++) people.push(await liveParticipant(`kkr-state-${index}`));
  const session = await liveLogin();let season = (await seasonsApi.list()).items.find(item => item.state === "open");
  if (!season) {
    const planned = (await seasonsApi.list()).items.find(item => item.state === "planned") ?? await seasonsApi.create({ title: "Учёт задачи", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    const opened = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });season = "season" in opened ? opened.season : opened;
  }
  const event = await eventsApi.create({ season_id: season.season_id, title: "Явное оценивание ККР", description: richText() });
  let sub = await eventsApi.createSubevent(event.event_id, { title: "Команда учёта", description: richText() });sub = await eventsApi.organizers(sub.subevent_id, people.map(person => person.user_id), { expected_revision: sub.revision });
  let task = await tasksApi.create({ season_id: season.season_id, scope: { kind: "subevent", id: sub.subevent_id }, title: "Одна задача, отдельный ККР", description: richText("Сдать общий результат"), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: people.map((person, index) => ({ user_id: person.user_id, hours: index + 2 })) });
  await liveLogin(people[0].email);task = await tasksApi.submitResult(task.task_id, { expected_revision: task.revision, text: richText("Наблюдаемая фактическая сдача"), file_ids: [], links: [] });await liveLogin();
  task = await tasksApi.changeStatus(task.task_id, { expected_revision: task.revision, status: "accepted" });const publicBefore = await tasksApi.get(task.task_id);
  const [first, second, third] = task.assignments, unchangedSecond = await tasksApi.assessment(second.assignment_id);
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
  expect(page.container.querySelector('section[aria-label="Учёт работы и ККР"]')).not.toBeNull();expect(state(first.assignee.display_name)).toBe("assigned");
  const editor = (name: string) => field(card(name), "hours").closest("form")!;
  let form = editor(first.assignee.display_name);await change(field(form, "hours"), "5");await change(field(form, "evaluation"), "1");await change(field(form, "reason"), "Фактический результат принят для ККР");await submit(form);await waitForPage(page, () => state(first.assignee.display_name) === "accepted");
  const accepted = await tasksApi.assessment(first.assignment_id);expect(accepted.hours).toBe(5);expect(accepted.evaluation).toBe(1);expect(Date.parse(accepted.effective_completed_at!)).toBe(Date.parse(task.submissions![0].submitted_at));
  expect(field(form, "evaluation").value).toBe("");expect(await tasksApi.assessment(second.assignment_id)).toEqual(unchangedSecond);expect(await tasksApi.get(task.task_id)).toEqual(publicBefore);
  const revise = field(card(first.assignee.display_name), "decision").closest("form")!;await change(field(revise, "decision"), "request-revision");await change(field(revise, "reason"), "Уточнить подтверждение для ККР");await submit(revise);await waitForPage(page, () => state(first.assignee.display_name) === "needs_revision");
  form = editor(first.assignee.display_name);expect(field(form, "evaluation").value).toBe("");await change(field(form, "evaluation"), "1");await change(field(form, "reason"), "Подтверждение дополнено");await submit(form);await waitForPage(page, () => state(first.assignee.display_name) === "accepted");
  form = editor(second.assignee.display_name);await change(field(form, "evaluation"), "0");await change(field(form, "reason"), "Работа исполнителем не выполнена");await submit(form);await waitForPage(page, () => state(second.assignee.display_name) === "not_completed");
  const exclude = field(card(third.assignee.display_name), "decision").closest("form")!;await change(field(exclude, "decision"), "cancel");await change(field(exclude, "reason"), "Дублирующее назначение исключено");await submit(exclude);await waitForPage(page, () => state(third.assignee.display_name) === "cancelled");
  expect(card(third.assignee.display_name).querySelector('[name="evaluation"]')).toBeNull();expect(await tasksApi.get(task.task_id)).toEqual(publicBefore);
  await page.cleanup();page = undefined;await liveCloseSeasons();const closedSummary = await seasonsApi.summary(season.season_id), closedPublic = await tasksApi.get(task.task_id);
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session: await liveLogin() });await waitForPage(page);
  expect(card(first.assignee.display_name).textContent).toContain("Сезон закрыт");form = editor(first.assignee.display_name);await change(field(form, "hours"), "6");await change(field(form, "reason"), "Исправление подтверждённых часов после закрытия");await submit(form);await waitForPage(page, () => card(first.assignee.display_name).querySelector("[data-accounting-hours]")?.textContent === "6");
  const corrected = await tasksApi.assessment(first.assignment_id);expect(corrected.workflow_status).toBe("accepted");expect(corrected.evaluation).toBe(1);expect(corrected.hours).toBe(6);expect((await seasonsApi.summary(season.season_id)).version).toBeGreaterThan(closedSummary.version);expect(await tasksApi.get(task.task_id)).toEqual(closedPublic);
  await page.cleanup();page = undefined;const workerSession = await liveLogin(people[0].email);page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session: workerSession });await waitForPage(page);expect(page.container.querySelector('section[aria-label="Учёт работы и ККР"]')).toBeNull();await expect(tasksApi.assessment(first.assignment_id)).rejects.toMatchObject({ status: 403 });
  // No private decision leaks through public task history.
  expect((await tasksApi.history(task.task_id)).items.flatMap(item => item.changes ?? []).some(change => ["hours", "evaluation", "workflow_status"].includes(change.field))).toBe(false);
}, CLOSES_SEASONS_TIMEOUT);
