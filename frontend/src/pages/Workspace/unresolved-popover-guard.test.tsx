// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { SessionContext } from "../../utils/session";
import { tasksApi } from "../../utils/api/tasks.api";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { change, field, waitForPage } from "../../test/workspace";
import { UnresolvedPage } from "./TaskPages";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.();cleanup = undefined;vi.restoreAllMocks(); });
it("closing the anchored reassignment protects its own draft and never discards another editor", async () => {
  const transport = installMockTransport("chair", { delay: 0 }), task = transport.state.tasks[0], assignment = { ...task.assignments[0], capabilities: ["view_assessment_inputs", "reassign_assignment"] };
  vi.spyOn(tasksApi, "unresolved").mockResolvedValue({ items: [{ task_id: task.task_id, task_title: task.title, assignment, scope: { kind: "subevent", id: "subevent-1" }, scope_title: "Команда", season_id: task.season_id, deadline_at: task.deadline_at }], next_cursor: null });
  vi.spyOn(tasksApi, "assessment").mockResolvedValue({ ...transport.state.assessments[0], assignment_id: assignment.assignment_id, workflow_status: "assigned" });const command = vi.spyOn(tasksApi, "reassign");
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const router = createMemoryRouter([{ path: "/tasks/unresolved", element: <UnsavedChangesProvider><ActionForm fields={[{ name: "other", label: "Другой редактор" }]} onSubmit={async () => {}} /><UnresolvedPage /></UnsavedChangesProvider> }], { initialEntries: ["/tasks/unresolved"] });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: transport.state.session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  cleanup = async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove();transport.restore(); };
  const page = { client, container };await waitForPage(page);await change(field(container, "other"), "Сохранить чужой черновик");
  const open = async () => { await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Переназначить:"]')!.click());await waitForPage(page, () => !!document.querySelector('[data-anchored-popover] form')); };
  const outside = async () => { await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));await waitForPage(page); };
  await open();await outside();expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(container.querySelector("dialog")).toBeNull();expect(field(container, "other").value).toBe("Сохранить чужой черновик");
  await open();const form = document.querySelector<HTMLFormElement>('[data-anchored-popover] form')!;await change(field(form, "reason"), "Не терять причину переназначения");await outside();expect(container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");expect(form.isConnected).toBe(true);
  const dialogButton = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find(button => button.textContent === name)!;
  await act(async () => dialogButton("Остаться").click());expect(field(form, "reason").value).toBe("Не терять причину переназначения");await outside();await act(async () => dialogButton("Уйти без сохранения").click());await waitForPage(page);expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(field(container, "other").value).toBe("Сохранить чужой черновик");expect(command).not.toHaveBeenCalled();
});

it("keyboard filtering keeps a dirty reassignment until explicit discard, then hides the available row", async () => {
  const transport = installMockTransport("chair", { delay: 0 }), task = transport.state.tasks[0], assignment = { ...task.assignments[0], assignee_unavailable_reason: null, capabilities: ["view_assessment_inputs", "reassign_assignment"] };
  vi.spyOn(tasksApi, "unresolved").mockResolvedValue({ items: [{ task_id: task.task_id, task_title: task.title, assignment, scope: { kind: "subevent", id: "subevent-1" }, scope_title: "Команда", season_id: task.season_id, deadline_at: task.deadline_at }], next_cursor: null });
  vi.spyOn(tasksApi, "assessment").mockResolvedValue({ ...transport.state.assessments[0], assignment_id: assignment.assignment_id, workflow_status: "assigned" });const command = vi.spyOn(tasksApi, "reassign");
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const router = createMemoryRouter([{ path: "/tasks/unresolved", element: <UnsavedChangesProvider><UnresolvedPage /></UnsavedChangesProvider> }], { initialEntries: ["/tasks/unresolved"] });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: transport.state.session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  cleanup = async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove();transport.restore(); };
  const page = { client, container };await waitForPage(page);await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Переназначить:"]')!.click());await waitForPage(page, () => !!document.querySelector('[data-anchored-popover] form'));
  const form = document.querySelector<HTMLFormElement>('[data-anchored-popover] form')!;await change(field(form, "reason"), "Не терять черновик при фильтрации");
  const filter = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  // jsdom does not synthesize Space's default checkbox click. click() has no pointerdown,
  // so this exercises keyboard activation without the popover's outside-pointer handler.
  const space = async () => { await act(async () => { filter.focus();filter.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));filter.click();filter.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })); });await waitForPage(page); };
  const dialogButton = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find(button => button.textContent === name)!;
  await space();expect(container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");expect(form.isConnected).toBe(true);expect(filter.checked).toBe(false);
  await act(async () => dialogButton("Остаться").click());expect(field(form, "reason").value).toBe("Не терять черновик при фильтрации");expect(container.querySelectorAll("tbody tr")).toHaveLength(1);expect(filter.checked).toBe(false);
  await space();await act(async () => dialogButton("Уйти без сохранения").click());await waitForPage(page);expect(form.isConnected).toBe(false);expect(document.querySelector('[data-anchored-popover]')).toBeNull();expect(container.querySelectorAll("tbody tr")).toHaveLength(0);expect(filter.checked).toBe(true);expect(container.textContent).toContain("Оставшейся работы нет");expect(command).not.toHaveBeenCalled();
});
