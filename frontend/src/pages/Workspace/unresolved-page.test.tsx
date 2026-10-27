// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { directoryApi } from "../../utils/api/directory.api";
import { eventsApi } from "../../utils/api/events.api";
import { ApiError } from "../../utils/api/request";
import { workspaceQueryCache } from "../../utils/api/invalidation";
import type { AssessmentInputs, UnresolvedAssignment } from "../../utils/api/contract";
import { UnresolvedPage } from "./TaskPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const fixture = () => createFixtures("chair");
const item = (extra: Partial<UnresolvedAssignment> = {}): UnresolvedAssignment => ({ assignment: { ...fixture().tasks[0].assignments[0], revision: 2, capabilities: ["view_assessment_inputs", "reassign_assignment"], assignee_unavailable_reason: "left_scope", status: "needs_revision" }, task_id: "task-1", task_title: "Довести материал до публикации", season_id: "season-1", scope: { kind: "subevent", id: "subevent-1" }, deadline_at: "2026-10-29T10:00:00Z", ...extra });
async function mount(items: UnresolvedAssignment[], path = "/tasks/unresolved", role: "chair" | "organizer" = "chair") {
  vi.spyOn(tasksApi, "unresolved").mockResolvedValue({ items, next_cursor: null });
  page = await mountWorkspace(<Routes><Route path="/tasks/unresolved" element={<UnresolvedPage />} /></Routes>, { path, role });await waitForPage(page);return page;
}
async function click(label: string, root: ParentNode = page!.container) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);expect(button).toBeDefined();await act(async () => button!.click());await waitForPage(page!);
}
async function openReassign() {
  mock = installMockTransport("chair", { delay: 0 });
  const current = item();let version: AssessmentInputs = { ...fixture().assessments[0], assignment_id: current.assignment.assignment_id, revision: 7, workflow_revision: 7, workflow_status: "needs_revision" };
  vi.spyOn(tasksApi, "assessment").mockImplementation(async () => structuredClone(version));await mount([current]);
  await click("Переназначить");await waitForPage(page!, () => !!page!.container.querySelector('dialog [name="hours"]'));
  return { current, get version() { return version; }, setVersion: (next: AssessmentInputs) => { version = next; } };
}
it("renders a compact tracker table with genuine task/team links, profile chip and labelled private accounting state", async () => {
  const assessment = vi.spyOn(tasksApi, "assessment"), contacts = vi.spyOn(directoryApi, "contacts"), scope = vi.spyOn(eventsApi, "subevent");const row = item();await mount([row]);
  expect(page!.container.querySelector('a[href="/tasks"]')?.textContent).toBe("Профком ВМК · Трекер");expect(page!.container.querySelector('table[aria-label="Оставшаяся работа по назначениям"]')).not.toBeNull();expect(page!.container.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(page!.container.querySelector(`a[href="/tasks/${row.task_id}"]`)?.textContent).toBe(row.task_title);expect(page!.container.querySelector(`a[href="/contacts/${row.assignment.assignee.user_id}"]`)).not.toBeNull();expect(page!.container.querySelector(`a[href="/subevents/${row.scope.id}"]`)?.textContent).toBe("Подмероприятие");
  expect(page!.container.textContent).toContain("Учёт ККР");expect(page!.container.textContent).toContain("На доработке");expect(page!.container.textContent).toContain("Нет доступа к задаче");expect(page!.container.querySelector("form,dialog")).toBeNull();expect(assessment).not.toHaveBeenCalled();expect(contacts).not.toHaveBeenCalled();expect(scope).not.toHaveBeenCalled();
});
it("preserves the URL season filter and limits unavailable-only rows without losing other seasons in cache", async () => {
  const current = item();await mount([current, { ...item(), assignment: { ...current.assignment, assignment_id: "available", assignee_unavailable_reason: null } }, { ...item(), task_title: "Другой сезон", season_id: "season-other", assignment: { ...current.assignment, assignment_id: "other-season" } }], "/tasks/unresolved?season_id=season-1");
  expect(page!.container.querySelectorAll("tbody tr")).toHaveLength(2);expect(page!.container.textContent).not.toContain("Другой сезон");expect(page!.container.querySelector('a[href="/tasks/unresolved"]')?.textContent).toBe("Все сезоны");
  await act(async () => page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await waitForPage(page!);expect(page!.container.querySelectorAll("tbody tr")).toHaveLength(1);expect(page!.container.textContent).toContain("Назначений: 1");
});
it("hides all cached private rows and never queries the endpoint for a role without queue access", async () => {
  const client = new QueryClient({ queryCache: workspaceQueryCache(), defaultOptions: { queries: { retry: false, staleTime: Infinity } } });client.setQueryData(["tasks", "unresolved"], { items: [item()], next_cursor: null });const read = vi.spyOn(tasksApi, "unresolved");
  page = await mountWorkspace(<UnresolvedPage />, { role: "organizer", client });await waitForPage(page);expect(page.container.textContent).toContain("Нет доступа к очереди");expect(page.container.textContent).not.toContain(item().task_title);expect(page.container.querySelector("table,form,dialog")).toBeNull();expect(read).not.toHaveBeenCalled();
});
it("provides truthful empty/error states and a refused refresh drops both table and private editor", async () => {
  await mount([]);expect(page!.container.textContent).toContain("Оставшейся работы нет.");expect(page!.container.querySelector("table")).toBeNull();await page!.cleanup();page = undefined;vi.restoreAllMocks();
  const { current } = await openReassign();vi.mocked(tasksApi.unresolved).mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));await act(async () => page!.client.invalidateQueries({ queryKey: ["tasks", "unresolved"] }));await waitForPage(page!);expect(page!.container.querySelector('[role="alert"]')).not.toBeNull();expect(page!.container.textContent).not.toContain(current.task_title);expect(page!.container.querySelector("table,dialog")).toBeNull();
});
it("reassigns through an isolated dialog using the private input revision and exact negative-outcome payload", async () => {
  const { current } = await openReassign();const reassignment = vi.spyOn(tasksApi, "reassign").mockImplementation(async () => { vi.mocked(tasksApi.unresolved).mockResolvedValue({ items: [], next_cursor: null });return { previous_assignment: { ...current.assignment, status: "not_completed", revision: 3 }, assignment: { ...current.assignment, assignment_id: "replacement", status: "assigned", revision: 1 } }; });
  const form = page!.container.querySelector<HTMLFormElement>("dialog form")!;expect(page!.container.querySelector('dialog h2')?.textContent).toBe("Переназначить работу");expect(form.querySelector('[role="combobox"]')).not.toBeNull();expect(page!.container.querySelector('dialog [data-selected-value="101"]')).toBeNull();
  await change(field(form, "user"), "102");await change(field(form, "hours"), "4");await change(field(form, "outcome"), "-1");await change(field(form, "reason"), "Исполнитель больше не доступен");await submit(form);await waitForPage(page!, () => !page!.container.querySelector("dialog"));
  expect(reassignment).toHaveBeenCalledWith(current.assignment.assignment_id, { expected_revision: 7, new_assignee_user_id: 102, hours: 4, previous_outcome: "not_completed", evaluation: -1, reason: "Исполнитель больше не доступен" });expect(page!.container.textContent).toContain("Новое назначение создано");
});
it("a private-revision conflict preserves selected person, hours, reason and outcome until refresh and explicit consent", async () => {
  const state = await openReassign();const command = vi.spyOn(tasksApi, "reassign").mockRejectedValueOnce(new ApiError("Changed", 409, "revision_conflict")).mockImplementation(async () => { vi.mocked(tasksApi.unresolved).mockResolvedValue({ items: [], next_cursor: null });return { previous_assignment: { ...state.current.assignment, revision: 4 }, assignment: { ...state.current.assignment, assignment_id: "new", revision: 1 } }; });
  const form = page!.container.querySelector<HTMLFormElement>("dialog form")!;await change(field(form, "user"), "102");await change(field(form, "hours"), "5");await change(field(form, "outcome"), "cancelled");await change(field(form, "reason"), "Переоценить распределение");await submit(form);await waitForPage(page!);expect(command).toHaveBeenCalledTimes(1);
  state.setVersion({ ...state.version, revision: 8, workflow_revision: 8 });await click("Обновить данные", form);expect(field(form, "user").value).toBe("102");expect(field(form, "hours").value).toBe("5");expect(field(form, "reason").value).toBe("Переоценить распределение");await submit(form);expect(command).toHaveBeenCalledTimes(1);await click("Сохранить мой ввод с обновлённой версией", form);await submit(form);await waitForPage(page!, () => !page!.container.querySelector("dialog"));expect(command).toHaveBeenLastCalledWith(state.current.assignment.assignment_id, { expected_revision: 8, new_assignee_user_id: 102, hours: 5, previous_outcome: "cancelled", reason: "Переоценить распределение" });
});
it("a private terminal decision disables reassignment while retaining its unsaved draft for inspection", async () => {
  const state = await openReassign();const command = vi.spyOn(tasksApi, "reassign");const form = page!.container.querySelector<HTMLFormElement>("dialog form")!;await change(field(form, "hours"), "7");state.setVersion({ ...state.version, revision: 8, workflow_revision: 8, workflow_status: "accepted" });await act(async () => page!.client.invalidateQueries({ queryKey: ["assessments", state.current.assignment.assignment_id] }));await waitForPage(page!);
  expect(field(form, "hours").value).toBe("7");expect(form.querySelector('button[type="submit"]')?.matches(":disabled")).toBe(true);expect(page!.container.querySelector("dialog")?.textContent).toContain("больше нельзя переназначить");expect(command).not.toHaveBeenCalled();
});
it("read-only rows do not expose a reassignment action or request assessment inputs", async () => {
  const read = vi.spyOn(tasksApi, "assessment");const current = item();await mount([{ ...current, assignment: { ...current.assignment, capabilities: ["view_assessment_inputs"] } }]);expect(page!.container.textContent).toContain("Только просмотр");expect(page!.container.querySelector("button")).toBeNull();expect(read).not.toHaveBeenCalled();
});
