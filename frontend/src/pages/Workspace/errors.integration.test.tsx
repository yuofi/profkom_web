// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { reportsApi } from "../../utils/api/reports.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { sessionApi } from "../../utils/api/session.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { authApi } from "../../utils/api/auth.api";
import { emptyCriteria, richText, type Subevent } from "../../utils/api/contract";
import { userMessage } from "../../utils/api/messages";
import { UserProvider } from "../../utils/ctx";
import { GreetingPage } from "../Greeting/Greeting";
import { ProfileEditPage } from "../ProfileEditPage/ProfileEditPage";
import { MeetingPage } from "./ReportPages";
import { LeadershipPage } from "./SessionPages";
import { TaskPage } from "./TaskPages";

// FIX_PLAN 2.13 against the live local API: what the server refuses reaches the screen in
// Russian, chosen by the code; no alert is English or names internal identifiers (A-FE-3).
// A task the user no longer reads looks like a missing one (A-SEC-6).
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; vi.restoreAllMocks(); });
const alerts = () => Array.from(page!.container.querySelectorAll('[role="alert"]')).map(a => a.textContent ?? "");
const buttons = (root: ParentNode) => Array.from(root.querySelectorAll("button")).map(b => b.textContent);

function readable(text: string) {
  expect(text).toMatch(/[А-Яа-яЁё]/);
  expect(text, text).not.toMatch(/[A-Za-z]{3,}/);
  expect(text, text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|(task|report|file|assignment|subevent)-/);
}
async function refusal(call: () => Promise<unknown>) {
  try { await call(); } catch (error) { return error; }
  throw new Error("The server accepted the command");
}
async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");
  if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Errors", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const result = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });
  return "season" in result ? result.season : result;
}
/** An event of the chair with a subevent organized by `org` and a task of `worker`. */
async function team() {
  const org = await liveParticipant("errors-org"), worker = await liveParticipant("errors-worker");
  const season = await openSeason();
  const event = await eventsApi.create({ season_id: season.season_id, title: "Ошибки", description: richText("") });
  let sub = await eventsApi.createSubevent(event.event_id, { title: "Ошибки подмероприятия", description: richText("") });
  sub = await eventsApi.organizers(sub.subevent_id, [org.user_id, worker.user_id], { expected_revision: sub.revision }) as Subevent;
  const task = await tasksApi.create({ season_id: season.season_id, scope: { kind: "subevent", id: sub.subevent_id }, title: "Афиша",
    description: richText(""), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(),
    assignees: [{ user_id: worker.user_id, hours: 1 }] });
  return { org, worker, season, event, sub, task };
}

it("2.13: a wrong password is answered in Russian on the login form", async () => {
  page = await mountWorkspace(<HelmetProvider><GreetingPage /></HelmetProvider>);
  await act(async () => page!.container.querySelector("h5")!.click());  // «или войти c паролем»
  await change(field(page.container, "email"), "chair@example.com");
  await change(field(page.container, "password"), "Wrong-Password-2026");
  await submit(page.container.querySelector("form")!);
  await waitForPage(page, () => alerts().length > 0);
  expect(alerts()[0]).toContain("Неверная почта или пароль.");
  readable(alerts()[0]);
});

it("2.13: four deputies of the chair are refused as an input error with the server's limit", async () => {
  const people: Awaited<ReturnType<typeof liveParticipant>>[] = [];
  for (const label of ["a", "b", "c", "d"]) people.push(await liveParticipant(`deputy-limit-${label}`));
  const session = await liveLogin();
  const before = await sessionApi.leadership();
  page = await mountWorkspace(<Routes><Route path="/leadership" element={<LeadershipPage />} /></Routes>, { path: "/leadership", session });
  await waitForPage(page, () => !!page!.container.querySelector('[data-entity-picker][data-field-name="users"]'));
  const picker = page.container.querySelector<HTMLElement>('[data-entity-picker][data-field-name="users"]')!;
  const input = picker.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => { input.focus();input.click(); });await waitForPage(page);
  const candidates = document.getElementById(input.getAttribute("aria-controls")!)!;
  for (const person of people) expect(candidates.querySelector(`[data-option-value="${person.user_id}"]`)).not.toBeNull();
  const form = picker.closest("form")!;
  for (const p of people) await pick(form, "users", String(p.user_id));
  await submit(form);
  await waitForPage(page, () => !!form.querySelector('[role="alert"]'));
  const text = form.querySelector('[role="alert"]')!.textContent!;
  expect(text).toContain("Можно назначить не больше 3 заместителей.");
  readable(text);
  expect(buttons(form)).not.toContain("Обновить данные");
  for (const p of people) expect(picker.querySelector(`[data-selected-value="${p.user_id}"]`)).not.toBeNull();
  expect((await sessionApi.leadership()).revision).toBe(before.revision);
});

it("2.13 A-SEC-6: an organiser removed from the team sees an old task link as a missing task", async () => {
  const { org, worker, sub, task } = await team();
  const open = async (id: string) => {
    await page?.cleanup();
    const session = await liveLogin(org.email);
    page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { path: `/tasks/${id}`, session });
    await waitForPage(page);
  };
  await open(task.task_id);
  expect(page!.container.textContent).toContain("Афиша");
  await liveLogin();
  const current = await eventsApi.subevent(sub.subevent_id);
  await eventsApi.organizers(sub.subevent_id, [worker.user_id], { expected_revision: current.revision });
  await open(task.task_id);
  await waitForPage(page!, () => alerts().length > 0);
  const removed = alerts();
  expect(page!.container.textContent).not.toContain("Афиша");
  await open("task-00000000-0000-0000-0000-000000000000");
  await waitForPage(page!, () => alerts().length > 0);
  expect(removed).toEqual(alerts());
  expect(removed[0]).toContain("Объект не найден или недоступен.");
  readable(removed[0]);
  expect(buttons(page!.container)).not.toContain("Обновить данные");
});

it("2.13: the event meeting overview explains restricted main access without requesting its announcement", async () => {
  const { org, event } = await team();
  await liveLogin();
  const hidden = { title: "Созвон главоргов", starts_at: new Date(Date.now() + 86400000).toISOString(), join_url: "https://telemost.yandex.ru/j/1" };
  await eventsApi.saveMeeting("events", event.event_id, hidden);
  const session = await liveLogin(org.email);
  const requested = vi.spyOn(eventsApi, "meeting");
  page = await mountWorkspace(<Routes><Route path="/meetings/:kind/:id" element={<MeetingPage />} /></Routes>, { path: `/meetings/event/${event.event_id}`, session });
  await waitForPage(page);
  const notice = "Главный созвон доступен только его участникам. Доступные вам созвоны команд показаны ниже.";
  expect(page.container.textContent).toContain(notice);
  readable(notice);
  expect(page.container.textContent).toContain("Назначенных созвонов доступных вам команд пока нет.");
  expect(alerts()).toEqual([]);
  expect(page.container.textContent).not.toContain(hidden.title);
  expect(page.container.querySelector(`a[href="${hidden.join_url}"]`)).toBeNull();
  expect(page.container.querySelector('input[name="url"]')).toBeNull();
  expect(requested.mock.calls.some(([kind, id]) => kind === "events" && id === event.event_id)).toBe(false);
});

it("2.13 A-FE-8: a taken email in the profile is named as such", async () => {
  const owner = await liveParticipant("errors-email-owner"), other = await liveParticipant("errors-email-other");
  await liveLogin(other.email);
  page = await mountWorkspace(<HelmetProvider><UserProvider><ProfileEditPage /></UserProvider></HelmetProvider>);
  await waitForPage(page, () => !!page!.container.querySelector('input[name="email"]'));
  const form = field(page.container, "email").closest("form")!;
  await change(field(form, "email"), owner.email);
  await submit(form);
  await waitForPage(page, () => alerts().length > 0);
  expect(alerts()[0]).toBe("Эта почта уже зарегистрирована.");
});

it("2.13: refusals of reports, meetings and sign-in read as Russian sentences", async () => {
  const { org, event } = await team();
  const chair = await liveLogin();
  await eventsApi.leaders("events", event.event_id, [chair.user_id], { expected_revision: event.revision });
  const report = await reportsApi.create({ owner_kind: "event", owner_id: event.event_id, kind: "final", title: "Итог", content: richText("Текст"), file_ids: [] });
  const refusals = [
    await refusal(() => reportsApi.update(report.report_id, { expected_revision: report.revision + 5, title: "Старое" })),
    await refusal(() => reportsApi.create({ owner_kind: "event", owner_id: event.event_id, kind: "final", title: "Ещё итог", content: richText(""), file_ids: [] })),
    await refusal(() => reportsApi.get("report-00000000-0000-0000-0000-000000000000")),
    await refusal(() => authApi.login({ email: "nobody@example.com", password: "Wrong-Password-2026" })),
  ];
  await liveLogin(org.email);
  refusals.push(
    await refusal(() => reportsApi.update(report.report_id, { expected_revision: report.revision, title: "Чужое" })),
    await refusal(() => eventsApi.meeting("events", event.event_id)),
  );
  const texts = refusals.map(e => userMessage(e));
  for (const text of texts) readable(text);
  expect(texts.slice(0, 3)).toEqual([
    "Запись изменилась. Обновите данные и проверьте ввод.",
    "Итоговый отчёт этого экземпляра уже есть.",
    "Объект не найден или недоступен.",
  ]);
});
