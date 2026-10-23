// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { TaskPage } from "./TaskPages";

// FIX_PLAN 1.1: the reviewer's form sends each command exactly the body the server
// accepts (A-TSK-1), and a cancelled assignment stays without an evaluation (A-TSK-2).
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });

async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");
  if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Task decisions", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const result = await seasonsApi.command(planned.season_id, "open", {expected_revision: planned.revision});
  return "season" in result ? result.season : result;
}

/** A subevent task of the chair with one submitted assignment per participant. */
async function submittedTask(count: number) {
  const people = [];
  for (let i = 0; i < count; i++) people.push(await liveParticipant(`decision-${i}`));
  const season = await openSeason();
  const event = await eventsApi.create({season_id: season.season_id, title: "Решения по назначениям", description: richText("")});
  const sub = await eventsApi.createSubevent(event.event_id, {title: "Подмероприятие решений", description: richText("")});
  await eventsApi.organizers(sub.subevent_id, people.map(p => p.user_id), {expected_revision: sub.revision});
  const task = await tasksApi.create({season_id: season.season_id, scope: {kind: "subevent", id: sub.subevent_id}, title: "Задача для решений",
    description: richText("Сдать результат"), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(),
    assignees: people.map(p => ({user_id: p.user_id, hours: 2}))});
  for (const person of people) {
    await liveLogin(person.email);
    const own = task.assignments.find(a => a.assignee.user_id === person.user_id)!;
    await tasksApi.command(own.assignment_id, "submit", {expected_revision: own.revision, text: richText("Сдано")});
  }
  const session = await liveLogin();
  return {task: await tasksApi.get(task.task_id), session};
}
const card = (name: string) => page!.container.querySelector<HTMLElement>(`[aria-label="Назначение: ${name}"]`)!;
function decisionForm(name: string) {
  const summary = Array.from(card(name).querySelectorAll("summary")).find(s => s.textContent === "Решение руководителя");
  expect(summary, `decision form of ${name}`).toBeDefined();
  return summary!.parentElement!.querySelector("form")!;
}

it("1.1: the four decisions go through the form; acceptance needs no comment", async () => {
  const {task, session} = await submittedTask(4);
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, {path: `/tasks/${task.task_id}`, session});
  await waitForPage(page, () => task.assignments.every(a => !!card(a.assignee.display_name)));
  const decisions: [string, string][] = [["accept:1", ""], ["request-revision", "Добавьте фотографии"], ["not-complete:0", "Не успели к сроку"], ["cancel", "Задача больше не нужна"]];
  for (const [i, [decision, note]] of decisions.entries()) {
    const name = task.assignments[i].assignee.display_name;
    const form = decisionForm(name);
    await change(field(form, "decision") as HTMLSelectElement, decision);
    await change(field(form, "note"), note);
    await submit(form);
    await waitForPage(page, () => !!card(name).textContent?.includes(["Принята", "На доработке", "Не выполнена", "Отменена"][i]));
    expect(card(name).querySelector('[role="alert"]'), name).toBeNull();
  }
  const saved = await tasksApi.get(task.task_id);
  expect(saved.assignments.map(a => a.status)).toEqual(["accepted", "needs_revision", "not_completed", "cancelled"]);
  expect(saved.assignments.map(a => a.review_note)).toEqual([null, ...decisions.slice(1).map(([, note]) => note)]);
});

it("1.1: a cancelled assignment keeps its status when only the hours are corrected", async () => {
  const {task, session} = await submittedTask(1);
  let a = task.assignments[0];
  // Accepted, then sent back: the old cancel kept this evaluation and the panel re-sent it.
  a = await tasksApi.command(a.assignment_id, "accept", {expected_revision: a.revision, evaluation: 1});
  await tasksApi.command(a.assignment_id, "request-revision", {expected_revision: a.revision, review_note: "Переделать"});
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, {path: `/tasks/${task.task_id}`, session});
  const name = a.assignee.display_name;
  await waitForPage(page, () => !!card(name)?.textContent?.includes("На доработке"));
  const form = decisionForm(name);
  await change(field(form, "decision") as HTMLSelectElement, "cancel");
  await change(field(form, "note"), "Отменили после доработки");
  await submit(form);
  await waitForPage(page, () => !!card(name).textContent?.includes("Отменена") && !!card(name).querySelector('[name="hours"]'));
  const inputs = card(name).querySelector('[name="hours"]')!.closest("form")!;
  expect(inputs.querySelector('[name="evaluation"]')).toBeNull();
  await change(field(inputs, "hours"), "3");
  await change(field(inputs, "reason"), "Уточнили часы");
  // The cancellation advanced the revision this form was opened with (2.12 is step 6).
  const keep = Array.from(inputs.querySelectorAll("button")).find(b => b.textContent === "Сохранить мой ввод с обновлённой версией");
  if (keep) { await act(async () => keep.click()); await waitForPage(page); }
  await submit(inputs);
  await waitForPage(page, () => !!card(name).textContent?.includes("Часы: 3"));
  const saved = await tasksApi.get(task.task_id);
  expect(saved.assignments[0].status).toBe("cancelled");
  expect((await tasksApi.assessment(a.assignment_id)).evaluation).toBeNull();
});
