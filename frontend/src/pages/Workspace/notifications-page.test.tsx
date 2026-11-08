// @vitest-environment jsdom
import { readFileSync } from "node:fs";
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
  // Its keyboard ring is the site's, as on the links beside it, not the browser's default one.
  const css = readFileSync(`${__dirname}/Notifications.module.css`, "utf8");
  expect(css.match(/(?:^|\n)([^{}]*\.text:focus-visible[^{}]*)\{([^}]*)\}/)?.[2]).toMatch(/outline:\s*2px solid var\(--primary\);[\s\S]*outline-offset:\s*2px/);
});
it("lays a service-account sign-in out as in the bell: its title, then its facts in place of the date (owner 2026-11-08, variant Б)", async () => {
  const year = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", year: "numeric" }).format(Date.now());
  const at = `${year}-11-08T02:42:00Z`, last = `${year}-11-08T02:51:00Z`;
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.notifications = [
    { id: "failed", kind: "service_login_failed", text: "Неудачные попытки входа в сервисный аккаунт (4 подряд): …", created_at: last, read_at: null, target: null,
      details: { at: last, ip: "127.0.0.1", browser: "Firefox 132, Windows", failures: 4 } },
    { id: "login", kind: "service_login", text: "Вход в сервисный аккаунт: …", created_at: at, read_at: "2026-11-08T03:00:00Z", target: null,
      details: { at, ip: "127.0.0.1", browser: "Chrome 131, macOS", failures: null } },
    { id: "older", kind: "service_login", text: "Вход в сервисный аккаунт: 01.11.2026 10:00 МСК, IP 10.0.0.1, Safari 18, macOS", created_at: `${year}-11-01T07:00:00Z`, read_at: "2026-11-01T07:05:00Z", target: null, details: null },
  ];
  page = await mountWorkspace(<Routes><Route path="/notifications" element={<NotificationsPage />} /></Routes>, { path: "/notifications" });await waitForPage(page);
  const [failed, login, older] = [...rows()];
  const title = (row: Element) => row.querySelector<HTMLElement>('[tabindex="-1"] > span')!, facts = (row: Element) => row.querySelector("small")!;
  expect(title(failed).textContent).toBe("Неудачные попытки входа в сервисный аккаунт · 4 подряд");expect(title(failed).hasAttribute("data-failed")).toBe(true);
  expect(title(failed).querySelector('[data-icon="error"]')?.getAttribute("aria-hidden")).toBe("true");
  expect(facts(failed).textContent).toBe("последняя 8\u00a0ноября, 05:51 · IP 127.0.0.1 · Firefox 132, Windows");expect(facts(failed).querySelector("time")?.getAttribute("dateTime")).toBe(last);
  expect(title(login).textContent).toBe("Вход в сервисный аккаунт");expect(title(login).querySelector('[data-icon="security"]')).not.toBeNull();expect(title(login).hasAttribute("data-failed")).toBe(false);
  expect(facts(login).textContent).toBe("8\u00a0ноября, 05:42 · IP 127.0.0.1 · Chrome 131, macOS");
  // The date is said once, and the read controls stay as on any other notice.
  expect(failed.textContent).not.toContain("г.,");expect(failed.textContent).toContain("Новое");expect(button("Отметить прочитанным")).toBeDefined();
  // An older notice without facts reads as before.
  expect(older.querySelector('[tabindex="-1"]')?.textContent).toBe("Вход в сервисный аккаунт: 01.11.2026 10:00 МСК, IP 10.0.0.1, Safari 18, macOS");
  expect(older.querySelector("[data-failed], [data-icon]")).toBeNull();expect(facts(older).querySelector("time")?.getAttribute("dateTime")).toBe(`${year}-11-01T07:00:00Z`);
});
