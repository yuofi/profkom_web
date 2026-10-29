// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { membershipApi } from "../../utils/api/membership.api";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import type { BlockRequest } from "../../utils/api/contract";
import { BlockRequestsPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
async function show(approvals: BlockRequest["approvals"]) {
  mock = installMockTransport("chair", { delay: 0 });
  const request: BlockRequest = { ...mock.state.requests[0], state: "approved", capabilities: [], approvals };
  vi.spyOn(membershipApi, "requests").mockResolvedValue({ items: [request], next_cursor: null });
  page = await mountWorkspace(<BlockRequestsPage />);await waitForPage(page);
  return page.container.querySelector('[aria-label="Одобрения заявки"]')!;
}
it("shows actual HR and block approvers separately using their profile links", async () => {
  const group = await show([
    { stage: "hr", actor: { user_id: 211, display_name: "Исторический HR", avatar_url: null }, at: "2026-10-20T10:00:00Z", substitute: false },
    { stage: "block", actor: { user_id: 212, display_name: "Фактический согласующий", avatar_url: null }, at: "2026-10-21T10:00:00Z", substitute: true },
  ]);
  expect(group.textContent).toContain("Этап HR");expect(group.textContent).toContain("Этап блока");expect(group.textContent).toContain("Подмена руководства");
  expect(group.querySelector('a[href="/contacts/211"]')?.textContent).toContain("Исторический HR");
  expect(group.querySelector('a[href="/contacts/212"]')?.textContent).toContain("Фактический согласующий");
});
it("shows a one-stage HR approval without inventing a block approver", async () => {
  const group = await show([{ stage: "hr", actor: { user_id: 211, display_name: "Согласовавший HR", avatar_url: null }, at: null, substitute: false }]);
  expect(group.textContent).toContain("Этап HR");expect(group.textContent).not.toContain("Этап блока");expect(group.textContent).toContain("Дата не записана");
});
it("preserves anonymous and unknown history without guessed people or broken profile links", async () => {
  const group = await show([
    { stage: "hr", actor: { user_id: null, display_name: "Анонимный участник", avatar_url: null }, at: null, substitute: false },
    { stage: "block", actor: null, at: null, substitute: false },
  ]);
  expect(group.textContent).toContain("Анонимный участник");expect(group.textContent).toContain("Автор неизвестен или архивирован");expect(group.querySelector("a")).toBeNull();
});
it("states when a legacy approved request has no saved approver", async () => {
  const group = await show([]);expect(group).toBeNull();
  expect(page!.container.textContent).toContain("Кто одобрил: сведения не сохранены.");
  expect(page!.container.querySelector('a[href^="/contacts/"]')).toBeNull();
});
