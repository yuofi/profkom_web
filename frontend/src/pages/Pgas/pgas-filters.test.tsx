// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PgasPage } from "./PgasPage";
import { pgasApi } from "../../utils/api/pgas.api";
import { mountWorkspace, waitForPage, change } from "../../test/workspace";
import type { PgasEntryOut } from "../../utils/api/types";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const entry = (id: number, year: number, half_year: 1 | 2 | null): PgasEntryOut => ({ entry_id: id, title: `Документ ${id}`, year, half_year, revision: 4, file_url: "/api/files/local", file_name: "local.pdf", file_type: "application/pdf", created_at: "2026-10-01T12:00:00Z", uploaded_by: null });
async function show(role: "chair" | "organizer" = "chair") {
  vi.spyOn(pgasApi, "getAll").mockResolvedValue([entry(1, 2026, 1), entry(2, 2026, 2), entry(3, 2025, 1), entry(4, 2025, null)]);
  page = await mountWorkspace(<PgasPage />, { role });await waitForPage(page);
  return page.container;
}
const titles = (container: HTMLElement) => [...container.querySelectorAll("tbody tr")].map(row => row.querySelector("td")!.textContent);

it("combines year and period filters in a flat table and retains unknown legacy periods", async () => {
  const container = await show();
  expect(container.querySelectorAll("tbody")).toHaveLength(1);
  expect(container.querySelectorAll('th[scope="colgroup"]')).toHaveLength(0);
  await change(container.querySelector<HTMLSelectElement>('[aria-label="Период документов"]')!, "1");
  expect(titles(container)).toEqual(["Документ 1", "Документ 3"]);
  await change(container.querySelector<HTMLSelectElement>('[aria-label="Год документов"]')!, "2026");
  expect(titles(container)).toEqual(["Документ 1"]);
  await change(container.querySelector<HTMLSelectElement>('[aria-label="Период документов"]')!, "unknown");
  expect(container.textContent).toContain("По выбранным фильтрам документов нет");
  await change(container.querySelector<HTMLSelectElement>('[aria-label="Год документов"]')!, "all");
  expect(titles(container)).toEqual(["Документ 4"]);
  expect(container.querySelector("tbody")!.textContent).toContain("Не указан");
});

it("does not expose period commands to a reader", async () => {
  const container = await show("organizer");
  expect(container.querySelector('[aria-label^="Изменить период"]')).toBeNull();
  expect(container.textContent).toContain("Январь–май");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
});

it("edits a captured revision and requires rereading after a conflict", async () => {
  const container = await show();
  let revision = 4;
  vi.mocked(pgasApi.getAll).mockImplementation(async () => [{ ...entry(1, 2026, 1), revision }]);
  const update = vi.spyOn(pgasApi, "period").mockImplementation(async (id, period, expected) => {
    if (expected === 4) { revision = 5;throw Error("Документ изменён другим пользователем"); }
    return { ...entry(id, 2026, period), revision: 6 };
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Изменить период документа «Документ 1»"]')!.click());
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const option = () => [...dialog().querySelectorAll("button")].find(button => button.textContent === "Июнь–декабрь")!;
  await act(async () => option().click());await waitForPage(page!);
  expect(update).toHaveBeenLastCalledWith(1, 2, 4);
  expect(dialog().querySelector('[role="alert"]')).not.toBeNull();
  expect(option().disabled).toBe(true);
  await act(async () => [...dialog().querySelectorAll("button")].find(button => button.textContent === "Перечитать данные")!.click());await waitForPage(page!);
  await act(async () => option().click());await waitForPage(page!);
  expect(update).toHaveBeenLastCalledWith(1, 2, 5);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
