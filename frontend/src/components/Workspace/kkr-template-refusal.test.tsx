// @vitest-environment jsdom
// A save refused because of its applied template (B6, owner 2026-11-08): no «Отвязать шаблон»;
// the refusal offers the same save without the template and, for an edited template, its new version.
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { change, field, mountWorkspace, pick, settle, submit, waitForPage } from "../../test/workspace";
import { MeritsPage } from "../../pages/Workspace/MeritPages";
import { installMockTransport } from "../../mocks/transport";
import { profileFeaturesApi, type KkrTemplate, type TemplateSelection } from "../../utils/api/profileFeatures.api";
import { emptyCriteria } from "../../utils/api/contract";
import { ApiError } from "../../utils/api/request";
import { ActionForm } from "./ActionForm";
import type { Values } from "./formValues";
import { KkrTemplateTools, TemplateRefusal } from "./KkrTemplateLibrary";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => { mock = installMockTransport("chair", { delay: 0 }); });
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });

const owner = { user_id: 101, display_name: "Анна Смирнова", avatar_url: null };
const row: KkrTemplate = { template_id: "saved", visibility: "personal", scope: null, revision: 3, archived: false, values: { title: "Точная оценка", description: "Текст", hours: 7, evaluation: 1.5, criteria: emptyCriteria() }, author: owner, updated_by: owner };
const edited: KkrTemplate = { ...row, revision: 4, values: { ...row.values, hours: 9 }, updated_by: { ...owner, user_id: 102 } };

function Form({ sent, refuse }: { sent: { selection: TemplateSelection | null; values: Values }[]; refuse: (selection: TemplateSelection | null) => ApiError | null }) {
  const [selection, setSelection] = useState<TemplateSelection | null>(null);
  return <ActionForm fields={[{ name: "hours", label: "Часы", type: "number", value: "2" }, { name: "evaluation", label: "Оценка", value: "" }, { name: "reason", label: "Причина", value: "keep-reason" }]}
    beforeFields={form => <KkrTemplateTools form={form} mode="assessment" selection={selection} onSelection={setSelection} />}
    failureActions={(failure, form) => <TemplateRefusal failure={failure} form={form} mode="assessment" selection={selection} onSelection={setSelection} />}
    onSubmit={async (values) => { sent.push({ selection, values }); const refusal = refuse(selection); if (refusal) throw refusal; }} />;
}
const button = (text: string) => Array.from(page!.container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === text);
async function applyTemplate() {
  const search = page!.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => { search.focus();search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await waitForPage(page!, () => !!document.querySelector('[role="option"]'));
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
  await act(async () => button("Подставить шаблон")!.click());
  await waitForPage(page!);
}
const save = async () => { await act(async () => page!.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());await waitForPage(page!); };

it("has no «Отвязать шаблон»; a refused save goes on without the template with the same values", async () => {
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [row] });
  vi.spyOn(profileFeaturesApi, "prepare").mockResolvedValue({ selection: { template_id: row.template_id, revision: row.revision }, values: row.values });
  const sent: { selection: TemplateSelection | null; values: Values }[] = [];
  page = await mountWorkspace(<Form sent={sent} refuse={selection => selection ? new ApiError("Шаблон в архиве", 409, "template_archived") : null} />);
  await waitForPage(page);
  await applyTemplate();
  expect(button("Отвязать шаблон")).toBeUndefined();
  expect(page.container.textContent).toContain("Шаблон подставлен");
  await save();
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Шаблон перенесён в архив");
  // An archived template has no newer version to apply.
  expect(button("Подставить заново")).toBeUndefined();
  await act(async () => button("Сохранить без шаблона")!.click());
  await waitForPage(page, () => sent.length === 2);
  expect(sent.map(item => item.selection)).toEqual([{ template_id: "saved", revision: 3 }, null]);
  expect(sent[1].values).toEqual(sent[0].values);
  expect(sent[1].values.hours).toBe("7");
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
  expect(page.container.textContent).not.toContain("Шаблон подставлен");
});

it("a template edited after «Подставить» has its own text and can be applied again", async () => {
  const templates = vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [row] });
  const prepare = vi.spyOn(profileFeaturesApi, "prepare").mockImplementation(async template => ({ selection: { template_id: template.template_id, revision: template.revision }, values: template.values }));
  const sent: { selection: TemplateSelection | null; values: Values }[] = [];
  page = await mountWorkspace(<Form sent={sent} refuse={selection => selection?.revision === 3 ? new ApiError("Шаблон изменён", 409, "template_changed") : null} />);
  await waitForPage(page);
  await applyTemplate();
  templates.mockResolvedValue({ items: [edited] });
  await save();
  const alert = page.container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Шаблон изменили после того, как вы его подставили");
  // Not the record's version conflict: no «Обновить данные» here.
  expect(button("Обновить данные")).toBeUndefined();
  await act(async () => button("Подставить заново")!.click());
  await waitForPage(page, () => page!.container.textContent?.includes("Шаблон подставлен заново") ?? false);
  expect(prepare).toHaveBeenLastCalledWith(edited);
  expect(page.container.querySelector<HTMLInputElement>('input[name="hours"]')!.value).toBe("9");
  expect(page.container.querySelector<HTMLInputElement>('input[name="reason"]')!.value).toBe("keep-reason");
  // Nothing is saved until the person looks and saves.
  expect(sent).toHaveLength(1);
  await save();
  expect(sent.map(item => item.selection)).toEqual([{ template_id: "saved", revision: 3 }, { template_id: "saved", revision: 4 }]);
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
});

it("other refusals offer nothing about templates", async () => {
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [row] });
  vi.spyOn(profileFeaturesApi, "prepare").mockResolvedValue({ selection: { template_id: row.template_id, revision: row.revision }, values: row.values });
  const sent: { selection: TemplateSelection | null; values: Values }[] = [];
  page = await mountWorkspace(<Form sent={sent} refuse={() => new ApiError("Неверные данные", 422, "invalid_input")} />);
  await waitForPage(page);
  await applyTemplate();
  await save();
  expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button("Сохранить без шаблона")).toBeUndefined();
});

it("the merit form saves without a template edited after «Подставить», as the demo server refuses it", async () => {
  const created = await profileFeaturesApi.createTemplate({ visibility: "personal", values: { title: "Дежурство", description: "Смена у входа", hours: 3, evaluation: 1, criteria: { ...emptyCriteria(), in_person: true } } });
  page = await mountWorkspace(<Routes><Route path="/seasons/:id/merits" element={<MeritsPage />} /></Routes>, { path: "/seasons/season-1/merits?source_kind=chair_merit" });
  await waitForPage(page);await settle();
  const userId = String(mock!.state.people[0].user_id);
  await pick(page.container, "users", userId);
  await pick(page.container, "kkr-template", created.template_id);
  await act(async () => button("Подставить шаблон")!.click());await waitForPage(page);
  expect(field(page.container, `hours_${userId}`).value).toBe("3");
  await profileFeaturesApi.updateTemplate(created, { ...created.values, hours: 5 }, false);
  for (const [name, value] of Object.entries({ assigned: "2026-10-01T13:00", deadline: "2026-10-10T13:00", [`evaluation_${userId}`]: "0" })) await change(field(page.container, name), value);
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Шаблон изменили");
  await act(async () => button("Сохранить без шаблона")!.click());
  await waitForPage(page, () => mock!.adapter.history.post.filter(request => request.url === "/merits").length === 2);
  await waitForPage(page);
  const [first, second] = mock!.adapter.history.post.filter(request => request.url === "/merits").map(request => JSON.parse(request.data));
  expect(first.template_selection).toEqual({ template_id: created.template_id, revision: 1 });
  expect(second.template_selection).toBeUndefined();
  expect(second.recipients).toEqual(first.recipients);
  expect(mock!.state.merits.some(merit => merit.title === "Дежурство" && !("template_selection" in merit))).toBe(true);
});
