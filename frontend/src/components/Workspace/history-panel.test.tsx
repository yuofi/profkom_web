// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { historyApi, type HistoryEntry } from "../../utils/api/history.api";
import { people } from "../../mocks/fixtures";
import { ApiError } from "../../utils/api/request";
import { HistoryPanel } from "./HistoryPanel";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const entry = (): HistoryEntry => ({ id: "activity:edit", source_kind: "activity", source_id: "edit", target: { kind: "task", id: "task-1" }, changed_by: people[0], created_at: "2026-10-28T13:00:00Z", description: "Изменено описание", changes: [{ field: "description", label: "Описание", before: "Подготовить старую памятку", after: "Подготовить новую памятку" }], reason: null, hidden: false, hidden_by: null, hidden_at: null, revision: 1, can_hide: true });
it("shows the real actor and a literal word diff without rendering markup", async () => {
  const row = entry();row.changes[0].after = "Подготовить <img src=x onerror=alert(1)> памятку";
  vi.spyOn(historyApi, "list").mockResolvedValue({ items: [row], next_cursor: null });
  page = await mountWorkspace(<HistoryPanel kind="task" id="task-1" />);await waitForPage(page);
  expect(page.container.querySelector(`a[href="/contacts/${people[0].user_id}"]`)).not.toBeNull();
  expect(page.container.querySelector("del")?.textContent).toContain("старую");
  expect(page.container.querySelector("ins")?.textContent).toContain("<img");
  expect(page.container.querySelector('img[src="x"]')).toBeNull();
});
it("requires a deliberate hide confirmation then displays the permanent tombstone", async () => {
  let row = entry();
  vi.spyOn(historyApi, "list").mockImplementation(async () => ({ items: [row], next_cursor: null }));
  const hide = vi.spyOn(historyApi, "hide").mockImplementation(async () => { row = { ...row, hidden: true, hidden_by: people[1], hidden_at: "2026-10-28T14:00:00Z", changes: [], can_hide: false, revision: 2 };return { status: "hidden" }; });
  page = await mountWorkspace(<HistoryPanel kind="task" id="task-1" />);await waitForPage(page);
  const click = async (label: string) => { await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!.click());await waitForPage(page!); };
  await click("Скрыть версию");expect(hide).not.toHaveBeenCalled();
  await click("Подтвердить скрытие");expect(hide).toHaveBeenCalledTimes(1);
  expect(page.container.textContent).toContain("Версия скрыта");expect(page.container.textContent).toContain("Скрыл(а)");
  expect(page.container.textContent).not.toContain("старую памятку");expect(page.container.querySelector("del")).toBeNull();
});
it("removes all cached version text after current history access is revoked", async () => {
  const read = vi.spyOn(historyApi, "list").mockResolvedValue({ items: [entry()], next_cursor: null });
  page = await mountWorkspace(<HistoryPanel kind="task" id="task-1" />);await waitForPage(page);
  expect(page.container.textContent).toContain("старую");
  read.mockRejectedValue(new ApiError("Нет доступа", 404));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["history", "task", "task-1"] }); });await waitForPage(page);
  expect(page.container.textContent).not.toContain("старую");expect(page.container.querySelector("del")).toBeNull();
});
