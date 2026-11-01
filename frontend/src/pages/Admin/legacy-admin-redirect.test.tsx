// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { LegacyAdminRedirect } from "./LegacyAdminRedirect";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined; });
const where = () => page!.container.querySelector("h1")?.textContent;
const routes = <Routes>
  <Route path="/leadership" element={<LegacyAdminRedirect tab="leadership" fallback="/blocks" />} />
  <Route path="/registrations" element={<LegacyAdminRedirect tab="registrations" />} />
  <Route path="/admin/:tab" element={<h1>Кабинет</h1>} /><Route path="/blocks" element={<h1>Блоки</h1>} /><Route path="/" element={<h1>Главная</h1>} />
</Routes>;

it.each([
  ["chair", "/leadership", "Кабинет"], ["organizer", "/leadership", "Блоки"],
  ["chair", "/registrations", "Кабинет"], ["organizer", "/registrations", "Главная"],
] as const)("sends %s from %s to the tab only when it is visible (GL-31)", async (role, path, expected) => {
  mock = installMockTransport(role, { delay: 0 });
  page = await mountWorkspace(routes, { role, path });await waitForPage(page);
  expect(where()).toBe(expected);
});
