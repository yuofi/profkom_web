// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, pick, settle, submit, waitForPage } from "../../test/workspace";
import { MeritsPage } from "./MeritPages";
import { criteriaKeys, criteriaLabels } from "../../utils/kkrCriteria";
import { emptyCriteria } from "../../utils/api/contract";
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
  expect(boxes.map(box => box.checked)).toEqual([false, true, false, true, false]);
  await submit(form);await waitForPage(page);
  const sent = JSON.parse(mock.adapter.history.post.find(request => request.url === "/merits")!.data);
  expect(sent.criteria).toEqual({ unique: false, creative: true, external_communication: false, in_person: true, fixed_time: false });
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
  await change(field(page!.container, "same_for_all"), "true");
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
  await pick(page!.container, "users", first);await pick(page!.container, "users", second);
  await change(field(page!.container, `hours_${first}`), "2");
  await change(field(page!.container, "same_for_all"), "true");
  // The block starts from the first recipient's values.
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
  await change(field(page!.container, "same_for_all"), "true");
  await pick(page!.container, "kkr-template", template.template_id);
  await act(async () => [...page!.container.querySelectorAll("button")].find(button => button.textContent === "Подставить шаблон")!.click());await waitForPage(page!);
  expect([field(page!.container, "common_hours").value, field(page!.container, "common_evaluation").value]).toEqual(["4", "1.5"]);
});
