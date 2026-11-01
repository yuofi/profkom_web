// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, settle } from "../../test/workspace";
import { workspaceApi } from "../../utils/api/workspace.api";
import type { Notification } from "../../utils/api/contract";
import { NotificationsPage } from "./WorkspacePages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith(label));
const rows = () => page!.container.querySelectorAll("li[data-unread]");

it("shows compact rows a page at a time and filters the unread", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.notifications = Array.from({ length: 35 }, (_, index) => ({
    id: `notice-${String(index).padStart(2, "0")}`, kind: "task_assignment", text: `Работа ${index}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), read_at: index % 2 ? "2026-10-02T00:00:00Z" : null, target: { kind: "task", id: `task-${index}` },
  }));
  const list = vi.spyOn(workspaceApi, "notifications");
  page = await mountWorkspace(<Routes><Route path="/notifications" element={<NotificationsPage />} /></Routes>, { path: "/notifications" });await waitForPage(page);
  expect(rows()).toHaveLength(30);
  expect(rows()[0].textContent).toContain("Работа 34");expect(page.container.querySelector('a[href="/tasks/task-34"]')?.textContent).toBe("Работа 34");
  await act(async () => button("Показать ещё")!.click());await waitForPage(page);
  expect(rows()).toHaveLength(35);expect(button("Показать ещё")).toBeUndefined();
  expect(list).toHaveBeenLastCalledWith({ cursor: "30", limit: 30, unread: false });
  await act(async () => button("Непрочитанные")!.click());await waitForPage(page);
  expect(button("Непрочитанные")!.getAttribute("aria-pressed")).toBe("true");expect(list).toHaveBeenLastCalledWith({ cursor: null, limit: 30, unread: true });
  expect(rows()).toHaveLength(18);expect([...rows()].every(row => row.getAttribute("data-unread") === "true")).toBe(true);
  expect(button("Непрочитанные")!.textContent).toBe("Непрочитанные · 18");
});
/** 32 notices: «Показать ещё» reads the 2 oldest, held until `release`; `firstNew` is the first of them. */
async function loadLastPage(firstNew: Partial<Notification> = {}) {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.notifications = Array.from({ length: 32 }, (_, index) => ({
    id: `notice-${String(index).padStart(2, "0")}`, kind: "task_assignment", text: `Работа ${index}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), read_at: null, target: { kind: "task", id: `task-${index}` }, ...(index === 1 ? firstNew : {}),
  }));
  const original = workspaceApi.notifications;let release: () => void = () => {};
  const list = vi.spyOn(workspaceApi, "notifications").mockImplementation(async params => {
    if (params?.cursor) await new Promise<void>(resolve => { release = resolve; });
    return original(params);
  });
  page = await mountWorkspace(<Routes><Route path="/notifications" element={<NotificationsPage />} /></Routes>, { path: "/notifications" });await waitForPage(page);
  const more = button("Показать ещё")!;more.focus();await act(async () => more.click());await settle();
  expect(list).toHaveBeenCalledTimes(2);expect(list).toHaveBeenLastCalledWith({ cursor: "30", limit: 30, unread: false });
  // While the page loads the button reads as unavailable and ignores clicks, but stays enabled:
  // `disabled` on the focused button would drop the keyboard focus to <body>.
  expect(rows()).toHaveLength(30);expect(more.textContent).toBe("Загружаем…");expect(more.getAttribute("aria-disabled")).toBe("true");expect(more.disabled).toBe(false);expect(document.activeElement).toBe(more);
  await act(async () => more.click());await settle();expect(list).toHaveBeenCalledTimes(2);
  await act(async () => release());await waitForPage(page, () => rows().length === 32);
  expect(more.isConnected).toBe(false);expect(button("Показать ещё")).toBeUndefined();
}
it("keeps the keyboard focus on «Показать ещё» while it loads and then moves it to the first new row (smoke FV-2)", async () => {
  await loadLastPage();
  // The last page removes the button: its focus goes to the first row that page added.
  expect(document.activeElement?.textContent).toBe("Работа 1");expect(document.activeElement?.getAttribute("href")).toBe("/tasks/task-1");
});
it("moves the focus to the text of a new row that has no link and no action (smoke FV-2)", async () => {
  await loadLastPage({ target: null, read_at: "2026-10-02T00:00:00Z" });
  expect(document.activeElement?.tagName).toBe("SPAN");expect(document.activeElement?.textContent).toBe("Работа 1");expect(document.activeElement?.closest("li")).toBe(rows()[30]);
});
