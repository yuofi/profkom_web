// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { workspaceApi, type Workday } from "../../utils/api/workspace.api";
import { ApiError } from "../../utils/api/request";
import { DashboardPage } from "./WorkspacePages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const empty: Workday = { today: "2026-10-30", agenda: [], tasks: [], overdue_tasks: [], overdue_count: 0, undated_count: 2, approvals: [], merit_entries: [] };

it("keeps a real empty-day calendar beside deadline lists and personal teams below", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(workspaceApi, "home").mockResolvedValue(empty);
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  const day = page.container.querySelector('[role="region"][aria-label="Сегодняшний день"]')!;
  expect(day.querySelector('[aria-label="Календарь дня"]')).not.toBeNull();
  expect(day.querySelector('[aria-label="Шкала часов"]')?.children).toHaveLength(24);
  expect(day.querySelector('[class*="timelineScroller"]')).not.toBeNull();
  expect(page.container.querySelector('[aria-label="Задачи по срокам"]')?.textContent).toContain("Ближайшие задачи");
  expect(page.container.textContent).toContain("Просроченных задач нет.");
  expect(page.container.textContent).toContain("Нет задач с будущим дедлайном.");
  expect(page.container.textContent).toContain("Без срока: 2");
  const teams = page.container.querySelector('[aria-label="Работа и команды"]')!;
  expect(teams.querySelector('section[aria-label="Мои блоки"]')).not.toBeNull();
  expect(teams.querySelector('section[aria-label="Мои мероприятия"]')).not.toBeNull();
  expect([...page.container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toContain("/calendar?view=day&date=2026-10-30");
});

it("retains the watched-task request flag and only renders approvals returned by the server", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const get = vi.spyOn(workspaceApi, "home").mockImplementation(async watching => ({ ...empty, approvals: watching ? [{ kind: "queue_access", title: "Доступ в очередь подготовки", count: 3, to: "/tasks/queues/preparation" }] : [] }));
  page = await mountWorkspace(<DashboardPage />, { role: "organizer" });await waitForPage(page);
  expect(get).toHaveBeenLastCalledWith(false);
  expect(page.container.textContent).not.toContain("Требует решения");
  await act(async () => page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await waitForPage(page);
  expect(get).toHaveBeenLastCalledWith(true);
  expect(page.container.querySelector('a[href="/tasks/queues/preparation"]')?.textContent).toContain("Доступ в очередь подготовки");
  expect(page.container.querySelector('[aria-label="Задачи по срокам"]')?.textContent).not.toContain("Требует решения");
});

it("shows the compact accounting entry for explicit assignment capabilities and hides it from a plain reader", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  vi.spyOn(workspaceApi, "home").mockResolvedValue(empty);
  const plain = { ...createFixtures("organizer").session, capabilities: [], assignments: [] };
  page = await mountWorkspace(<DashboardPage />, { session: plain });await waitForPage(page);
  expect(page.container.querySelector('header a[href="/merits"]')).toBeNull();
  await page.cleanup();
  page = await mountWorkspace(<DashboardPage />, { session: { ...plain, assignments: [{ role_assignment_id: "scoped-head", role: "event_leader", scope_kind: "event", scope_id: "event-one", revision: 1, capabilities: ["create_head_merit"] }] } });await waitForPage(page);
  expect(page.container.querySelector('header a[href="/merits"]')?.textContent).toBe("Учёт работы");
});

it("leaves personal teams readable when the day request fails and offers a retry", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(workspaceApi, "home").mockRejectedValue(new ApiError("Не удалось загрузить день", 503, "unavailable"));
  page = await mountWorkspace(<DashboardPage />);await waitForPage(page);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Сервис временно недоступен");
  expect([...page.container.querySelectorAll("button")].some(button => button.textContent === "Обновить данные")).toBe(true);
  expect(page.container.querySelector('section[aria-label="Мои блоки"]')).not.toBeNull();
  expect(page.container.querySelector('[aria-label="Сегодняшний день"]')).toBeNull();
});
