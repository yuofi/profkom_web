// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, settle, submit, waitForPage } from "../../test/workspace";
import { emptyCriteria, richText, type Merit, type MeritCreate } from "../../utils/api/contract";
import { ApiError } from "../../utils/api/request";
import { seasonsApi } from "../../utils/api/seasons.api";
import { MeritsPage } from "./MeritPages";
import { MERIT_JOURNAL_PAGE } from "./MeritJournal";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });

const where: string[] = [];
function Where() { const location = useLocation();where.push(location.search);return null; }
const record = (merit: Partial<MeritCreate>) => seasonsApi.createMerit({ season_id: "season-1", source_kind: "chair_merit", title: "Запись", description: richText("Работа"),
  assigned_at: "2026-10-01T10:00:00.000Z", deadline_at: "2026-10-10T10:00:00.000Z", criteria: emptyCriteria(), recipients: [], ...merit });
const edit = (merit: Merit, patch: Partial<Merit>, reason: string) => seasonsApi.updateMerit(merit.merit_id, { ...patch, reason, expected_revision: merit.revision });
const recipient = (user_id: number, hours: number) => ({ user_id, hours, evaluation: 1 as const, completed_at: "2026-10-05T09:00:00.000Z" });
/** The chair's season: a chair record lost a recipient, then a block record got another title, hours and a criterion. */
async function season() {
  mock = installMockTransport("chair", { delay: 0 });
  const chair = await record({ title: "Ремонт проектора", recipients: [recipient(101, 3), recipient(102, 8)] });
  const block = await record({ source_kind: "block_volunteer", scope: { kind: "block", id: "block-info" }, title: "Вёрстка", recipients: [recipient(101, 2)] });
  await edit(chair, { recipients: [recipient(101, 3)] }, "Отмечен по ошибке");
  await edit(block, { title: "Вёрстка газеты", recipients: [recipient(101, 4)], criteria: { ...emptyCriteria(), urgent: true } }, "Уточнили по табелю");
  return { chair, block };
}
async function mount(path = "/seasons/season-1/merits?view=journal") {
  where.length = 0;
  page = await mountWorkspace(<><Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes><Where /></>, { path });
  await waitForPage(page);await settle();
  return page;
}
const modes = () => [...page!.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Что показать"] button')];
const journal = () => page!.container.querySelector<HTMLElement>('section[aria-label="Журнал изменений"]');
const entries = () => [...page!.container.querySelectorAll<HTMLElement>("[data-journal-entry]")];
const requests = () => mock!.adapter.history.get.filter(request => request.url === "/merits/history").map(request => request.params as Record<string, unknown>);
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\u00a0/g, " ") ?? "";

it("switches to the journal of the season's edits, grouped by day, newest first, with editor, record, changes and reason", async () => {
  await season();
  await mount("/seasons/season-1/merits");
  expect(modes().map(button => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["Записи · 2", "true"], ["Журнал изменений", "false"]]);
  expect(journal()).toBeNull();
  await act(async () => modes()[1].click());await waitForPage(page!);
  expect(where.at(-1)).toBe("?view=journal");
  expect(modes()[1].getAttribute("aria-pressed")).toBe("true");
  // The journal replaces the records and the creation form.
  expect(page!.container.textContent).not.toContain("Учесть выполненную работу");
  expect(page!.container.querySelector('ul[aria-label="Получатели"]')).toBeNull();
  expect(text(journal())).toContain("2 изменения в 2 записях · сначала новые");
  expect(requests().at(-1)).toEqual({ season_id: "season-1", limit: MERIT_JOURNAL_PAGE });
  const heading = journal()!.querySelector("h2");
  expect(heading?.textContent).toMatch(/^Воскресенье, 18 октября/);
  const [newest, older] = entries();
  expect(newest.querySelector("time")?.textContent).toBe("15:02");
  expect(newest.querySelector("a")?.textContent).toBe(mock!.state.user.display_name.split(" ").slice(0, 2).join(" "));
  expect(text(newest.querySelector("p"))).toBe("Вёрстка газетыБлок «Инфо»");
  expect([...newest.querySelectorAll('ul[aria-label="Что изменилось"] li')].map(line => line.textContent)).toEqual([
    "Критерий «Срочная задача»: нет → да", "Анна Смирнова — часы: 2 → 4", "Название: «Вёрстка» → «Вёрстка газеты»"]);
  expect(text(newest)).toContain("Причина: Уточнили по табелю");
  const removed = older.querySelector('ul[aria-label="Что изменилось"] li')!;
  expect([removed.textContent, removed.getAttribute("data-tone")]).toEqual(["Получатели: −Иван Петров (было 8 ч)", "remove"]);
  expect(text(older)).toContain("Председатель");
  await act(async () => modes()[0].click());await waitForPage(page!);
  expect(where.at(-1)).toBe("");
  expect(page!.container.textContent).toContain("Учесть выполненную работу");
});

it("filters by team and participant through the URL and the request", async () => {
  await season();
  await mount();
  const options = [...field(page!.container, "team").querySelectorAll("option")].map(option => [option.value, option.textContent]);
  expect(options).toEqual([["", "Все команды"], ["block:block-info", "Блок «Инфо»"], ["chair", "Председатель"]]);
  // While another team loads, the previous list stays on screen, dimmed and busy.
  const read = seasonsApi.meritJournal;
  let release = () => {};
  vi.spyOn(seasonsApi, "meritJournal").mockImplementationOnce((query, signal) => new Promise(resolve => { release = () => resolve(read(query, signal)); }));
  await change(field(page!.container, "team"), "block:block-info");
  expect(journal()!.querySelectorAll('[aria-busy="true"] [data-journal-entry]')).toHaveLength(2);
  await act(async () => release());await waitForPage(page!);
  expect(journal()!.querySelector('[aria-busy="true"]')).toBeNull();
  expect(new URLSearchParams(where.at(-1)).get("team")).toBe("block:block-info");
  expect(requests().at(-1)).toMatchObject({ scope_kind: "block", scope_id: "block-info" });
  expect(entries().map(entry => entry.querySelector("strong")?.textContent)).toEqual(["Вёрстка газеты"]);
  expect(text(journal())).toContain("1 изменение в 1 записи · сначала новые");
  await change(field(page!.container, "person"), "102");await waitForPage(page!);
  expect(requests().at(-1)).toMatchObject({ scope_kind: "block", scope_id: "block-info", user_id: 102 });
  expect(text(journal())).toContain("Изменений по выбранным условиям нет.");
  await change(field(page!.container, "team"), "chair");await waitForPage(page!);
  expect(requests().at(-1)).toMatchObject({ scope_kind: "chair", user_id: 102 });
  expect(requests().at(-1)).not.toHaveProperty("scope_id");
  expect(entries().map(entry => text(entry.querySelector("ul")))).toEqual(["Получатели: −Иван Петров (было 8 ч)"]);
  const search = new URLSearchParams(where.at(-1));
  expect([search.get("view"), search.get("team"), search.get("person")]).toEqual(["journal", "chair", "102"]);
  await change(field(page!.container, "person"), "");await change(field(page!.container, "team"), "");await waitForPage(page!);
  expect(where.at(-1)).toBe("?view=journal");
  expect(entries()).toHaveLength(2);
});

it("shows more edits on request and hands the focus to the first added one after the last page", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  let merit = await record({ title: "Правка 0", recipients: [recipient(101, 1)] });
  for (let index = 1; index <= MERIT_JOURNAL_PAGE + 1; index += 1) merit = await edit(merit, { title: `Правка ${index}` }, `Шаг ${index}`);
  await mount();
  expect(entries()).toHaveLength(MERIT_JOURNAL_PAGE);
  expect(text(journal())).toContain(`${MERIT_JOURNAL_PAGE + 1} изменение в 1 записи`);
  const more = [...journal()!.querySelectorAll("button")].find(button => button.textContent === "Показать ещё")!;
  await act(async () => { more.focus();more.click(); });await waitForPage(page!);
  expect(requests().at(-1)).toMatchObject({ cursor: expect.any(String) });
  expect(entries()).toHaveLength(MERIT_JOURNAL_PAGE + 1);
  expect(text(entries().at(-1))).toContain("Название: «Правка 0» → «Правка 1»");
  expect([...journal()!.querySelectorAll("button")].some(button => button.textContent === "Показать ещё")).toBe(false);
  expect(document.activeElement).toBe(entries()[MERIT_JOURNAL_PAGE]);
});

it("tells an empty journal from a failed one and reads it again on request", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  await mount();
  expect(text(journal())).toContain("Изменений пока нет.");
  expect(text(journal())).not.toContain("сначала новые");
  const read = vi.spyOn(seasonsApi, "meritJournal").mockRejectedValueOnce(new ApiError("Сервис временно недоступен", 503, "unavailable"));
  await page!.client.resetQueries({ queryKey: ["history", "merits"] });await waitForPage(page!);
  expect(journal()!.querySelector('[role="alert"]')?.textContent).toContain("Сервис временно недоступен");
  const retry = [...journal()!.querySelectorAll("button")].find(button => button.textContent === "Обновить данные")!;
  await act(async () => retry.click());await waitForPage(page!);
  expect(read).toHaveBeenCalledTimes(2);
  expect(journal()!.querySelector('[role="alert"]')).toBeNull();
  expect(text(journal())).toContain("Изменений пока нет.");
});

it("rereads a journal read before once a record is corrected through its form", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  await record({ title: "Сохранённая работа", recipients: [recipient(101, 2)] });
  await mount();
  expect(text(journal())).toContain("Изменений пока нет.");
  await act(async () => modes()[0].click());await waitForPage(page!);
  const card = [...page!.container.querySelectorAll("section")].find(section => section.querySelector("h2")?.textContent === "Сохранённая работа")!;
  const form = card.querySelector("form")!;
  await change(field(form, "title"), "Сохранённая работа, исправлено");
  await change(field(form, "reason"), "Уточнили название");
  await submit(form);await waitForPage(page!);
  await act(async () => modes()[1].click());await waitForPage(page!);
  expect(entries()).toHaveLength(1);
  expect(text(entries()[0])).toContain("Название: «Сохранённая работа» → «Сохранённая работа, исправлено»");
  expect(text(entries()[0])).toContain("Причина: Уточнили название");
});
