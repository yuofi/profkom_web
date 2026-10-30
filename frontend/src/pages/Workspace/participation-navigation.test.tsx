// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle } from "../../test/workspace";
import { CalendarPage, DashboardPage, NotificationsPage } from "./WorkspacePages";
import { SECTIONS, sectionOf } from "../../components/Workspace/sections";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; });

it("pages a large personal team list without the removed team filters and duplicate top links", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const prototype = mock.state.blocks[0];
  const member = prototype.members[0];
  mock.state.blocks = Array.from({ length: 22 }, (_, index) => ({
    ...structuredClone(prototype), block_id: `own-${index}`, name: `Команда ${String(index + 1).padStart(2, "0")}`,
    master: null, members: [{ ...member, user: { ...member.user, user_id: mock!.state.session.user_id } }],
  }));
  page = await mountWorkspace(<DashboardPage />);
  await settle(); await settle();
  const ownLinks = () => page!.container.querySelectorAll('a[href^="/blocks/own-"]');
  expect(ownLinks()).toHaveLength(8);
  expect(page.container.textContent).toContain("1 из 3");
  const next = Array.from(page.container.querySelectorAll("button")).find((button) => button.textContent === "Далее")!;
  await act(async () => next.click());
  expect(page.container.textContent).toContain("2 из 3");
  expect(ownLinks()[0].textContent).toBe("Команда 09");
  expect(page.container.querySelector('section[class*="myTeams"] input')).toBeNull();
  expect(page.container.querySelector('section[class*="myTeams"] select')).toBeNull();
  expect(page.container.querySelector('nav[aria-label="Быстрые переходы"]')).toBeNull();
  expect(page.container.textContent).not.toContain("Учёт выполненной работы");
});

it("a global administrator without personal assignments gets honest empty states", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.blocks.forEach((block) => { block.master = null; block.members = []; });
  mock.state.events.forEach((event) => { event.leaders = []; });
  mock.state.subevents.forEach((subevent) => { subevent.leaders = []; subevent.organizer_user_ids = []; });
  page = await mountWorkspace(<DashboardPage />);
  await settle(); await settle();
  expect(page.container.textContent).toContain("Вы пока не участвуете в блоках");
  expect(page.container.textContent).toContain("Вы пока не участвуете в мероприятиях");
  expect(page.container.textContent).not.toContain("Все блоки и мероприятия");
  expect(page.container.querySelector('a[href^="/events/event-"]')).toBeNull();
});

it("uses one menu profile entry and leaves resource sections at the bottom", () => {
  expect(SECTIONS.some((section) => section.to === "/profile")).toBe(false);
  expect(SECTIONS.slice(-3).map((section) => section.to)).toEqual(["/blocks", "/materials", "/pgas"]);
  expect(sectionOf("/profile/edit").label).toBe("Мой профиль");
});

it("reads a notification when its source opens", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  mock.state.notifications = [{ id: "notice-open", kind: "task_assignment", text: "Назначена работа", created_at: "2026-10-26T10:00:00Z", read_at: null, target: { kind: "task", id: "task-open" } }];
  page = await mountWorkspace(<Routes>
    <Route path="/notifications" element={<NotificationsPage />} />
    <Route path="/tasks/:id" element={<p>Открытая задача</p>} />
  </Routes>, { role: "organizer", path: "/notifications" });
  await settle(); await settle();
  const link = Array.from(page.container.querySelectorAll("a")).find((a) => a.textContent === "Перейти к источнику")!;
  await act(async () => link.click());
  await settle(); await settle();
  expect(page.container.textContent).toContain("Открытая задача");
  expect(mock.state.notifications[0].read_at).not.toBeNull();
});

it("calendar meeting links open the concrete meeting, and arrows select another month", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const now = new Date().toISOString();
  const meeting = mock.state.meetings[0];
  meeting.starts_at = now;
  mock.state.seasons.forEach((season) => { if (season.state === "closed") season.state = "open"; });
  page = await mountWorkspace(<CalendarPage />);
  await settle(); await settle();
  const expected = `/meetings/${meeting.owner_kind}/${meeting.owner_id}`;
  expect(page.container.querySelector(`a[href="${expected}"]`)).not.toBeNull();
  const title = () => page!.container.querySelector('[aria-live="polite"]')?.textContent;
  const original = title();
  const next = page.container.querySelector<HTMLButtonElement>('button[aria-label="Следующий месяц"]')!;
  await act(async () => next.click()); await settle();
  expect(title()).not.toBe(original);
  const previous = page.container.querySelector<HTMLButtonElement>('button[aria-label="Предыдущий месяц"]')!;
  await act(async () => previous.click()); await settle();
  expect(title()).toBe(original);
});
