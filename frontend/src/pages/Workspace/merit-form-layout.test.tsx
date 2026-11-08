// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, pick, settle, submit, waitForPage } from "../../test/workspace";
import { MeritsPage } from "./MeritPages";
import { criteriaKeys, criteriaLabels } from "../../utils/kkrCriteria";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { seasonsApi } from "../../utils/api/seasons.api";
import { profileFeaturesApi, type KkrTemplate } from "../../utils/api/profileFeatures.api";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const label = (name: string) => field(page!.container, name).closest("div")!.querySelector("label")!.textContent;

it("marks the result date required for a positive evaluation, names the evaluations and lists recipients on the card", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const form = page.container.querySelector("form")!;
  // Dates, criteria and each recipient's values share rows instead of one tall column.
  expect(form.querySelector("fieldset")?.className).toMatch(/compactFields/);
  const userId = String(mock.state.people[0].user_id);
  await pick(page.container, "users", userId);
  expect([...field(page.container, `evaluation_${userId}`).querySelectorAll("option")].map(option => option.textContent)).toEqual(expect.arrayContaining(["Зачесть · оценка 1", "Не выполнено · оценка −1"]));
  expect(label(`completed_${userId}`)).not.toContain("*");
  await change(field(page.container, `evaluation_${userId}`), "1");
  expect(label(`completed_${userId}`)).toContain("*");
  await change(field(page.container, `evaluation_${userId}`), "0");
  expect(label(`completed_${userId}`)).not.toContain("*");
  for (const [name, value] of Object.entries({ title: "Помощь залу", body: "Работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", [`hours_${userId}`]: "3" })) await change(field(page.container, name), value);
  await submit(form);await waitForPage(page);
  const card = [...page.container.querySelectorAll("section")].find(section => section.querySelector("h2")?.textContent === "Помощь залу")!;
  const recipients = card.querySelector('ul[aria-label="Получатели"]')!;
  expect(recipients.querySelectorAll("li")).toHaveLength(1);
  expect(recipients.textContent).toContain("Анна");expect(recipients.textContent).toContain("3 ч · оценка 0");
});

it("prints a recipient's fractional hours and evaluation on the card with a decimal comma", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const form = page.container.querySelector("form")!;
  const userId = String(mock.state.people[0].user_id);
  await pick(page.container, "users", userId);
  for (const [name, value] of Object.entries({ title: "Фотосъёмка", body: "Работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", [`hours_${userId}`]: "2.5", [`evaluation_${userId}`]: "1.5", [`completed_${userId}`]: "2026-10-09T13:00" })) await change(field(page.container, name), value);
  await submit(form);await waitForPage(page);
  const card = [...page.container.querySelectorAll("section")].find(section => section.querySelector("h2")?.textContent === "Фотосъёмка")!;
  const recipients = card.querySelector('ul[aria-label="Получатели"]')!;
  expect(recipients.textContent).toContain("2,5 ч · оценка 1,5");expect(recipients.textContent).not.toContain("2.5");
});

it("ticks the five criteria as checkboxes named as on every other screen", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const form = page.container.querySelector("form")!;
  const boxes = criteriaKeys.map(key => form.querySelector<HTMLInputElement>(`input[type="checkbox"][name="${key}"]`)!);
  expect(boxes.map(box => box.closest("label")?.textContent)).toEqual(criteriaKeys.map(key => criteriaLabels[key]));
  expect(form.querySelector('select[name="creative"]')).toBeNull();
  const userId = String(mock.state.people[0].user_id);
  await pick(page.container, "users", userId);
  for (const [name, value] of Object.entries({ title: "Выезд", body: "Работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", [`hours_${userId}`]: "2", [`evaluation_${userId}`]: "0", creative: "true", in_person: "true" })) await change(field(page.container, name), value);
  expect(boxes.map(box => box.checked)).toEqual(criteriaKeys.map(key => key === "creative" || key === "in_person"));
  await submit(form);await waitForPage(page);
  const sent = JSON.parse(mock.adapter.history.post.find(request => request.url === "/merits")!.data);
  expect(sent.criteria).toEqual({ ...emptyCriteria(), creative: true, in_person: true });
});

it("offers a chair merit only templates the server takes for it: personal and «Весь Профком»", async () => {
  const owner = { user_id: 101, display_name: "Анна Смирнова", avatar_url: null };
  const row = (title: string, scope: KkrTemplate["scope"]): KkrTemplate => ({ template_id: title, visibility: scope ? "team" : "personal", scope, revision: 1, archived: false, values: { title, description: "", hours: 1, evaluation: 1, criteria: emptyCriteria() }, author: owner, updated_by: owner });
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [row("Личный", null), row("Общий", { kind: "global", id: null, name: "Профком" }), row("Блочный", { kind: "block", id: "block-1", name: "Блок" }), row("Событийный", { kind: "event", id: "event-1", name: "Мероприятие" })] });
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const search = page.container.querySelector<HTMLInputElement>('[data-field-name="kkr-template"] input[role="combobox"]')!;
  await act(async () => { search.focus();search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await waitForPage(page, () => !!document.querySelector('[role="option"]'));
  expect([...document.querySelectorAll('[role="option"]')].map(option => option.textContent)).toEqual(["Личный · личный", "Общий · Весь Профком"]);
});

async function chairMeritForm() {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const [first, second] = mock.state.people.slice(0, 2).map(person => String(person.user_id));
  for (const [name, value] of Object.entries({ title: "Общая работа", body: "Работа", assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00" })) await change(field(page.container, name), value);
  return { first, second, form: page.container.querySelector("form")! };
}
const shown = (name: string) => !!page!.container.querySelector(`[name="${name}"]`);
const sentMerits = () => mock!.adapter.history.post.filter(request => request.url === "/merits").map(request => JSON.parse(request.data));

it("gives two or more recipients one common block with «Одинаково для всех»; one person may keep own values", async () => {
  const { first, second, form } = await chairMeritForm();
  await pick(page!.container, "users", first);
  expect(shown("same_for_all")).toBe(false);
  await pick(page!.container, "users", second);
  expect(field(page!.container, "same_for_all").closest("label")?.textContent).toBe("Одинаково для всех");
  for (const name of [`hours_${first}`, `evaluation_${first}`, `completed_${second}`]) expect(shown(name)).toBe(false);
  expect(label("common_hours")).toBe("Часы для всех *");
  await change(field(page!.container, "common_hours"), "3");
  await change(field(page!.container, "common_evaluation"), "1");
  // The same rule as for one person: a positive evaluation needs its date.
  expect(label("common_completed")).toContain("*");
  await submit(form);await waitForPage(page!);
  expect(sentMerits()).toHaveLength(0);
  await change(field(page!.container, "common_completed"), "2026-10-05T12:00");
  // One recipient gets own values.
  await change(field(page!.container, `own_${second}`), "true");
  await change(field(page!.container, `hours_${second}`), "5");
  await change(field(page!.container, `evaluation_${second}`), "0");
  expect(shown(`hours_${first}`)).toBe(false);
  await submit(form);await waitForPage(page!);
  const [sent] = sentMerits();
  expect(sent.recipients).toEqual([
    { user_id: Number(first), hours: 3, evaluation: 1, completed_at: "2026-10-05T09:00:00.000Z" },
    { user_id: Number(second), hours: 5, evaluation: 0, completed_at: null },
  ]);
});

it("unticking «Одинаково для всех» hands the common values to each recipient instead of losing them", async () => {
  const { first, second } = await chairMeritForm();
  await pick(page!.container, "users", first);
  await change(field(page!.container, `hours_${first}`), "2");
  await pick(page!.container, "users", second);
  // The box turns on by itself and its block starts from the first recipient's values.
  expect((field(page!.container, "same_for_all") as HTMLInputElement).checked).toBe(true);
  expect(field(page!.container, "common_hours").value).toBe("2");
  await change(field(page!.container, "common_hours"), "6");
  await change(field(page!.container, "same_for_all"), "false");
  expect([field(page!.container, `hours_${first}`).value, field(page!.container, `hours_${second}`).value]).toEqual(["6", "6"]);
});

it("«Подставить шаблон» fills the common block too", async () => {
  const { first, second } = await chairMeritForm();
  const template = await profileFeaturesApi.createTemplate({ visibility: "personal", values: { title: "Смена", description: "Текст", hours: 4, evaluation: 1.5, criteria: emptyCriteria() } });
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["kkrTemplates"] }); });await waitForPage(page!);
  await pick(page!.container, "users", first);await pick(page!.container, "users", second);
  // Two recipients: the box is ticked by default, the template fills its block and leaves it ticked.
  expect((field(page!.container, "same_for_all") as HTMLInputElement).checked).toBe(true);
  await pick(page!.container, "kkr-template", template.template_id);
  await act(async () => [...page!.container.querySelectorAll("button")].find(button => button.textContent === "Подставить шаблон")!.click());await waitForPage(page!);
  expect([field(page!.container, "common_hours").value, field(page!.container, "common_evaluation").value]).toEqual(["4", "1.5"]);
  expect((field(page!.container, "same_for_all") as HTMLInputElement).checked).toBe(true);
});

it("ticking «Одинаково для всех» takes the typed draft and keeps what another recipient typed", async () => {
  const { first, second } = await chairMeritForm();
  await pick(page!.container, "users", first);await pick(page!.container, "users", second);
  await change(field(page!.container, "same_for_all"), "false");
  await change(field(page!.container, `hours_${second}`), "4");
  await change(field(page!.container, `hours_${first}`), "2");
  await change(field(page!.container, "same_for_all"), "true");
  expect(field(page!.container, "common_hours").value).toBe("2");
  // The second recipient typed other hours: they stay as own values instead of being replaced.
  expect((field(page!.container, `own_${second}`) as HTMLInputElement).checked).toBe(true);
  expect(field(page!.container, `hours_${second}`).value).toBe("4");
  expect((field(page!.container, `own_${first}`) as HTMLInputElement).checked).toBe(false);
});

it("dropping to one recipient ends the common block and hands its values to that person", async () => {
  const { first, second } = await chairMeritForm();
  await pick(page!.container, "users", first);await pick(page!.container, "users", second);
  await change(field(page!.container, "common_hours"), "3");
  await change(field(page!.container, "common_evaluation"), "1");
  await pick(page!.container, "users", second, false);
  expect(shown("same_for_all")).toBe(false);
  expect([field(page!.container, `hours_${first}`).value, field(page!.container, `evaluation_${first}`).value]).toEqual(["3", "1"]);
  // Nobody unticked the box: a second recipient turns it on again, from the first person's values.
  await pick(page!.container, "users", second);
  expect((field(page!.container, "same_for_all") as HTMLInputElement).checked).toBe(true);
  expect([field(page!.container, "common_hours").value, field(page!.container, "common_evaluation").value]).toEqual(["3", "1"]);
});

const DONE = "2026-10-05T09:00:00.000Z";
/** «Исправить исходные поля» of a saved merit of one or two recipients, with evaluation 1 and one date. */
async function savedMeritForm(hours: number[]) {
  mock = installMockTransport("chair", { delay: 0 });
  const [first, second] = mock.state.people.slice(0, 2).map(person => Number(person.user_id));
  const recipients = hours.map((value, index) => ({ user_id: [first, second][index], hours: value, evaluation: 1 as const, completed_at: DONE }));
  await seasonsApi.createMerit({ season_id: "season-1", source_kind: "chair_merit", title: "Сохранённая работа", description: richText("Работа"), assigned_at: "2026-10-01T10:00:00.000Z", deadline_at: "2026-10-10T10:00:00.000Z", criteria: emptyCriteria(), recipients });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits" });
  await waitForPage(page);await settle();
  const card = [...page.container.querySelectorAll("section")].find(section => section.querySelector("h2")?.textContent === "Сохранённая работа")!;
  const form = card.querySelector("form")!;
  const save = () => [...form.querySelectorAll("button")].find(button => button.textContent === "Сохранить исправление")!;
  return { first: String(first), second: String(second), form, save };
}
const patches = () => mock!.adapter.history.patch.filter(request => request.url?.startsWith("/merits/")).map(request => JSON.parse(request.data));

it("an existing merit is not saved again only because «Одинаково для всех» or «Поправить отдельно» was ticked", async () => {
  const { first, second, form, save } = await savedMeritForm([2, 2]);
  await change(field(form, "reason"), "Проверка");
  await change(field(form, "same_for_all"), "false");
  expect(save().disabled).toBe(true);
  await change(field(form, "same_for_all"), "true");
  expect(save().disabled).toBe(true);
  await change(field(form, `own_${second}`), "true");
  expect(save().disabled).toBe(true);
  await change(field(form, `own_${second}`), "false");
  await change(field(form, "common_hours"), "5");
  expect(save().disabled).toBe(false);
  await submit(form);await waitForPage(page!);
  expect(patches().at(-1)?.recipients.map((r: { user_id: number; hours: number }) => [String(r.user_id), r.hours])).toEqual([[first, 5], [second, 5]]);
});

it("an existing merit with different values per recipient keeps them when the box is ticked", async () => {
  const { second, form, save } = await savedMeritForm([2, 3]);
  await change(field(form, "reason"), "Проверка");
  await change(field(form, "same_for_all"), "true");
  expect(field(form, "common_hours").value).toBe("2");
  expect((field(form, `own_${second}`) as HTMLInputElement).checked).toBe(true);
  expect(field(form, `hours_${second}`).value).toBe("3");
  expect(save().disabled).toBe(true);
});

it("ticking and unticking the box on an existing merit keeps a value typed before", async () => {
  const { first, second, form } = await savedMeritForm([2, 2]);
  // The record opens with the box ticked (equal values): untick it to type one person's hours.
  await change(field(form, "same_for_all"), "false");
  await change(field(form, `hours_${first}`), "7");
  await change(field(form, "same_for_all"), "true");
  expect(field(form, "common_hours").value).toBe("7");
  expect(field(form, `hours_${second}`).value).toBe("2");
  await change(field(form, "same_for_all"), "false");
  expect([field(form, `hours_${first}`).value, field(form, `hours_${second}`).value]).toEqual(["7", "2"]);
  await change(field(form, "reason"), "Проверка");
  await submit(form);await waitForPage(page!);
  expect(patches().at(-1)?.recipients.map((r: { hours: number }) => r.hours)).toEqual([7, 2]);
});

it("removing a recipient of an existing merit with the box ticked saves the common values for the other", async () => {
  const { first, second, form } = await savedMeritForm([2, 2]);
  await change(field(form, "common_hours"), "5");
  await pick(form, "users", second, false);
  expect(field(form, `hours_${first}`).value).toBe("5");
  await change(field(form, "reason"), "Проверка");
  await submit(form);
  // Removing a saved recipient is confirmed first.
  await act(async () => [...form.querySelectorAll("button")].find(button => button.textContent === "Снять и сохранить")!.click());await waitForPage(page!);
  expect(patches().at(-1)?.recipients).toEqual([{ user_id: Number(first), hours: 5, evaluation: 1, completed_at: "2026-10-05T09:00:00.000Z" }]);
});

const box = (container: ParentNode = page!.container) => field(container, "same_for_all") as HTMLInputElement;

it("a new record with two recipients comes with «Одинаково для всех» ticked and its common block; one has no box", async () => {
  const { first, second } = await chairMeritForm();
  await pick(page!.container, "users", first);
  expect(shown("same_for_all")).toBe(false);
  expect(shown(`hours_${first}`)).toBe(true);
  await pick(page!.container, "users", second);
  expect(box().checked).toBe(true);
  for (const name of ["common_hours", "common_evaluation", "common_completed"]) expect(shown(name)).toBe(true);
  for (const name of [`hours_${first}`, `hours_${second}`, `evaluation_${second}`]) expect(shown(name)).toBe(false);
});

it("the box that turns on by itself starts from what the first recipient typed and saves it for both", async () => {
  const { first, second, form } = await chairMeritForm();
  await pick(page!.container, "users", first);
  for (const [name, value] of Object.entries({ [`hours_${first}`]: "2", [`evaluation_${first}`]: "1", [`completed_${first}`]: "2026-10-05T12:00" })) await change(field(page!.container, name), value);
  await pick(page!.container, "users", second);
  expect(["common_hours", "common_evaluation", "common_completed"].map(name => field(page!.container, name).value)).toEqual(["2", "1", "2026-10-05T12:00"]);
  await submit(form);await waitForPage(page!);
  expect(sentMerits()[0].recipients).toEqual([first, second].map(user => ({ user_id: Number(user), hours: 2, evaluation: 1, completed_at: DONE })));
});

it("a box the person unticked stays off when a third recipient is added", async () => {
  const { first, second } = await chairMeritForm();
  const third = String(mock!.state.people[2].user_id);
  await pick(page!.container, "users", first);await pick(page!.container, "users", second);
  expect(box().checked).toBe(true);
  await change(box(), "false");
  await pick(page!.container, "users", third);
  expect(box().checked).toBe(false);
  expect(shown("common_hours")).toBe(false);
  for (const user of [first, second, third]) expect(shown(`hours_${user}`)).toBe(true);
});

it("an existing record opens with the box ticked only when its recipients share hours, evaluation and date", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const [first, second] = mock.state.people.slice(0, 2).map(person => Number(person.user_id));
  const record = (title: string, hours: number[], completed: string[]) => seasonsApi.createMerit({ season_id: "season-1", source_kind: "chair_merit", title, description: richText("Работа"),
    assigned_at: "2026-10-01T10:00:00.000Z", deadline_at: "2026-10-10T10:00:00.000Z", criteria: emptyCriteria(),
    recipients: [first, second].map((user_id, index) => ({ user_id, hours: hours[index], evaluation: 1 as const, completed_at: completed[index] })) });
  await record("Одинаково", [2, 2], [DONE, DONE]);
  await record("Разные часы", [2, 3], [DONE, DONE]);
  await record("Разные даты", [2, 2], [DONE, "2026-10-06T09:00:00.000Z"]);
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits" });
  await waitForPage(page);await settle();
  const form = (title: string) => [...page!.container.querySelectorAll("section")].find(section => section.querySelector("h2")?.textContent === title)!.querySelector("form")!;
  const same = form("Одинаково");
  expect(box(same).checked).toBe(true);
  expect(["common_hours", "common_evaluation", "common_completed"].map(name => field(same, name).value)).toEqual(["2", "1", "2026-10-05T12:00"]);
  expect(same.querySelector(`[name="hours_${first}"]`)).toBeNull();
  // Opening ticked changes no value: there is nothing to save yet.
  await change(field(same, "reason"), "Проверка");
  expect([...same.querySelectorAll("button")].find(button => button.textContent === "Сохранить исправление")!.disabled).toBe(true);
  // Values that differ stay in sight: the box opens unticked.
  for (const [title, hours, date] of [["Разные часы", ["2", "3"], "2026-10-05T12:00"], ["Разные даты", ["2", "2"], "2026-10-06T12:00"]] as const) {
    const differ = form(title);
    expect(box(differ).checked).toBe(false);
    expect(differ.querySelector('[name="common_hours"]')).toBeNull();
    expect([field(differ, `hours_${first}`).value, field(differ, `hours_${second}`).value]).toEqual(hours);
    expect(field(differ, `completed_${second}`).value).toBe(date);
  }
});

it("an existing record of one recipient has no box until a second recipient is added", async () => {
  const { first, form } = await savedMeritForm([2]);
  const second = String(mock!.state.people[1].user_id);
  expect(form.querySelector('[name="same_for_all"]')).toBeNull();
  expect(field(form, `hours_${first}`).value).toBe("2");
  await pick(form, "users", second);
  expect(box(form).checked).toBe(true);
  expect(field(form, "common_hours").value).toBe("2");
});
