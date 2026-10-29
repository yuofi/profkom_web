// @vitest-environment jsdom
import { act } from "react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { installMockTransport } from "../../mocks/transport";
import { profileFeaturesApi, type KkrTemplate, type TemplateSelection } from "../../utils/api/profileFeatures.api";
import { emptyCriteria } from "../../utils/api/contract";
import { NotificationPreferences } from "./NotificationPreferences";
import { ProfileActivity } from "./ProfileActivity";
import { ActionForm } from "./ActionForm";
import { KkrTemplateTools } from "./KkrTemplateLibrary";
import { ApiError } from "../../utils/api/request";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => { mock = installMockTransport("chair", { delay: 0 }); });
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });

it("persists independent channels/categories while explicitly leaving delivery disconnected", async () => {
  page = await mountWorkspace(<NotificationPreferences />);
  await waitForPage(page, () => !!page!.container.querySelector('input[aria-label="Изменения тикетов трекера: Почта"]'));
  expect(page.container.textContent).toContain("Отправка ещё не подключена");
  const checkbox = page.container.querySelector<HTMLInputElement>('input[aria-label="Изменения тикетов трекера: Почта"]')!;
  await act(async () => checkbox.click());
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await waitForPage(page, () => page!.container.textContent?.includes("Настройки сохранены") ?? false);
  const request = mock!.adapter.history.put.find(request => request.url === "/profile/me/notification-preferences")!;
  const sent = JSON.parse(request.data);
  expect(sent.expected_revision).toBe(1);
  expect(sent.preferences.tracker.email).toBe(true);
  expect(sent.preferences.pgas.email).toBe(false);
  expect(sent.preferences.applications.telegram).toBe(false);
});

it("shows public past roles of inaccessible teams without working links or made-up dates", async () => {
  vi.spyOn(profileFeaturesApi, "activity").mockResolvedValue({ items: [
    { scope: { kind: "subevent", id: "hidden-team", name: "Прежняя команда" }, role: "subevent_leader", started_at: "2025-01-01T00:00:00Z", ended_at: "2025-06-01T00:00:00Z", current: false, observed: false },
    { scope: { kind: "block", id: "legacy", name: "Блок без даты" }, role: "master", started_at: null, ended_at: null, current: true, observed: false },
  ] });
  page = await mountWorkspace(<ProfileActivity userId={101} />);
  await waitForPage(page, () => page!.container.textContent?.includes("Прежняя команда") ?? false);
  expect(page.container.textContent).toContain("Ответственный");
  expect(page.container.textContent).toContain("Дата начала неизвестна");
  expect(page.container.querySelector('a[href*="hidden-team"]')).toBeNull();
});

function TemplateForm() {
  const [selection, setSelection] = useState<TemplateSelection | null>(null);
  return <ActionForm fields={[{ name: "hours", label: "Часы", type: "number", value: "2" }, { name: "evaluation", label: "Оценка", value: "" }, { name: "completed", label: "Дата", value: "keep-date" }, { name: "reason", label: "Причина", value: "keep-reason" }]}
    beforeFields={form => <KkrTemplateTools form={form} mode="assessment" selection={selection} onSelection={setSelection} />} onSubmit={async () => {}} />;
}
const row: KkrTemplate = { template_id: "saved", visibility: "personal", scope: null, revision: 3, archived: false, values: { title: "Точная оценка", description: "Текст", hours: 7, evaluation: 1.5, criteria: emptyCriteria() } };

it("applying a template changes only the draft's assessment fields and never saves automatically", async () => {
  vi.spyOn(profileFeaturesApi, "templates").mockResolvedValue({ items: [row] });
  const prepare = vi.spyOn(profileFeaturesApi, "prepare").mockResolvedValue({ selection: { template_id: row.template_id, revision: row.revision }, values: row.values });
  page = await mountWorkspace(<TemplateForm />);
  await waitForPage(page);
  const search = page.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => { search.focus();search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await waitForPage(page, () => !!document.querySelector('[role="option"]'));
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
  await act(async () => Array.from(page!.container.querySelectorAll("button")).find(button => button.textContent === "Подставить шаблон")!.click());
  await waitForPage(page);
  expect(prepare).toHaveBeenCalledWith(row);
  expect(page.container.querySelector<HTMLInputElement>('input[name="hours"]')!.value).toBe("7");
  expect(page.container.querySelector<HTMLInputElement>('input[name="evaluation"]')!.value).toBe("1.5");
  expect(page.container.querySelector<HTMLInputElement>('input[name="completed"]')!.value).toBe("keep-date");
  expect(page.container.querySelector<HTMLInputElement>('input[name="reason"]')!.value).toBe("keep-reason");
  expect(mock!.adapter.history.patch).toHaveLength(0);
  expect(page.container.textContent).toContain("Проверьте поля и сохраните оценку");
});

it("denied profile history refresh removes cached past role information", async () => {
  const read = vi.spyOn(profileFeaturesApi, "activity").mockResolvedValue({ items: [{ scope: { kind: "event", id: "private", name: "Чувствительная история" }, role: "event_leader", started_at: null, ended_at: null, current: true, observed: false }] });
  page = await mountWorkspace(<ProfileActivity userId={101} />);
  await waitForPage(page, () => page!.container.textContent?.includes("Чувствительная история") ?? false);
  read.mockRejectedValue(new ApiError("Нет доступа", 403));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["profileActivity", 101] }); });
  await waitForPage(page);
  expect(page.container.textContent).not.toContain("Чувствительная история");
});
