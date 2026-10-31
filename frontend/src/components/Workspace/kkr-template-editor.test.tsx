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
const button = (name: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!;

it("closes the editor with a status after creating a template instead of a false version conflict", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const items: KkrTemplate[] = [];
  vi.spyOn(profileFeaturesApi, "templates").mockImplementation(async () => ({ items: structuredClone(items) }));
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  const create = vi.spyOn(profileFeaturesApi, "createTemplate").mockImplementation(async data => {
    const saved: KkrTemplate = { template_id: "new", visibility: "personal", scope: null, revision: 1, archived: false, values: data.values };items.push(saved);return saved;
  });
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  expect(page.container.textContent).toContain("Пока нет доступных шаблонов.");
  await act(async () => button("Создать шаблон ККР").click());await waitForPage(page);
  // The editor sits above the list with a normal «Закрыть»; the empty state waits for the editor to close.
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
  const row: KkrTemplate = { template_id: "saved", visibility: "personal", scope: null, revision: 3, archived: false, values: { title: "Точная оценка", description: "Текст", hours: 7, evaluation: 1.5, criteria: emptyCriteria() } };
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [row] });
  vi.spyOn(profileFeaturesApi, "context").mockResolvedValue(context);
  vi.spyOn(profileFeaturesApi, "updateTemplate").mockImplementation(async (template, values) => ({ ...template, revision: template.revision + 1, values }));
  page = await mountWorkspace(<KkrTemplateLibrary embedded />);await waitForPage(page);
  await act(async () => button("Изменить шаблон").click());await waitForPage(page);
  await change(field(page.container, "hours"), "8");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(page.container.querySelector('section[aria-label="Изменение шаблона ККР"] form')).not.toBeNull();
  expect(page.container.textContent).not.toContain("Запись изменилась на сервере");
});
