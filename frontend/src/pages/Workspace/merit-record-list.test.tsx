// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { change, mountWorkspace, settle, waitForPage } from "../../test/workspace";
import { emptyCriteria, richText, type Contribution, type MeritCreate, type Session } from "../../utils/api/contract";
import { seasonsApi } from "../../utils/api/seasons.api";
import { MeritsPage } from "./MeritPages";

// «Записи» of «Особые заслуги и волонтёры» (owner B8, variant Г, 2026-11-09).
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });

const ASSIGNED = "2026-10-01T10:00:00.000Z", DEADLINE = "2026-10-10T10:00:00.000Z";
const share = (user_id: number, hours: number, evaluation: -1 | 0 | 1 | 1.5, completed_at: string | null = null) => ({ user_id, hours, evaluation, completed_at });
const record = (merit: Partial<MeritCreate>) => seasonsApi.createMerit({ season_id: "season-1", source_kind: "chair_merit", title: "Запись", description: richText("Работа"),
  assigned_at: ASSIGNED, deadline_at: DEADLINE, criteria: emptyCriteria(), recipients: [share(101, 1, 1, ASSIGNED)], ...merit });
/** Another author than the chair who records everything in the demo. */
const authoredBy = (meritId: string, userId: number) => { mock!.state.merits.find(m => m.merit_id === meritId)!.created_by = structuredClone(mock!.state.people.find(p => p.user_id === userId)!); };
async function mount(session?: Session) {
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits", session });
  await waitForPage(page);await settle();
  return page;
}
const text = (node: Element | null | undefined) => node?.textContent?.replace(/[\u00a0\u202f]/g, " ") ?? "";
const list = () => page!.container.querySelector<HTMLElement>('section[aria-label="Записи"]')!;
const group = (title: string) => [...list().querySelectorAll<HTMLElement>("tbody")].find(item => item.querySelector('td[data-cell="title"] button')?.textContent === title)!;
const titles = () => [...list().querySelectorAll('td[data-cell="title"] button')].map(button => button.textContent);
const values = (line: Element) => [...line.querySelectorAll("td[data-num]")].map(cell => text(cell));
const found = () => text(list().querySelector('[role="status"]'));
const select = (name: string) => list().querySelector<HTMLSelectElement>(`select[name="records-${name}"]`)!;
const dialog = () => page!.container.querySelector<HTMLDialogElement>("dialog");
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith(label))!;
const assessments = () => mock!.adapter.history.get.filter(request => request.url === "/assessments").map(request => request.params as Record<string, unknown>);

it("shows a line per recipient with their own hours, evaluation and KKR, the record's cells once and no total", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const sound = await record({ title: "Звук на концерте", recipients: [share(101, 3, 1.5, "2026-10-09T10:00:00.000Z"), share(102, 5, -1), share(103, 2, 1, "2026-10-12T10:00:00.000Z")] });
  const credit = (user_id: number, score: number) => ({ merit_id: sound.merit_id, user: { user_id, display_name: "", avatar_url: null }, score }) as Contribution;
  const kkr = vi.spyOn(seasonsApi, "meritAssessments").mockResolvedValue([credit(101, 6.4549), credit(102, -7.125), credit(103, 0.8775)]);
  await mount();
  expect(kkr).toHaveBeenCalledWith("season-1", expect.anything());
  const lines = group("Звук на концерте").querySelectorAll("tr");
  expect(lines).toHaveLength(3);
  expect([...lines].map(values)).toEqual([["3", "1,5", "6,45"], ["5", "−1", "−7,13"], ["2", "1", "0,88"]]);
  // The date, the title with its team and the author once, over the three lines.
  for (const cell of ["date", "title", "author"]) {
    expect(group("Звук на концерте").querySelectorAll(`td[data-cell="${cell}"]`)).toHaveLength(1);
    expect(group("Звук на концерте").querySelector(`td[data-cell="${cell}"]`)!.getAttribute("rowspan")).toBe("3");
  }
  expect(text(group("Звук на концерте").querySelector('td[data-cell="title"] small'))).toBe("Председатель");
  expect([...list().querySelectorAll("thead th")].map(th => th.textContent)).toEqual(["Дата", "Запись", "Получатель", "Часы", "Оценка", "ККР", "Автор"]);
  // No sum of the hours (10) or of the KKR (0,20) anywhere on the record.
  expect(text(group("Звук на концерте"))).not.toMatch(/\b10\b|0,20/);
  // Compact chips «Фамилия И.»: the full name in the link's name.
  const chips = [...group("Звук на концерте").querySelectorAll<HTMLAnchorElement>('td[data-cell="person"] a')];
  expect(chips.map(chip => chip.lastElementChild?.textContent)).toEqual(["Смирнова А.", "Петров И.", "Орлова М."]);
  // No photo: the initials stand for the face.
  expect(chips.map(chip => chip.firstElementChild?.textContent)).toEqual(["СА", "ПИ", "ОМ"]);
  expect(chips.map(chip => chip.getAttribute("aria-label"))).toEqual(["Смирнова Анна", "Петров Иван", "Орлова Мария"]);
  expect(chips[1].getAttribute("href")).toBe("/contacts/102");
  expect(group("Звук на концерте").querySelector('td[data-cell="author"] a')?.lastElementChild?.textContent).toBe("Соколов А.");
  // Colours by class: −1 and a negative KKR in red, 1,5 in green.
  const minus = lines[1].querySelector('[data-value="-1"]')!, best = lines[0].querySelector('[data-value="1.5"]')!, negative = lines[1].querySelector("[data-negative]")!;
  expect([minus.className, best.className, negative.className]).toEqual([expect.stringMatching(/evaluation/), expect.stringMatching(/evaluation/), expect.stringMatching(/score/)]);
  expect(lines[0].querySelector("[data-negative]")).toBeNull();
  const css = readFileSync(`${__dirname}/MeritRecordList.module.css`, "utf8").replace(/\s+/g, " ");
  expect(css).toContain('.score[data-negative] { color: var(--accent-rose); }');
  expect(css).toContain('.evaluation[data-value="-1"] { color: var(--accent-rose); }');
  expect(css).toContain('.evaluation[data-value="1.5"] { color: var(--accent-mint); }');
});

it("shows a chip's full name and values on keyboard focus, not only on hover", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  await record({ title: "Звук", recipients: [share(101, 3, 1.5, ASSIGNED), share(102, 2.5, 0)] });
  await mount();
  const chip = group("Звук").querySelectorAll<HTMLAnchorElement>('td[data-cell="person"] a')[1];
  await act(async () => chip.focus());
  const card = document.querySelector('[role="tooltip"]')!;
  expect(chip.getAttribute("aria-describedby")).toBe(card.id);
  expect(text(card)).toContain("Петров Иван");
  expect(text(card)).toMatch(/2,5 ч · оценка 0 · ККР 0,00/);
});

it("reads every recipient's KKR from the four merit kinds of the season", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  await record({ title: "Председатель", recipients: [share(101, 2, 1, ASSIGNED)] });
  await record({ title: "Блок", source_kind: "block_volunteer", scope: { kind: "block", id: "block-it" }, recipients: [share(102, 4, -1)] });
  await mount();
  expect(assessments().map(params => params.source_kind).sort()).toEqual(["block_volunteer", "chair_merit", "head_merit", "subevent_volunteer"]);
  expect(assessments().every(params => params.season_id === "season-1")).toBe(true);
  expect(values(group("Председатель").querySelector("tr")!)).toEqual(["2", "1", expect.stringMatching(/^\d+,\d\d$/)]);
  expect(values(group("Блок").querySelector("tr")!)).toEqual(["4", "−1", expect.stringMatching(/^−\d+,\d\d$/)]);
});

it("searches the title, a recipient and the author, filters by each list, counts what is found and resets", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const photo = await record({ title: "Фотосъёмка концерта", recipients: [share(101, 2, 1, ASSIGNED)] });
  const script = await record({ title: "Сценарий вечера", source_kind: "head_merit", event_id: "event-1", assigned_at: "2026-11-02T10:00:00.000Z", deadline_at: "2026-11-05T10:00:00.000Z",
    recipients: [share(102, 4, 1, "2026-11-03T10:00:00.000Z"), share(103, 1, 0)] });
  await record({ title: "Звук на концерте", source_kind: "block_volunteer", scope: { kind: "block", id: "block-info" }, assigned_at: "2026-10-05T10:00:00.000Z", recipients: [share(103, 3, 1.5, "2026-10-06T10:00:00.000Z")] });
  authoredBy(script.merit_id, 102);authoredBy(photo.merit_id, 105);
  await mount();
  expect(found()).toBe("3 записи");
  expect(list().querySelector('[role="status"] + button')).toBeNull();
  const search = list().querySelector<HTMLInputElement>('input[type="search"]')!;
  const searchFor = async (value: string) => { await change(search, value);await waitForPage(page!); };
  await searchFor("концерт");
  expect(titles()).toEqual(["Звук на концерте", "Фотосъёмка концерта"]);
  expect(found()).toBe("Найдено 2 из 3 записей");
  await searchFor("орлова");
  expect(titles()).toEqual(["Сценарий вечера", "Звук на концерте"]);
  // The author: «Белова Дарья» recorded the photos.
  await searchFor("белова");
  expect(titles()).toEqual(["Фотосъёмка концерта"]);
  expect(found()).toBe("Найдено 1 из 3 записей");
  await searchFor("нет такой записи");
  expect(text(list())).toContain("Записей по этим условиям нет.");
  await act(async () => button(list(), "Сбросить").click());await waitForPage(page!);
  expect(search.value).toBe("");
  expect(titles()).toHaveLength(3);
  expect(found()).toBe("3 записи");

  const choose = async (name: string, value: string) => { await change(select(name), value);await waitForPage(page!); };
  expect([...select("team").options].map(option => option.textContent)).toEqual(["Все команды", "Председатель", "Блок «Инфо»", "День математика"]);
  await choose("team", "event:event-1");
  expect(titles()).toEqual(["Сценарий вечера"]);
  expect(select("team").hasAttribute("data-active")).toBe(true);
  expect(select("person").hasAttribute("data-active")).toBe(false);
  await choose("team", "");
  await choose("person", "103");
  expect(titles()).toEqual(["Сценарий вечера", "Звук на концерте"]);
  await choose("person", "");
  await choose("author", "102");
  expect(titles()).toEqual(["Сценарий вечера"]);
  await choose("author", "");
  await choose("kind", "block_volunteer");
  expect(titles()).toEqual(["Звук на концерте"]);
  expect([...select("kind").options].map(option => option.textContent)).toEqual(["Все виды", "Заслуги председателя", "Заслуги главоргов", "Волонтёры блоков"]);
  await choose("kind", "");
  expect([...select("month").options].map(option => option.textContent)).toEqual(["Весь сезон", "Ноябрь 2026", "Октябрь 2026"]);
  await choose("month", "2026-10");
  expect(titles()).toEqual(["Звук на концерте", "Фотосъёмка концерта"]);
  await choose("person", "101");
  expect(titles()).toEqual(["Фотосъёмка концерта"]);
  expect(found()).toBe("Найдено 1 из 3 записей");
  // On a phone the lists stand behind «Фильтры» with the number of chosen ones.
  const toggle = button(list(), "Фильтры") ?? [...list().querySelectorAll("button")].find(item => item.textContent?.includes("Фильтры"))!;
  expect(toggle.querySelector('[aria-label="выбрано 2"]')?.textContent).toBe("2");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(list().querySelector("#merit-record-filters")!.hasAttribute("data-open")).toBe(false);
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(list().querySelector("#merit-record-filters")!.hasAttribute("data-open")).toBe(true);
  await act(async () => button(list(), "Сбросить").click());await waitForPage(page!);
  expect(toggle.querySelector('[aria-label^="выбрано"]')).toBeNull();
  expect(titles()).toHaveLength(3);
  expect(["team", "person", "author", "kind", "month"].map(name => select(name).value)).toEqual(["", "", "", "", ""]);
});

it("searches all the season's records, not only the twenty shown first", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  for (let index = 0; index < 22; index += 1)
    await record({ title: index === 0 ? "Самая ранняя работа" : `Работа ${index}`, assigned_at: new Date(Date.parse(ASSIGNED) + index * 3600_000).toISOString() });
  await mount();
  expect(titles()).toHaveLength(20);
  expect(titles()).not.toContain("Самая ранняя работа");
  expect(button(list(), "Показать ещё").textContent).toBe("Показать ещё · 2");
  await change(list().querySelector<HTMLInputElement>('input[type="search"]')!, "ранняя");await waitForPage(page!);
  expect(titles()).toEqual(["Самая ранняя работа"]);
  expect(found()).toBe("Найдено 1 из 22 записей");
  // Every record came with one GET /merits: the server has no pages of them.
  expect(mock.adapter.history.get.filter(request => request.url === "/merits")).toHaveLength(1);
});

it("opens a record by a click on its line or Enter on its title: values with «позже срока», description, history and correction", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  await record({ title: "Звук на концерте", description: richText("Привезли и настроили аппаратуру."),
    recipients: [share(101, 3, 1.5, "2026-10-09T10:00:00.000Z"), share(102, 5, -1), share(103, 2, 1, "2026-10-12T10:00:00.000Z")] });
  await mount();
  // A chip is its own action: it opens no window.
  await act(async () => group("Звук на концерте").querySelector('td[data-cell="person"] [data-row-action]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(dialog()).toBeNull();
  // A click anywhere else on the record, here on the second recipient's hours.
  await act(async () => group("Звук на концерте").querySelectorAll("tr")[1].querySelector("td[data-num]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));await waitForPage(page!);
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Звук на концерте");
  const window = dialog()!;
  expect(text(window)).toMatch(/Председатель · Заслуга председателя/);
  expect(text(window)).toMatch(/срок 10 окт\./);
  const rows = [...window.querySelectorAll('table[aria-label="Получатели и их значения"] tbody tr')];
  expect([...window.querySelectorAll('table[aria-label="Получатели и их значения"] th')].map(th => th.textContent)).toEqual(["Получатель", "Часы", "Оценка", "Выполнено", "ККР"]);
  expect(rows.map(row => row.querySelector('td[data-cell="person"] a')?.lastElementChild?.textContent)).toEqual(["Смирнова Анна", "Петров Иван", "Орлова Мария"]);
  expect(rows.map(row => values(row).slice(0, 2))).toEqual([["3", "1,5"], ["5", "−1"], ["2", "1"]]);
  expect(rows.map(row => values(row)[2])).toEqual([expect.stringMatching(/^\d+,\d\d$/), expect.stringMatching(/^−\d+,\d\d$/), expect.stringMatching(/^\d+,\d\d$/)]);
  expect(rows.map(row => text(row.querySelector('td[data-cell="done"]')))).toEqual([expect.stringMatching(/^9 окт\./), "—", expect.stringMatching(/^12 окт\..*позже срока$/)]);
  expect(text(window)).toContain("Привезли и настроили аппаратуру.");
  expect([...window.querySelectorAll("summary")].map(summary => summary.textContent)).toEqual(expect.arrayContaining(["История изменений", "Исправить исходные поля"]));
  expect(window.querySelector('form [name="reason"]')).not.toBeNull();
  await act(async () => window.querySelector<HTMLButtonElement>('[aria-label="Закрыть окно"]')!.click());
  expect(dialog()).toBeNull();
  // Enter on the focused title opens it too.
  const title = group("Звук на концерте").querySelector<HTMLButtonElement>('td[data-cell="title"] button')!;
  await act(async () => { title.focus();title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });await waitForPage(page!);
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Звук на концерте");
});

it("a reader without KKR rights sees the hours and evaluations without a KKR column and asks no KKR", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  await record({ title: "Волонтёрство IT", source_kind: "block_volunteer", scope: { kind: "block", id: "block-it" }, recipients: [share(101, 2, 1, ASSIGNED), share(102, 4, 1.5, ASSIGNED)] });
  // As the server answers a reader: no right to correct the record.
  const merits = structuredClone(mock.state.merits).map(merit => ({ ...merit, capabilities: [] }));mock.restore();
  const base = createFixtures("organizer").session;
  const session: Session = { ...base, capabilities: base.capabilities.filter(cap => cap !== "view_summary" && cap !== "view_kkr" && !cap.includes("merit")),
    assignments: [{ role_assignment_id: "role-master", role: "block_master", scope_kind: "block", scope_id: "block-it", revision: 1, capabilities: ["view_merits"] }] };
  mock = installMockTransport("organizer", { delay: 0 });mock.state.merits.splice(0, mock.state.merits.length, ...merits);mock.state.session = session;
  await mount(session);
  expect([...list().querySelectorAll("thead th")].map(th => th.textContent)).toEqual(["Дата", "Запись", "Получатель", "Часы", "Оценка", "Автор"]);
  expect([...group("Волонтёрство IT").querySelectorAll("tr")].map(values)).toEqual([["2", "1"], ["4", "1,5"]]);
  expect(assessments()).toHaveLength(0);
  await act(async () => group("Волонтёрство IT").querySelector<HTMLButtonElement>('td[data-cell="title"] button')!.click());await waitForPage(page!);
  const recipients = dialog()!.querySelector('table[aria-label="Получатели и их значения"]')!;
  expect([...recipients.querySelectorAll("th")].map(th => th.textContent)).toEqual(["Получатель", "Часы", "Оценка", "Выполнено"]);
  expect(text(recipients)).not.toContain("ККР");
  expect([...dialog()!.querySelectorAll("summary")].map(summary => summary.textContent)).toEqual(["История изменений"]);
});
