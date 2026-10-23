// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import axios from "axios";
import Cookies from "js-cookie";
import { api } from "../../utils/api";
import { liveLogin, liveParticipant, livePassword } from "../../test/liveApi";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { authApi } from "../../utils/api/auth.api";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { sessionApi } from "../../utils/api/session.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { emptyCriteria, richText, type Session } from "../../utils/api/contract";
import { accessFingerprint } from "../../utils/session";
import { UserProvider } from "../../utils/ctx";
import { TaskPage } from "./TaskPages";
import { BlockPage } from "./MembershipPages";
import { EventPage, SubeventPage } from "./EventPages";
import { SummaryPage } from "./SeasonPages";
import { AccountStatePage, LeadershipPage } from "./SessionPages";

// FIX_PLAN 2.12 against the live local API: forms keep their input through access
// rereads (A-FE-1), forms of one record follow each other's saves (A-FE-2), conflicts
// offer a refresh (A-TSK-5, A-TSK-12), creating forms start empty (A-TSK-6), removals
// are confirmed (A-ROL-13); decision 32 and УВ-5 on the task page.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });
const until = (predicate: () => boolean) => waitForPage(page!, predicate);
const forms = () => Array.from(page!.container.querySelectorAll("form"));
const form = (label: string) => forms().find(f => f.querySelector('button[type="submit"]')?.textContent === label)!;
const inDetails = (summary: string) => Array.from(page!.container.querySelectorAll("details")).find(d => d.querySelector("summary")?.textContent === summary);
const session = () => page!.client.getQueryData<Session>(["session"])!;
async function click(container: ParentNode, label: string) {
  const b = Array.from(container.querySelectorAll("button")).find(b => b.textContent === label);
  expect(b, label).toBeDefined(); await act(async () => b!.click()); await waitForPage(page!);
}
async function save(editor: HTMLFormElement) {
  await submit(editor);
  await until(() => !!editor.textContent?.includes("Изменения сохранены") && !(editor.querySelector('button[type="submit"]') as HTMLButtonElement).disabled);
}
async function mount(path: string, route: string, element: ReactNode, live = false) {
  const routes = <Routes><Route path={route} element={element} /></Routes>;
  page = live ? await mountWorkspace(<UserProvider>{routes}</UserProvider>, { path }) : await mountWorkspace(routes, { path, session: await sessionApi.get() });
}
async function actorClient(email: string) {
  const baseURL = api.defaults.baseURL!;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL).hostname);
  const login = await axios.post(`${baseURL}/auth/login`, { email, password: livePassword });
  return axios.create({ baseURL, headers: { Authorization: `Bearer ${login.data.access_token}` } });
}
async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");
  if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Forms", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const result = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });
  return "season" in result ? result.season : result;
}
/** A subevent of the chair whose organizers are the assignees of one task; the chair stays signed in. */
async function subeventTask(people: { user_id: number }[], title: string) {
  const season = await openSeason();
  const event = await eventsApi.create({ season_id: season.season_id, title: `Мероприятие: ${title}`, description: richText("") });
  const sub = await eventsApi.createSubevent(event.event_id, { title: `Команда: ${title}`, description: richText("") });
  await eventsApi.organizers(sub.subevent_id, people.map(p => p.user_id), { expected_revision: sub.revision });
  const task = await tasksApi.create({ season_id: season.season_id, scope: { kind: "subevent", id: sub.subevent_id }, title,
    description: richText(`ТЕКСТ: ${title}`), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(),
    assignees: people.map(p => ({ user_id: p.user_id, hours: 2 })) });
  return { season, event, sub, task };
}
const taskPage = (id: string, live = false) => mount(`/tasks/${id}`, "/tasks/:id", <TaskPage />, live);
const pdf = (name: string) => new File([new TextEncoder().encode("%PDF-1.7 synthetic result\n")], name, { type: "application/pdf" });

it("2.12 A-FE-1: a comment draft survives a grant elsewhere; a removal still hides the task", async () => {
  const org = await liveParticipant("fe1-org");
  const { event, sub, task } = await subeventTask([org], "Задача с черновиком комментария");
  const quest = await eventsApi.createSubevent(event.event_id, { title: "Квест", description: richText("") });
  const chair = await actorClient("chair@example.com");
  await liveLogin(org.email);
  await taskPage(task.task_id, true);
  await until(() => !!page!.container.textContent?.includes(`ТЕКСТ: ${task.title}`));
  const box = field(form("Добавить комментарий"), "body");
  await change(box, "МОЙ НЕОТПРАВЛЕННЫЙ КОММЕНТАРИЙ");
  const before = session().access_revision;
  await chair.put(`/subevents/${quest.subevent_id}/organizers`, { expected_revision: quest.revision, user_ids: [org.user_id] });
  await act(async () => { await page!.client.refetchQueries({ queryKey: ["session"] }); });
  await until(() => session().access_revision !== before);
  expect(field(form("Добавить комментарий"), "body")).toBe(box);
  expect(box.value).toBe("МОЙ НЕОТПРАВЛЕННЫЙ КОММЕНТАРИЙ");
  expect(page!.container.textContent).toContain(`ТЕКСТ: ${task.title}`);
  // Losing the task's scope still removes what it showed.
  const own = (await chair.get(`/subevents/${sub.subevent_id}`)).data;
  await chair.put(`/subevents/${sub.subevent_id}/organizers`, { expected_revision: own.revision, user_ids: [] });
  await act(async () => { await page!.client.refetchQueries({ queryKey: ["session"] }); });
  await until(() => !page!.container.textContent?.includes(`ТЕКСТ: ${task.title}`) && !!page!.container.querySelector('[role="alert"]'));
  expect(page!.container.querySelector("form")).toBeNull();
});

it("2.12 A-FE-1, A-FE-2: the chair's block description draft survives making themself its master", async () => {
  const other = await liveParticipant("fe1-master");
  const chair = await liveLogin();
  let block = (await membershipApi.blocks()).find(b => b.name === "Integration IT")!;
  block = await eventsApi.blockLeader(block.block_id, other.user_id, { expected_revision: block.revision });
  await mount(`/blocks/${block.block_id}`, "/blocks/:id", <BlockPage />, true);
  await until(() => !!page!.container.querySelector('[name="url"]') && !!page!.container.querySelector(`[name="user"] option[value="${chair.user_id}"]`));
  const description = field(page!.container, "url").closest("form")!;
  await change(field(description, "body"), "ЧЕРНОВИК ОПИСАНИЯ БЛОКА");
  const fingerprint = accessFingerprint(session());
  const leader = field(page!.container, "user").closest("form")!;
  await change(field(leader, "user"), String(chair.user_id));
  await save(leader);
  await until(() => accessFingerprint(session()) !== fingerprint);
  expect(description.isConnected).toBe(true);
  expect(field(description, "body").value).toBe("ЧЕРНОВИК ОПИСАНИЯ БЛОКА");
  expect(description.textContent).not.toContain("Запись изменилась на сервере");
  await save(description);
  block = await membershipApi.block(block.block_id);
  expect(block.description.body).toBe("ЧЕРНОВИК ОПИСАНИЯ БЛОКА");
  expect(block.master?.user.user_id).toBe(chair.user_id);
});

it("2.12 A-FE-2: a subevent's organizers and then its description save without a conflict", async () => {
  const org = await liveParticipant("fe2-org");
  const season = await openSeason();
  const event = await eventsApi.create({ season_id: season.season_id, title: "Мероприятие соседних форм", description: richText("") });
  const sub = await eventsApi.createSubevent(event.event_id, { title: "Соседние формы", description: richText("") });
  await mount(`/subevents/${sub.subevent_id}`, "/subevents/:id", <SubeventPage />);
  const organizers = () => forms().find(f => f.querySelector("label")?.textContent?.startsWith("Организаторы"))!;
  const description = () => forms().find(f => (f.querySelector('[name="title"]') as HTMLInputElement | null)?.value === sub.title)!;
  await until(() => !!organizers()?.querySelector(`input[name="users"][value="${org.user_id}"]`) && !!description());
  await change(field(description(), "description"), "Новое описание команды");
  await pick(organizers(), "users", String(org.user_id));
  await save(organizers());
  expect(description().textContent).not.toContain("Запись изменилась на сервере");
  await save(description());
  const saved = await eventsApi.subevent(sub.subevent_id);
  expect(saved.organizer_user_ids).toEqual([org.user_id]);
  expect(saved.description.body).toBe("Новое описание команды");
});

it("2.12 A-FE-2: a returned registration saves its details and is resubmitted without a conflict", async () => {
  const email = `integration-resubmit-${crypto.randomUUID()}@example.com`;
  const registered = await authApi.register({ email, password: livePassword, surname: "Тестовый", name: "Повторная", patronymic: "",
    group_number: 301, tg: "@profkom_test", phone: "+79990000000", vk: "https://vk.com/id123", funding: "budget", residence: "Тест" });
  Cookies.set("access_token", registered.data.access_token);
  const user = await sessionApi.get();
  let application = await membershipApi.registration();
  await liveLogin();
  await membershipApi.registrationCommand(user.user_id, "reject", { expected_revision: application.revision, reason: "Уточните место проживания" });
  await liveLogin(email);
  await mount("/", "/", <AccountStatePage />);
  await until(() => !!form("Повторно отправить заявку"));
  expect(page!.container.textContent).toContain("Использовано отправок: 1 из 5");
  const details = form("Сохранить сведения");
  await change(field(details, "residence"), "Общежитие №2");
  await save(details);
  expect(form("Повторно отправить заявку").textContent).not.toContain("Запись изменилась на сервере");
  await submit(form("Повторно отправить заявку"));
  await until(() => !!page!.container.textContent?.includes("Использовано отправок: 2 из 5"));
  application = await membershipApi.registration();
  expect([application.status, application.attempts_used, application.attempt_limit]).toEqual(["pending", 2, 5]);
  expect(application.fields.residence).toBe("Общежитие №2");
});

it("2.12 A-FE-2: two rows of one summary save one after another without a conflict", async () => {
  const people = [await liveParticipant("summary-a"), await liveParticipant("summary-b")];
  const { season, task } = await subeventTask(people, "Задача для сводной");
  for (const person of people) {
    await liveLogin(person.email);
    const own = task.assignments.find(a => a.assignee.user_id === person.user_id)!;
    await tasksApi.command(own.assignment_id, "submit", { expected_revision: own.revision, text: richText("Сдано") });
  }
  await liveLogin();
  for (const a of (await tasksApi.get(task.task_id)).assignments)
    await tasksApi.command(a.assignment_id, "accept", { expected_revision: a.revision, evaluation: 1 });
  // Decisions are edited while the season is summarized; closed totals are corrected elsewhere.
  const current = (await seasonsApi.list()).items.find(s => s.season_id === season.season_id)!;
  await seasonsApi.command(season.season_id, "begin-summary", { expected_revision: current.revision });
  await mount(`/seasons/${season.season_id}/summary`, "/seasons/:id/summary", <SummaryPage />);
  const rows = () => forms().filter(f => f.querySelector('[name="decisions"]'));
  await until(() => rows().length >= 2);
  const [one, two] = rows();
  await pick(two, "decisions", "nice");
  await change(field(two, "reason"), "Вторая строка");
  await pick(one, "decisions", "nice");
  await change(field(one, "reason"), "Первая строка");
  const before = (await seasonsApi.summary(season.season_id)).version;
  await save(one);
  expect(two.textContent).not.toContain("Запись изменилась на сервере");
  await save(two);
  expect((await seasonsApi.summary(season.season_id)).version).toBe(before + 2);
});

it("2.12 A-TSK-5: a help request keeps its text through a conflict and is sent after consent", async () => {
  const org = await liveParticipant("help");
  const { task } = await subeventTask([org], "Задача с просьбой о помощи");
  const own = task.assignments[0];
  const second = await actorClient(org.email);
  await liveLogin(org.email);
  await taskPage(task.task_id);
  const help = () => inDetails("Попросить помощь")?.querySelector("form");
  await until(() => !!help());
  await change(field(help()!, "message"), "Не хватает доступа к папке");
  await second.post(`/assignments/${own.assignment_id}/start`, { expected_revision: own.revision });
  await submit(help()!);
  await until(() => !!help()?.textContent?.includes("Обновить данные"));
  await click(help()!, "Обновить данные");
  expect(field(help()!, "message").value).toBe("Не хватает доступа к папке");
  expect(help()!.querySelector('[role="status"] details')?.textContent).toContain("В работе");
  await click(help()!, "Сохранить мой ввод с обновлённой версией");
  await submit(help()!);
  await until(() => !help());
  expect((await tasksApi.get(task.task_id)).assignments[0].status).toBe("help_required");
  expect((await tasksApi.comments(task.task_id)).items.map(c => c.content.body)).toContain("Не хватает доступа к папке");
});

it("2.12 A-TSK-12: a submission replaced after a conflict leaves with no text and no files", async () => {
  const org = await liveParticipant("submit");
  const { task } = await subeventTask([org], "Задача со сдачей");
  const own = task.assignments[0];
  const second = await actorClient(org.email);
  await liveLogin(org.email);
  await taskPage(task.task_id);
  const draft = () => inDetails("Сдать результат");
  const result = () => draft()?.querySelector("form");
  await until(() => !!result());
  const input = draft()!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [pdf("result.pdf")] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await until(() => !!draft()?.textContent?.includes("result.pdf"));
  await change(field(result()!, "body"), "Мой результат");
  await second.post(`/assignments/${own.assignment_id}/start`, { expected_revision: own.revision });
  await submit(result()!);
  await until(() => !!result()?.textContent?.includes("Обновить данные"));
  await click(result()!, "Обновить данные");
  const compared = result()!.querySelector('[role="status"] details')!;
  expect(compared.querySelectorAll("dd").length).toBeGreaterThan(0);
  expect(compared.textContent).toContain("В работе");
  await click(result()!, "Заменить мой ввод сохранёнными значениями");
  expect(field(result()!, "body").value).toBe("");
  expect(draft()!.textContent).not.toContain("result.pdf");
  await change(field(result()!, "body"), "Результат без файла");
  await submit(result()!);
  await until(() => !result());
  const last = (await tasksApi.get(task.task_id)).assignments[0].submissions.at(-1)!;
  expect([last.text.body, last.files]).toEqual(["Результат без файла", []]);
});

it("2.12 EDITORS-05 (decision 32): hours changed by the lead do not stop the assignee's submission", async () => {
  const org = await liveParticipant("hours");
  const { task } = await subeventTask([org], "Задача с часами");
  const own = task.assignments[0];
  const chair = await actorClient("chair@example.com");
  await liveLogin(org.email);
  await taskPage(task.task_id);
  const result = () => inDetails("Сдать результат")?.querySelector("form");
  await until(() => !!result());
  await change(field(result()!, "body"), "Результат после смены часов");
  const inputs = (await chair.get(`/assignments/${own.assignment_id}/assessment-inputs`)).data;
  await chair.patch(`/assignments/${own.assignment_id}/assessment-inputs`, { expected_revision: inputs.revision, hours: 5, reason: "Больше работы" });
  await act(async () => { await page!.client.invalidateQueries(); });
  await waitForPage(page!);
  expect(result()!.textContent).not.toContain("Запись изменилась на сервере");
  await submit(result()!);
  await until(() => !result());
  expect((await tasksApi.get(task.task_id)).assignments[0].status).toBe("submitted");
  expect((await chair.get(`/assignments/${own.assignment_id}/assessment-inputs`)).data.hours).toBe(5);
});

it("2.12 A-TSK-6: a comment and a subevent are created once and leave an empty form", async () => {
  const org = await liveParticipant("comment");
  const { event, task } = await subeventTask([org], "Задача с комментарием");
  await taskPage(task.task_id);
  await until(() => !!form("Добавить комментарий"));
  await change(field(form("Добавить комментарий"), "body"), "Один комментарий");
  await save(form("Добавить комментарий"));
  expect(field(form("Добавить комментарий"), "body").value).toBe("");
  await submit(form("Добавить комментарий"));
  await waitForPage(page!);
  expect((await tasksApi.comments(task.task_id)).items.map(c => c.content.body)).toEqual(["Один комментарий"]);
  await page!.cleanup(); page = undefined;

  await mount(`/events/${event.event_id}`, "/events/:id", <EventPage />);
  const create = () => inDetails("Добавить подмероприятие")?.querySelector("form");
  await until(() => !!create());
  const before = (await eventsApi.subevents(event.event_id)).items.length;
  await change(field(create()!, "title"), "Новое подмероприятие");
  await save(create()!);
  expect(field(create()!, "title").value).toBe("");
  await submit(create()!);
  await waitForPage(page!);
  expect((await eventsApi.subevents(event.event_id)).items.length).toBe(before + 1);
});

it("2.12 A-ROL-13: the chair adds a second deputy by a click and confirms a removal", async () => {
  const a = await liveParticipant("deputy-a"), b = await liveParticipant("deputy-b");
  await liveLogin();
  const leadership = await sessionApi.leadership();
  await sessionApi.deputies([a.user_id], { expected_revision: leadership.revision });
  const deputies = async () => (await sessionApi.leadership()).deputies.map(p => p.user_id).sort();
  try {
    await mount("/leadership", "/leadership", <LeadershipPage />);
    const choice = () => page!.container.querySelector(`input[name="users"][value="${b.user_id}"]`)?.closest("form");
    await until(() => !!choice());
    await pick(choice()!, "users", String(b.user_id));
    await submit(choice()!);
    await until(() => !!page!.container.querySelector<HTMLInputElement>(`input[name="users"][value="${b.user_id}"]:checked`));
    expect(await deputies()).toEqual([a.user_id, b.user_id].sort());
    await pick(choice()!, "users", String(a.user_id), false);
    await submit(choice()!);
    expect(choice()!.querySelector('[role="alert"]')?.textContent).toContain("Будут сняты: Тестовый deputy-a.");
    expect(await deputies()).toEqual([a.user_id, b.user_id].sort());
    await click(choice()!, "Снять и сохранить");
    await until(() => !page!.container.querySelector<HTMLInputElement>(`input[name="users"][value="${a.user_id}"]:checked`) && !!choice());
    expect(await deputies()).toEqual([b.user_id]);
  } finally {
    await liveLogin();
    await sessionApi.deputies([], { expected_revision: (await sessionApi.leadership()).revision });
  }
});

it("2.12 УВ-5: a subevent lead fills criteria and reads the dates; the chair moves the deadline", async () => {
  const lead = await liveParticipant("dates-lead"), org = await liveParticipant("dates-org");
  const { sub, task } = await subeventTask([org], "Задача с датами");
  await eventsApi.leaders("subevents", sub.subevent_id, [lead.user_id], { expected_revision: (await eventsApi.subevent(sub.subevent_id)).revision });
  const dates = () => inDetails("Даты и признаки задачи");
  await liveLogin(lead.email);
  await taskPage(task.task_id);
  await until(() => !!dates()?.querySelector('[name="creative"]'));
  expect(dates()!.querySelector('[name="deadline"]')).toBeNull();
  expect(dates()!.querySelector('[name="assigned"]')).toBeNull();
  expect(dates()!.textContent).toContain("Дедлайн:");
  expect(page!.container.querySelector('[name="completed"]')).toBeNull();
  const criteria = field(dates()!, "creative").closest("form")!;
  await change(field(criteria, "creative"), "true");
  await change(field(criteria, "reason"), "Творческая задача");
  await save(criteria);
  expect((await tasksApi.inputs(task.task_id)).criteria.creative).toBe(true);
  await page!.cleanup(); page = undefined;

  await liveLogin();
  await taskPage(task.task_id);
  await until(() => !!dates()?.querySelector('[name="deadline"]'));
  const moved = new Date(Math.floor((Date.now() + 2 * 86400000) / 60000) * 60000);
  const editor = field(dates()!, "deadline").closest("form")!;
  await change(field(editor, "deadline"), new Date(moved.getTime() + 3 * 3600000).toISOString().slice(0, 16));
  await change(field(editor, "reason"), "Перенос дедлайна");
  await save(editor);
  const saved = await tasksApi.inputs(task.task_id);
  expect(Date.parse(saved.deadline_at)).toBe(moved.getTime());
  expect(saved.criteria.creative).toBe(true);
});
