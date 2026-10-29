// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle } from "../../test/workspace";
import { createFixtures } from "../../mocks/fixtures";
import { DashboardPage } from "./WorkspacePages";
import { EventPage } from "./EventPages";
import { workspaceApi } from "../../utils/api/workspace.api";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

const links = (root: ParentNode) => Array.from(root.querySelectorAll("a")).map((a) => a.textContent);

it("the personal home uses server-authorized approvals without inferring them from a role", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const plain = { ...createFixtures("organizer").session, capabilities: [], assignments: [] };
  mock.state.requests = [];
  page = await mountWorkspace(<DashboardPage />, { role: "organizer", session: plain });
  await settle(); await settle();
  expect(page.container.querySelector('a[href="/tasks?mine=true"]')?.textContent).toBe("Мои задачи");
  expect(page.container.textContent).not.toContain("Требуют решения");
  expect(links(page.container)).not.toContain("Рассмотреть заявки");
  await page.cleanup(); mock.restore();

  // A block master, as the server describes one: a role in a block, no global rights.
  mock = installMockTransport("organizer", { delay: 0 });
  mock.state.requests = [];
  const master = { ...plain, assignments: [{ role_assignment_id: "master-it", role: "master", scope_kind: "block" as const, scope_id: "block-it", revision: 1, capabilities: [] }] };
  const home = await workspaceApi.home();
  vi.spyOn(workspaceApi, "home").mockResolvedValue({ ...home, approvals: [{ kind: "block_requests", title: "Заявки в блоки", count: 2, to: "/blocks/requests" }] });
  page = await mountWorkspace(<DashboardPage />, { role: "organizer", session: master });
  await settle(); await settle();
  expect(page.container.textContent).not.toContain("Требуют решения");
  expect(page.container.textContent).toContain("Рабочее пространство");
  expect(page.container.querySelector('a[href="/blocks/requests"]')?.textContent).toContain("Заявки в блоки");
  expect(page.container.textContent).toContain("Требует решения");
});

it("an event page links its reports only for who may read or write one", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const event = mock.state.events[0];
  event.capabilities = event.capabilities.filter((c) => c !== "create_report");
  const published = mock.state.reports.filter((r) => r.owner_id === event.event_id);
  mock.state.reports = mock.state.reports.filter((r) => r.owner_id !== event.event_id);
  const mount = async () => {
    page = await mountWorkspace(<Routes><Route path="/events/:id" element={<EventPage />} /></Routes>, { role: "organizer", path: `/events/${event.event_id}` });
    await settle(); await settle();
  };
  await mount();
  expect(page!.container.textContent).toContain(event.title);
  expect(links(page!.container)).not.toContain("Отчёты");
  await page!.cleanup();

  mock.state.reports.push(...(published.length ? published : [{ ...mock.state.reports[0], owner_kind: "event" as const, owner_id: event.event_id, state: "published" as const }]));
  await mount();
  expect(links(page!.container)).toContain("Отчёты");
});
