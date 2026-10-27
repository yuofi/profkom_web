// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationBell } from "./NotificationBell";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { UnsavedChangesProvider } from "./UnsavedChanges";
import { ActionForm } from "./ActionForm";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, waitForPage } from "../../test/workspace";
import { workspaceApi } from "../../utils/api/workspace.api";
import { SessionContext } from "../../utils/session";
import { ApiError } from "../../utils/api/request";
import { Routes, Route } from "react-router-dom";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const trigger = () => page!.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const panel = () => document.querySelector<HTMLElement>('[data-anchored-popover]');
const region = () => document.querySelector<HTMLElement>('[aria-label="Список уведомлений"]')!;
async function open() { await act(async () => { trigger().focus();trigger().click(); });await waitForPage(page!); }
function seed() {
  mock = installMockTransport("chair", { delay: 0 });mock.state.notifications = [
    { id: "notice-1", kind: "task_assignment", text: "Первая новая работа", created_at: "2026-10-27T11:00:00Z", read_at: null, target: { kind: "task", id: "task-1" } },
    { id: "notice-2", kind: "task_status", text: "Уже прочитанная работа", created_at: "2026-10-27T10:00:00Z", read_at: "2026-10-27T10:05:00Z", target: { kind: "task", id: "task-2" } },
  ];return mock;
}
it("replaces the sidebar notification link with one global bell and an exact unread count", async () => {
  seed();page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/" element={<h1>Рабочее пространство</h1>} /></Route></Routes>);await waitForPage(page);
  expect(page.container.querySelectorAll('nav[aria-label="Основная навигация"] a[href="/notifications"]')).toHaveLength(0);expect(page.container.querySelectorAll('button[aria-haspopup="dialog"]')).toHaveLength(1);expect(trigger().getAttribute("aria-label")).toBe("Уведомления, непрочитанных: 1");expect(trigger().textContent).toContain("1");expect(panel()).toBeNull();
});
it("opens a compact portal, supports record keyboard navigation and restores bell focus", async () => {
  seed();page = await mountWorkspace(<div style={{ overflow: "hidden" }}><NotificationBell /></div>);await waitForPage(page);await open();expect(panel()?.closest('[style="overflow: hidden;"]')).toBeNull();expect(panel()?.getAttribute("aria-modal")).toBe("false");expect(document.activeElement).toBe(region());
  await act(async () => region().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));expect(document.activeElement?.textContent).toContain("Первая новая работа");await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));expect(document.activeElement?.textContent).toContain("Уже прочитанная работа");await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));expect(panel()).toBeNull();expect(document.activeElement).toBe(trigger());
  await open();await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));expect(panel()).toBeNull();
});
it("marks every notification read using the existing command and refreshes the shared counter", async () => {
  seed();const read = vi.spyOn(workspaceApi, "readAll");page = await mountWorkspace(<NotificationBell />);await waitForPage(page);await open();const all = [...panel()!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Прочитать все")!;
  await act(async () => { all.focus();all.click(); });await waitForPage(page);expect(read).toHaveBeenCalledTimes(1);expect(trigger().getAttribute("aria-label")).toBe("Уведомления, непрочитанных: 0");expect(region().textContent).toContain("Первая новая работа");expect(document.activeElement).toBe(region());
});
it("keeps the exact accessible total when the visual badge is capped at 99+", async () => {
  const transport = seed(), template = transport.state.notifications[0];transport.state.notifications = Array.from({ length: 120 }, (_, index) => ({ ...template, id: `notice-${index}` }));page = await mountWorkspace(<NotificationBell />);await waitForPage(page);expect(trigger().getAttribute("aria-label")).toBe("Уведомления, непрочитанных: 120");expect(trigger().textContent).toContain("99+");
});
it("does not show cached notification text or a stale unread counter after a refusal", async () => {
  seed();const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });page = await mountWorkspace(<NotificationBell />, { client });await waitForPage(page);await open();expect(panel()?.textContent).toContain("Первая новая работа");vi.spyOn(workspaceApi, "notifications").mockRejectedValue(new ApiError("Доступ закрыт", 403));await act(async () => { await client.invalidateQueries({ queryKey: ["notifications"] }); });await waitForPage(page);
  expect(trigger().getAttribute("aria-label")).toBe("Уведомления");expect(panel()?.textContent).not.toContain("Первая новая работа");expect(panel()?.querySelector('[data-notification-id]')).toBeNull();expect(panel()?.querySelector('[role="alert"]')).not.toBeNull();
});
it("reads only after confirmed source navigation and preserves a cancelled editor exit", async () => {
  seed();const read = vi.spyOn(workspaceApi, "read"), container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><NotificationBell /><Outlet /></UnsavedChangesProvider>, children: [{ path: "/edit", element: <ActionForm fields={[{ name: "title", label: "Название", value: "Сохранено" }]} onSubmit={async () => {}} /> }, { path: "/tasks/task-1", element: <h1>Источник открыт</h1> }] }], { initialEntries: ["/edit"] });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: mock!.state.session, loading: false, error: null, refresh() {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  const cleanup = async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove(); };page = { container, client, cleanup };await waitForPage(page);await change(field(container, "title"), "Мой несохранённый текст");await open();
  const source = () => panel()!.querySelector<HTMLAnchorElement>('a[href="/tasks/task-1"]')!;await act(async () => source().click());await waitForPage(page);expect(router.state.location.pathname).toBe("/edit");expect(read).not.toHaveBeenCalled();
  const guardButton = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find(button => button.textContent === text)!;await act(async () => guardButton("Остаться").click());expect(read).not.toHaveBeenCalled();expect(field(container, "title").value).toBe("Мой несохранённый текст");expect(panel()).not.toBeNull();
  await act(async () => source().click());await act(async () => guardButton("Уйти без сохранения").click());await waitForPage(page);expect(router.state.location.pathname).toBe("/tasks/task-1");expect(read).toHaveBeenCalledExactlyOnceWith("notice-1");expect(panel()).toBeNull();expect(trigger().getAttribute("aria-label")).toBe("Уведомления, непрочитанных: 0");
});
it("handles an unavailable source honestly and allows explicit marking without navigation", async () => {
  const transport = seed();transport.state.notifications[0].target = null;const read = vi.spyOn(workspaceApi, "read");page = await mountWorkspace(<NotificationBell />);await waitForPage(page);await open();expect(panel()?.textContent).toContain("Источник больше недоступен");const mark = panel()!.querySelector<HTMLButtonElement>('button[aria-label="Отметить прочитанным: Первая новая работа"]')!;await act(async () => { mark.focus();mark.click(); });await waitForPage(page);expect(read).toHaveBeenCalledExactlyOnceWith("notice-1");expect(trigger().getAttribute("aria-label")).toBe("Уведомления, непрочитанных: 0");expect(document.activeElement).toBe(region());
});

it.each([
  { account_state: "pending" as const, registration_status: "pending" as const },
  { account_state: "active" as const, registration_status: "rejected" as const },
  { account_state: "archived" as const, registration_status: "approved" as const },
  { account_state: "active" as const, registration_status: "approved" as const, password_change_required: true },
])("never mounts a working bell or requests notices before active approval: %j", async state => {
  const transport = seed(), read = vi.spyOn(workspaceApi, "notifications"), client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });client.setQueryData(["notifications"], { items: transport.state.notifications, next_cursor: null });
  page = await mountWorkspace(<NotificationBell />, { client, session: { ...transport.state.session, ...state } });await waitForPage(page);expect(read).not.toHaveBeenCalled();expect(page.container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();expect(panel()).toBeNull();expect(page.container.textContent).not.toContain("Первая новая работа");
});

it.each(["control", "middle"] as const)("preserves %s source navigation and marks read without replacing the current page", async mode => {
  seed();const read = vi.spyOn(workspaceApi, "read");page = await mountWorkspace(<NotificationBell />);await waitForPage(page);await open();expect(read).not.toHaveBeenCalled();const source = panel()!.querySelector<HTMLAnchorElement>('a[href="/tasks/task-1"]')!;
  source.addEventListener(mode === "middle" ? "auxclick" : "click", event => event.preventDefault(), { once: true });
  await act(async () => source.dispatchEvent(new MouseEvent(mode === "middle" ? "auxclick" : "click", { bubbles: true, cancelable: true, button: mode === "middle" ? 1 : 0, ctrlKey: mode === "control" })));await waitForPage(page);expect(read).toHaveBeenCalledExactlyOnceWith("notice-1");expect(panel()).toBeNull();expect(trigger().getAttribute("aria-label")).toBe("Уведомления, непрочитанных: 0");
});
it("does not mark a notification read for an Alt-click that does not open the source", async () => {
  seed();const read = vi.spyOn(workspaceApi, "read");page = await mountWorkspace(<NotificationBell />);await waitForPage(page);await open();const source = panel()!.querySelector<HTMLAnchorElement>('a[href="/tasks/task-1"]')!;source.addEventListener("click", event => event.preventDefault(), { once: true });await act(async () => source.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true })));await waitForPage(page);expect(read).not.toHaveBeenCalled();expect(panel()).not.toBeNull();
});
