// @vitest-environment jsdom
import MockAdapter from "axios-mock-adapter";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { api } from "../../utils/api";
import { createFixtures } from "../../mocks/fixtures";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { emptyCriteria, richText, type Contribution, type SeasonSummary } from "../../utils/api/contract";
import { SeasonParticipants } from "./SeasonParticipants";
import { SeasonPage } from "./SeasonPages";
import { SourcesPage, SeasonCorrectionForm } from "./MeritPages";
import { SummaryTable } from "./SummaryTable";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let adapter: MockAdapter | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;adapter?.restore();adapter = undefined; });
const response = <T,>(items: T[]) => ({ items, next_cursor: null });
const visibleNames = () => Array.from(page!.container.querySelectorAll("tbody tr")).map(row => row.querySelector("td:nth-child(2)")?.textContent ?? "");
function summaryFixture(): SeasonSummary {
  const summary = structuredClone(createFixtures("chair").summary), first = summary.rows[0];
  summary.rows = [
    { ...first, participant_id: "participant-1", user: { user_id: 1, display_name: "Ася Тестовая", avatar_url: null }, group_number: "101", decisions: ["nice"], previous_decisions: ["kick_warning"] },
    { ...first, participant_id: "participant-2", user: { user_id: 2, display_name: "Борис Мастер", avatar_url: null }, group_number: "102", category: "activist", blocks: [{ block_id: "block-it", name: "IT" }], is_master: true, rank: 2, decisions: ["kick_warning"], previous_decisions: ["nice"] },
    { ...first, participant_id: "anonymous-accounting-test", user: { user_id: null, display_name: "Обезличенный участник", avatar_url: null }, group_number: "", category: "activist", is_archived: true, rank: 2, decisions: [], previous_decisions: ["golden_red_bull"] },
    { ...first, participant_id: "participant-4", user: { user_id: 4, display_name: "Даша Мастер", avatar_url: null }, group_number: "104", category: "activist", is_archived: true, is_master: true, rank: 4, decisions: ["nice"], previous_decisions: [] },
  ];
  return summary;
}
it("combines participant filters without reranking and keeps anonymous participant identities", async () => {
  page = await mountWorkspace(<SeasonParticipants summary={summaryFixture()} />);
  expect(visibleNames()).toHaveLength(4);
  await change(field(page.container, "category"), "activist");expect(visibleNames()).toHaveLength(3);
  await change(field(page.container, "is_master"), "true");expect(visibleNames()).toHaveLength(2);
  await change(field(page.container, "is_archived"), "true");expect(visibleNames()).toEqual([expect.stringContaining("Даша Мастер")]);
  expect(page.container.querySelector("tbody tr td")?.textContent).toContain("4");
  await pick(page.container, "block", "block-it");expect(visibleNames()).toHaveLength(0);
  await pick(page.container, "block", "block-info");expect(visibleNames()).toHaveLength(1);
  await change(field(page.container, "marks"), "kick_warning");expect(visibleNames()).toHaveLength(0);
  await change(field(page.container, "marks"), "nice");expect(visibleNames()).toHaveLength(1);
  await change(field(page.container, "is_master"), "false");expect(visibleNames()).toHaveLength(0);
  await change(field(page.container, "marks"), "none");expect(visibleNames()).toEqual([expect.stringContaining("Обезличенный участник")]);
  expect(page.container.querySelector("tbody tr td")?.textContent).toContain("2");
  await change(field(page.container, "marks"), "golden_red_bull");expect(visibleNames()).toHaveLength(0);
});
it("renders previous marks in a separate seventh cell from current decisions and their editor", async () => {
  const summary = summaryFixture();summary.rows = [summary.rows[0]];
  page = await mountWorkspace(<SummaryTable summary={summary} renderDecisions={() => <button>Редактор текущих отметок</button>} />);
  const headings = Array.from(page.container.querySelectorAll("th")).map(th => th.textContent);
  expect(headings).toEqual(["Место", "Участник", "Блоки", "ККР", "Оценённых назначений", "Отметки", "Прошлые отметки"]);
  const cells = page.container.querySelectorAll("tbody tr td");
  expect(cells[5].textContent).toContain("Найс");expect(cells[5].textContent).toContain("Редактор текущих отметок");expect(cells[5].textContent).not.toContain("Предупреждение");
  expect(cells[6].textContent).toContain("Предупреждение о кике");expect(cells[6].querySelector("button")).toBeNull();
});
it("passes source and stable anonymous participant filters to the server and replaces displayed contributions", async () => {
  adapter = new MockAdapter(api);const summary = summaryFixture();
  const contributions: Contribution[] = summary.rows.slice(0, 3).map((row, index) => ({ contribution_id: `credit-${index}`, season_id: summary.season_id, participant_id: row.participant_id, user: row.user, source_kind: index === 1 ? "chair_merit" : "block_task", source_id: "block-info", source_title: `Источник ${index}`, score: index, calculation_version: "fixture", capabilities: [] }));
  adapter.onGet(`/seasons/${summary.season_id}/summary`).reply(200, summary);
  adapter.onGet("/assessments").reply(config => [200, response(contributions.filter(item => (!config.params.source_kind || item.source_kind === config.params.source_kind) && (!config.params.participant_id || item.participant_id === config.params.participant_id)))]);
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/sources" element={<SourcesPage />} /></Routes>, { path: `/seasons/${summary.season_id}/sources` });await waitForPage(page);
  expect(page.container.textContent).toContain("Источник 1");
  await change(field(page.container, "source_kind"), "block_task");await pick(page.container, "participant_id", "anonymous-accounting-test");await waitForPage(page);
  expect(adapter.history.get.filter(request => request.url === "/assessments").at(-1)?.params).toMatchObject({ season_id: summary.season_id, source_kind: "block_task", participant_id: "anonymous-accounting-test" });
  expect(page.container.textContent).toContain("Источник 2");expect(page.container.textContent).not.toContain("Источник 0");expect(page.container.textContent).not.toContain("Источник 1");
});
function correctionFixture() {
  adapter = new MockAdapter(api);const fixture = createFixtures("chair");
  fixture.seasons.find(season => season.season_id === "season-previous")!.state = "closed";
  fixture.events.push({ ...fixture.events[0], event_id: "closed-event", season_id: "season-previous", title: "Закрытый объект" });
  fixture.tasks.push({ ...fixture.tasks[0], task_id: "closed-task", season_id: "season-previous", scope: { kind: "block", id: "block-info" } });
  const merit = { merit_id: "correction-merit", season_id: "season-1", source_kind: "chair_merit", title: "Заслуга для переноса", description: richText(""), assigned_at: "2026-10-01T00:00:00Z", deadline_at: "2026-10-02T00:00:00Z", criteria: emptyCriteria(), recipients: [], reason: "Создание", revision: 3, capabilities: [], created_by: fixture.people[0], created_at: "2026-10-02T00:00:00Z" };
  adapter.onGet("/seasons").reply(200, response(fixture.seasons));adapter.onGet("/events").reply(200, response(fixture.events));adapter.onGet("/tasks").reply(200, response(fixture.tasks));adapter.onGet("/merits").reply(200, response([merit]));
  adapter.onGet(`/season-corrections/event/${fixture.events[0].event_id}/preview`).reply(200, { object_id: fixture.events[0].event_id, source_season_id: "season-1", revision: fixture.events[0].revision, counts: { subevents: 2, tasks: 5, reports: 3, merits: 4 } });
  return fixture;
}
it("lists only nonclosed sources with season labels, removes the source target, and reads actual event hierarchy counts", async () => {
  const fixture = correctionFixture();
  page = await mountWorkspace(<SeasonCorrectionForm />);await waitForPage(page);
  const options = () => Array.from((field(page!.container, "object") as HTMLSelectElement).options);
  expect(options().map(option => option.value)).not.toContain("event/closed-event");expect(options().map(option => option.value)).not.toContain("block_task/closed-task");
  expect(options().find(option => option.value === `event/${fixture.events[0].event_id}`)?.label).toContain("Осень и зима 2026");
  await change(field(page.container, "object"), `event/${fixture.events[0].event_id}`);await waitForPage(page);
  const targets = () => Array.from((field(page!.container, "target") as HTMLSelectElement).options).map(option => option.value);
  expect(targets()).not.toContain("season-1");expect(targets()).not.toContain("season-previous");expect(targets()).toContain("season-next");
  expect(page.container.querySelector('[aria-label="Связанные данные мероприятия"]')?.textContent).toContain("подмероприятия — 2, задачи — 5, отчёты — 3, заслуги — 4");
  await change(field(page.container, "object"), "merit/correction-merit");expect(targets()).not.toContain("season-next");expect(page.container.querySelector('[aria-label="Связанные данные мероприятия"]')).toBeNull();
});
it("retains revision and reason on a closed-source refusal and offers no misleading refresh action", async () => {
  const fixture = correctionFixture();
  adapter!.onPost("/season-corrections").reply(409, { detail: { code: "season_closed", message: "Conflict: source season is closed" } });
  page = await mountWorkspace(<SeasonCorrectionForm />);await waitForPage(page);
  await change(field(page.container, "object"), `event/${fixture.events[0].event_id}`);await change(field(page.container, "target"), "season-next");await change(field(page.container, "reason"), "Проверенная причина");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(JSON.parse(adapter!.history.post[0].data)).toMatchObject({ object_kind: "event", object_id: fixture.events[0].event_id, expected_revision: fixture.events[0].revision, target_season_id: "season-next", reason: "Проверенная причина" });
  expect(page.container.textContent).toContain("Сезон закрыт: эти данные больше не меняются.");expect(field(page.container, "reason").value).toBe("Проверенная причина");
  expect(Array.from(page.container.querySelectorAll("button")).some(button => button.textContent === "Обновить данные")).toBe(false);
});
it("shows authoritative readiness blockers before any attempt to close a season", async () => {
  adapter = new MockAdapter(api);const fixture = createFixtures("chair");
  adapter.onGet("/seasons").reply(200, response(fixture.seasons));adapter.onGet("/seasons/season-1/summary").reply(200, fixture.summary);
  adapter.onGet("/seasons/season-1/readiness").reply(200, { ready: false, revision: 1, blockers: [{ kind: "missing_final_report", owner_kind: "event", owner_id: "event-1", title: "Event has no final report" }] });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id" element={<SeasonPage />} /></Routes>, { path: "/seasons/season-1" });await waitForPage(page);
  const panel = page.container.querySelector('[aria-label="Готовность к закрытию"]');expect(panel).not.toBeNull();expect(panel?.querySelector("a")?.getAttribute("href")).toBe("/reports?owner_kind=event&owner_id=event-1");expect(panel?.textContent).toContain("Нет итогового отчёта мероприятия");
  expect(adapter.history.get.some(request => request.url?.endsWith("/readiness"))).toBe(true);expect(adapter.history.post).toHaveLength(0);
});
it("does not fetch private summary or readiness for a participant without accounting access", async () => {
  adapter = new MockAdapter(api);const fixture = createFixtures("organizer");adapter.onGet("/seasons").reply(200, response(fixture.seasons));
  page = await mountWorkspace(<Routes><Route path="/seasons/:id" element={<SeasonPage />} /></Routes>, { role: "organizer", path: "/seasons/season-1" });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Готовность к закрытию"]')).toBeNull();expect(adapter.history.get.map(request => request.url)).toEqual(["/seasons"]);
});
