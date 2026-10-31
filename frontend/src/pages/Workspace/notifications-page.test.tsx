// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { workspaceApi } from "../../utils/api/workspace.api";
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
