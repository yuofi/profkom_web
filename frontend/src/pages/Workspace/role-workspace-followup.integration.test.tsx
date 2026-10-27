// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { directoryApi } from "../../utils/api/directory.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText, type Task } from "../../utils/api/contract";
import { moscowInput } from "../../utils/dates";
import { SubeventPage } from "./EventPages";
import { TrackerListPage } from "./TrackerList";
import { TaskCreateForm } from "./TaskCreateForm";
import { TrackerTaskPage } from "./TrackerTaskDetail";
import { MeritForm } from "./MeritPages";
import { BlockPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
async function api<T>(command: () => Promise<T>) { let result!: T;await act(async () => { result = await command(); });return result; }
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label)!;
async function click(element: HTMLElement) { expect(element).toBeDefined();await act(async () => element.click());await waitForPage(page!); }
async function activeSeason() {
  await liveLogin();const rows = (await seasonsApi.list()).items;
  const current = rows.find(item => item.state === "open");if (current) return current;
  const planned = rows.find(item => item.state === "planned") ?? await seasonsApi.create({ title: "Ролевые сценарии рабочего пространства", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
  const opened = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });return "season" in opened ? opened.season : opened;
}

it("an event head selects a child team's organizer, records private KKR and creates completed work without a reason field", async () => {
  const head = await liveParticipant("descendant-head-ui"), responsible = await liveParticipant("descendant-responsible-ui"), organizer = await liveParticipant("descendant-organizer-ui");
  const season = await activeSeason();let event = await eventsApi.create({ season_id: season.season_id, title: "Мероприятие ролевого UI", description: richText("") });
  event = await eventsApi.leaders("events", event.event_id, [head.user_id], { expected_revision: event.revision }) as typeof event;
  let sub = await eventsApi.createSubevent(event.event_id, { title: "Команда ответственного", description: richText("") });
  sub = await eventsApi.leaders("subevents", sub.subevent_id, [responsible.user_id], { expected_revision: sub.revision }) as typeof sub;
  await eventsApi.organizers(sub.subevent_id, [organizer.user_id], { expected_revision: sub.revision });
  let session = await liveLogin(head.email);expect((await taskQueuesApi.catalog()).items.some(queue => queue.scope?.kind === "subevent" && queue.scope.id === sub.subevent_id)).toBe(false);expect(session.capabilities).not.toContain("view_kkr");
  page = await mountWorkspace(<Routes><Route path="/subevents/:id" element={<SubeventPage />} /><Route path="/tasks" element={<TrackerListPage />} /><Route path="/tasks/new" element={<TaskCreateForm scope={{ kind: "subevent", id: sub.subevent_id }} />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: `/subevents/${sub.subevent_id}`, session });await waitForPage(page);
  await click([...page.container.querySelectorAll<HTMLAnchorElement>("a")].find(item => item.textContent === "Задачи команды")!);
  await click([...page.container.querySelectorAll<HTMLAnchorElement>("a")].find(item => item.textContent === "Создать задачу")!);
  await pick(page.container, "users", String(organizer.user_id));await change(field(page.container, "title"), "Задача организатору через главорга");await change(field(page.container, "deadline"), moscowInput(new Date(Date.now() + 3600000).toISOString()));
  const createTask = vi.spyOn(tasksApi, "create");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toBeUndefined();expect(createTask).toHaveBeenCalledTimes(1);
  let task = await api<Task>(() => createTask.mock.results[0].value as ReturnType<typeof tasksApi.create>);expect(task.queue?.queue_id).toBeTruthy();expect(task.scope).toMatchObject({ kind: "subevent", id: sub.subevent_id });expect(task.assignees?.map(user => user.user_id)).toEqual([organizer.user_id]);
  await page.cleanup();page = undefined;await liveLogin(organizer.email);task = await tasksApi.get(task.task_id);await tasksApi.submitResult(task.task_id, { expected_revision: task.revision, text: richText("Выполненная работа организатора") });
  session = await liveLogin(head.email);task = await tasksApi.get(task.task_id);const publicStatus = task.status;
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
  const accounting = page.container.querySelector<HTMLElement>('section[aria-label^="ККР:"]')!, form = field(accounting, "hours").closest("form")!;
  await change(field(form, "hours"), "2");await change(field(form, "evaluation"), "1");await change(field(form, "reason"), "Решение руководителя по сданной работе");await submit(form);await waitForPage(page);
  const saved = await api(() => tasksApi.assessment(task.assignments[0].assignment_id));expect(saved.hours).toBe(2);expect(saved.workflow_status).toBe("accepted");expect((await api(() => tasksApi.get(task.task_id))).status).toBe(publicStatus);
  await page.cleanup();page = undefined;
  page = await mountWorkspace(<MeritForm seasonId={season.season_id} initialSource="head_merit" initialScopeId={event.event_id} />, { session });await waitForPage(page);
  expect(page.container.querySelector('[name="reason"]')).toBeNull();await pick(page.container, "users", String(organizer.user_id));
  const completed = new Date(Date.now() - 3600000).toISOString(), assigned = new Date(Date.now() - 7200000).toISOString();
  for (const [name, value] of Object.entries({ title: "Дополнительная выполненная работа", body: "Помощь на мероприятии", assigned: moscowInput(assigned), deadline: moscowInput(completed), [`hours_${organizer.user_id}`]: "1", [`evaluation_${organizer.user_id}`]: "1", [`completed_${organizer.user_id}`]: moscowInput(completed) })) await change(field(page.container, name), value);
  await submit(page.container.querySelector("form")!);await waitForPage(page);expect(page.container.querySelector('[role="alert"]')).toBeNull();
  const merit = (await api(() => seasonsApi.merits({ season_id: season.season_id }))).items.find(item => item.title === "Дополнительная выполненная работа")!;expect(merit.reason).toBe("Создание записи учёта работы");expect(merit.recipients[0].user_id).toBe(organizer.user_id);
});

it("assigns a scoped block HR from the page and exposes own-block accounting without membership or global KKR", async () => {
  const curator = await liveParticipant("block-hr-ui"), season = await activeSeason();
  let initial = (await membershipApi.blocks()).find(block => block.name === "Integration IT")!;const oldHr = initial.hr?.user_id ?? null;
  let temporaryMasterId: number | undefined;
  if (!initial.master) { const worker = await liveParticipant("block-hr-accounting-worker");temporaryMasterId = worker.user_id;await liveLogin();initial = await membershipApi.block(initial.block_id);await eventsApi.blockLeader(initial.block_id, worker.user_id, { expected_revision: initial.revision });initial = await membershipApi.block(initial.block_id); }
  expect(initial.members.some(member => member.user.user_id === curator.user_id)).toBe(false);
  try {
    const chairSession = await liveLogin();page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${initial.block_id}`, session: chairSession });await waitForPage(page);
    await click(button(page.container, "Изменить HR блока"));const dialog = document.querySelector<HTMLDialogElement>("dialog")!;await change(field(dialog, "user"), String(curator.user_id));await submit(dialog.querySelector("form")!);await waitForPage(page);
    let block = await api(() => membershipApi.block(initial.block_id));expect(block.hr?.user_id).toBe(curator.user_id);expect(block.members.some(member => member.user.user_id === curator.user_id)).toBe(false);
    await page.cleanup();page = undefined;
    const worker = block.master!.user.user_id!;
    const task = await tasksApi.create({ scope: { kind: "block", id: block.block_id }, season_id: season.season_id, title: "Учёт блока для его HR", description: richText("Работа команды"), deadline_at: new Date(Date.now() + 3600000).toISOString(), assignees: [{ user_id: worker, hours: 0 }] });
    const session = await liveLogin(curator.email);expect(session.capabilities).not.toContain("view_kkr");expect(session.capabilities).not.toContain("view_summary");expect(session.capabilities).not.toContain("view_block_requests");
    block = await membershipApi.block(initial.block_id);expect(block.capabilities).toEqual(expect.arrayContaining(["view_tasks", "view_assessment_inputs", "create_volunteer_merit"]));
    page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/blocks/${block.block_id}`, session });await waitForPage(page);
    expect([...page.container.querySelectorAll("a")].some(link => link.textContent === "Учесть волонтёрскую работу")).toBe(true);expect(button(page.container, "Подать заявку в блок")).toBeDefined();expect(button(page.container, "Изменить HR блока")).toBeUndefined();
    await page.cleanup();page = undefined;
    page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TrackerTaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });await waitForPage(page);
    const accounting = page.container.querySelector<HTMLElement>('section[aria-label^="ККР:"]')!, form = field(accounting, "hours").closest("form")!;
    await change(field(form, "hours"), "3");await change(field(form, "evaluation"), "0");await change(field(form, "reason"), "Учётное решение HR своего блока");await submit(form);await waitForPage(page);
    const inputs = await api(() => tasksApi.assessment(task.assignments[0].assignment_id));expect(inputs.hours).toBe(3);expect(inputs.workflow_status).toBe("not_completed");expect((await api(() => tasksApi.get(task.task_id))).status).toBe(task.status);
    await expect(api(() => seasonsApi.analytics(season.season_id))).rejects.toMatchObject({ status: 403 });
  } finally {
    await page?.cleanup();page = undefined;await liveLogin();const current = await membershipApi.block(initial.block_id);await membershipApi.assignHr(initial.block_id, { expected_revision: current.revision, user_id: oldHr });
    if (temporaryMasterId !== undefined) await directoryApi.archive(temporaryMasterId, "Завершение синтетической HTTP-проверки HR блока");
  }
});
