// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, submit, waitForPage } from "../../test/workspace";
import { SessionContext } from "../../utils/session";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { TrackerTaskCreatePage } from "./TaskCreateForm";

let cleanup: (() => Promise<void>) | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await cleanup?.();cleanup = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
async function mount() {
  transport = installMockTransport("chair", { delay: 0 });
  const queue = { ...transport.state.queues[0], queue_id: "queue-blank", key: "BLANK", name: "Свободные задачи", scope: null, capabilities: ["create_task"] };
  vi.spyOn(taskQueuesApi, "catalog").mockResolvedValue({ items: [queue], next_cursor: null });
  vi.spyOn(taskQueuesApi, "get").mockResolvedValue(queue);
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [{ path: "/tasks", element: <p>Общий список задач</p> }, { path: "/tasks/new", element: <TrackerTaskCreatePage /> }, { path: "/tasks/queues/:id", element: <p>Страница очереди</p> }, { path: "/tasks/:id", element: <p>Созданная задача</p> }] }], { initialEntries: ["/tasks/new?queue_id=queue-blank"] });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: transport!.state.session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  cleanup = async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove(); };
  const page = { container, client, router };await waitForPage(page, () => !!container.querySelector("form"));return page;
}
function button(container: ParentNode, title: string) { return [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === title)!; }
it("an untouched new editor exits freely; typed Markdown is guarded and never published by cancelling", async () => {
  const page = await mount(), create = vi.spyOn(tasksApi, "create");
  const clean = new Event("beforeunload", { cancelable: true });window.dispatchEvent(clean);expect(clean.defaultPrevented).toBe(false);
  await change(field(page.container, "description"), "Несохранённый текст $x^2$");const dirty = new Event("beforeunload", { cancelable: true });window.dispatchEvent(dirty);expect(dirty.defaultPrevented).toBe(true);
  await act(async () => [...page.container.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent === "Отмена")!.click());
  expect(page.container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");expect(button(page.container, "Сохранить и перейти").disabled).toBe(true);
  await act(async () => button(page.container, "Остаться").click());expect(field(page.container, "description").value).toBe("Несохранённый текст $x^2$");
  await act(async () => [...page.container.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent === "Отмена")!.click());await act(async () => button(page.container, "Уйти без сохранения").click());
  expect(page.router.state.location.pathname).toBe("/tasks/queues/queue-blank");expect(create).not.toHaveBeenCalled();
});
it("a successful explicit create redirects without a stale unsaved-draft dialog", async () => {
  const page = await mount();vi.spyOn(tasksApi, "create").mockResolvedValue({ ...transport!.state.tasks[0], task_id: "created-task", scope: { kind: "queue", id: "queue-blank" }, assignees: [], assignments: [], watchers: [] });
  await change(field(page.container, "title"), "Создать без исполнителей");await change(field(page.container, "deadline"), "2026-10-29T18:00");await submit(page.container.querySelector("form")!);await waitForPage(page, () => page.router.state.location.pathname === "/tasks/created-task");
  expect(page.container.querySelector("dialog")).toBeNull();expect(page.container.textContent).toContain("Созданная задача");
});


it("the tracker stamp guards an unsaved task draft before returning to all tasks", async () => {
  const page = await mount(), create = vi.spyOn(tasksApi, "create");
  await change(field(page.container, "description"), "Не терять черновик задачи");
  const home = () => [...page.container.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent === "Профком ВМК · Трекер")!;
  expect(home().getAttribute("href")).toBe("/tasks");
  await act(async () => home().click());
  expect(page.router.state.location.pathname).toBe("/tasks/new");expect(page.container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");
  await act(async () => button(page.container, "Остаться").click());expect(field(page.container, "description").value).toBe("Не терять черновик задачи");
  await act(async () => home().click());await act(async () => button(page.container, "Уйти без сохранения").click());
  expect(page.router.state.location.pathname).toBe("/tasks");expect(page.container.textContent).toContain("Общий список задач");expect(create).not.toHaveBeenCalled();
});
