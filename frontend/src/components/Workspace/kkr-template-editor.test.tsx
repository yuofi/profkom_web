// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { installMockTransport } from "../../mocks/transport";
import { profileFeaturesApi, type FeaturesContext, type KkrTemplate } from "../../utils/api/profileFeatures.api";
import { emptyCriteria } from "../../utils/api/contract";
import { KkrTemplateLibrary } from "./KkrTemplateLibrary";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const context: FeaturesContext = { award_scopes: [], award_icons: [], can_create_personal_template: true, template_scopes: [
  { kind: "subevent", id: "sub-1", name: "Секция 1" }, { kind: "block", id: "block-it", name: "IT" }, { kind: "event", id: "event-1", name: "День математика" },
] };
const author = { user_id: 101, display_name: "Анна Смирнова", avatar_url: null }, editor = { user_id: 102, display_name: "Борис Петров", avatar_url: null };
const button = (name: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!;

it("closes the editor with a status after creating a template instead of a false version conflict", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const items: KkrTemplate[] = [];
  vi.spyOn(profileFeaturesApi, "templates").mockImplementation(async () => ({ items: structuredClone(items) }));
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  const create = vi.spyOn(profileFeaturesApi, "createTemplate").mockImplementation(async data => {
    const saved: KkrTemplate = { template_id: "new", visibility: "personal", scope: null, revision: 1, archived: false, values: data.values, author, updated_by: author };items.push(saved);return saved;
  });
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  expect(page.container.textContent).toContain("Пока нет доступных шаблонов.");
  await act(async () => button("Создать шаблон ККР").click());await waitForPage(page);
  // A new template opens as a card at the top of the list with a normal «Закрыть»; the empty state waits for it to close.
  expect(page.container.querySelector('section[aria-label="Новый шаблон ККР"] button')?.textContent).toBe("Закрыть");
  expect(page.container.textContent).not.toContain("Пока нет доступных шаблонов.");
  expect(page.container.querySelector('[data-entity-picker][data-field-name="visibility"]')).not.toBeNull();
  await change(field(page.container, "title"), "Проверка зала");await change(field(page.container, "hours"), "2");
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(create).toHaveBeenCalledTimes(1);
  expect(page.container.querySelector("form")).toBeNull();
  expect(page.container.querySelector('[role="status"]')?.textContent).toBe("Шаблон создан: Проверка зала");
  expect(page.container.textContent).not.toContain("Запись изменилась на сервере");
});

it("offers team scopes in a searchable picker, blocks first, each named with its kind", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [] });
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  await act(async () => button("Создать шаблон ККР").click());await waitForPage(page);
  const input = page.container.querySelector<HTMLInputElement>('[data-field-name="visibility"] [role="combobox"]')!;
  await act(async () => { input.focus();input.click(); });await waitForPage(page);
  const options = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(option => option.textContent?.replace("✓", ""));
  expect(options.slice(1)).toEqual(["IT", "День математика", "Секция 1"]);
  // The fields of one kind share rows: hours with the evaluation, the yes/no criteria together.
  expect([...page.container.querySelectorAll<HTMLSelectElement>('select[name="evaluation"] option')].map(option => option.textContent)).toContain("Зачесть · оценка 1,5");
});

it("keeps template values the user typed when a template stays open after an edit", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const row: KkrTemplate = { template_id: "saved", visibility: "personal", scope: null, revision: 3, archived: false, values: { title: "Точная оценка", description: "Текст", hours: 7, evaluation: 1.5, criteria: emptyCriteria() }, author, updated_by: author };
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [row] });
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  vi.spyOn(profileFeaturesApi, "updateTemplate").mockImplementation(async (template, values) => ({ ...template, revision: template.revision + 1, values }));
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  await act(async () => button("Изменить шаблон").click());await waitForPage(page);
  await change(field(page.container, "hours"), "8");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(page.container.querySelector('section[aria-label="Изменение шаблона ККР"] form')).not.toBeNull();
  expect(page.container.textContent).not.toContain("Запись изменилась на сервере");
});

it("names the author of each template and, once it was changed, who saved it last; no creation date", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const values = { title: "Дежурство", description: "", hours: 2, evaluation: 1 as const, criteria: emptyCriteria() };
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [
    { template_id: "fresh", visibility: "personal", scope: null, revision: 1, archived: false, values, author, updated_by: author },
    { template_id: "edited", visibility: "personal", scope: null, revision: 4, archived: false, values: { ...values, title: "Встреча" }, author, updated_by: editor },
  ] });
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  const card = (title: string) => [...page!.container.querySelectorAll("strong")].find(node => node.textContent === title)!.parentElement!;
  expect(card("Дежурство").textContent).toContain("Автор");expect(card("Дежурство").textContent).toContain("Анна Смирнова");
  expect(card("Дежурство").textContent).not.toContain("Изменил(а)");
  expect(card("Встреча").textContent).toContain("Изменил(а)");expect(card("Встреча").textContent).toContain("Борис Петров");
  expect(page.container.textContent).not.toMatch(/Создан/);
});

const values = { title: "Дежурство", description: "Смена у входа", hours: 2, evaluation: 1 as const, criteria: emptyCriteria() };
const personal = (id: string, title: string, extra: Partial<KkrTemplate> = {}): KkrTemplate => ({ template_id: id, visibility: "personal", scope: null, revision: 1, archived: false, values: { ...values, title }, author, updated_by: author, ...extra });
const cards = () => [...page!.container.querySelectorAll<HTMLElement>("strong, section h3")].map(node => node.textContent);

it("edits a template inside its own card, focused; a new template and a copy open as a card at the top", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [personal("a", "Первый"), personal("b", "Второй"), personal("c", "Третий")] });
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  const scroll = vi.fn();Element.prototype.scrollIntoView = scroll;
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  const card = (title: string) => [...page!.container.querySelectorAll("strong")].find(node => node.textContent === title)!.parentElement!;
  await act(async () => card("Второй").querySelector<HTMLButtonElement>("button")!.click());await waitForPage(page);
  // The second card turned into the form; the others keep their places.
  expect(cards()).toEqual(["Первый", "Изменение шаблона", "Третий"]);
  const form = page.container.querySelector<HTMLElement>('section[aria-label="Изменение шаблона ККР"]')!;
  expect(document.activeElement).toBe(form.querySelector('input[name="title"]'));
  expect((document.activeElement as HTMLInputElement).value).toBe("Второй");
  expect(scroll).toHaveBeenCalledTimes(1);
  await act(async () => button("Закрыть").click());await waitForPage(page);
  await act(async () => [...card("Третий").querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Копировать")!.click());await waitForPage(page);
  expect(cards()).toEqual(["Новый шаблон ККР", "Первый", "Второй", "Третий"]);
  expect((document.activeElement as HTMLInputElement).value).toBe("Третий · копия");
  expect(scroll).toHaveBeenCalledTimes(2);
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

it("filters the library on the page by words, team and kind; archived templates only on request", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [
    personal("own", "Ёлка во дворе"),
    personal("team", "Регистрация гостей", { visibility: "team", scope: { kind: "event", id: "event-1", name: "День математика" } }),
    personal("all", "Общий сбор", { visibility: "team", scope: { kind: "global", id: null, name: "Профком" }, values: { ...values, title: "Общий сбор", description: "Ёмкая работа" } }),
    personal("old", "Старый шаблон", { archived: true }),
  ] });
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  const titles = () => [...page!.container.querySelectorAll("strong")].map(node => node.textContent);
  const filters = page.container.querySelector<HTMLElement>('[role="group"][aria-label="Фильтры шаблонов"]')!;
  expect(titles()).toEqual(["Ёлка во дворе", "Регистрация гостей", "Общий сбор"]);
  expect([...filters.querySelectorAll("select")[0].querySelectorAll("option")].map(option => option.textContent)).toEqual(["Все команды", "Весь Профком", "Мероприятие: День математика"]);
  // «е» finds «ё», in the title and in the description.
  await change(filters.querySelector<HTMLInputElement>('input[type="search"]')!, "ем");
  expect(titles()).toEqual(["Общий сбор"]);
  await change(filters.querySelector<HTMLInputElement>('input[type="search"]')!, "елка");
  expect(titles()).toEqual(["Ёлка во дворе"]);
  await change(filters.querySelector<HTMLInputElement>('input[type="search"]')!, "");
  await change(filters.querySelectorAll("select")[0], "event:event-1");
  expect(titles()).toEqual(["Регистрация гостей"]);
  await change(filters.querySelectorAll("select")[0], "");
  await change(filters.querySelectorAll("select")[1], "personal");
  expect(titles()).toEqual(["Ёлка во дворе"]);
  await act(async () => filters.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(titles()).toEqual(["Ёлка во дворе", "Старый шаблон"]);
  await change(filters.querySelectorAll("select")[1], "team");
  await change(filters.querySelector<HTMLInputElement>('input[type="search"]')!, "нет такого");
  expect(page.container.textContent).toContain("Нет шаблонов по этим условиям.");
});
