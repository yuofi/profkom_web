// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle } from "../../test/workspace";
import { AdminPanel } from "../Admin/AdminPage";
import { ExtendedRoute } from "../Wrappers/wrappers";
import { BlocksPage, RegistrationsPage } from "./MembershipPages";
import { EventsListPage } from "./EventPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; restore?.(); restore = undefined; });

it.each([
  ["users", "Регистрации"], ["blocks", "Блоки"], ["events", "Мероприятия"],
])("A01: old admin/%s opens the current domain screen", async (tab, title) => {
  const mock = installMockTransport("chair", { delay: 0 }); restore = mock.restore;
  page = await mountWorkspace(
    <Routes>
      <Route element={<ExtendedRoute />}><Route path="/admin/:tab" element={<AdminPanel />} /></Route>
      <Route path="/registrations" element={<RegistrationsPage />} />
      <Route path="/blocks" element={<BlocksPage />} />
      <Route path="/events" element={<EventsListPage />} />
    </Routes>,
    { path: `/admin/${tab}` },
  );
  await settle(); await settle();
  expect(page.container.querySelector("h1")?.textContent).toContain(title);
  expect(page.container.textContent).not.toContain("Добавить блок");
  expect(mock.adapter.history.patch).toHaveLength(0);
  expect(mock.adapter.history.post).toHaveLength(0);
});
