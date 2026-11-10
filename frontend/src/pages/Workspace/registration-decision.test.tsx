// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { membershipApi } from "../../utils/api/membership.api";
import { RegistrationsPage } from "./MembershipPages";
import { AccountStatePage } from "./SessionPages";
import { RegistrationDecision } from "../../components/Workspace/RegistrationDecision";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const stamp = "2026-11-10T08:12:00+00:00";
const actor = { user_id: 77, display_name: "Проверяющий Тестовый", avatar_url: null };

it.each(["approved", "rejected"] as const)("shows %s decision without opening private application details", async status => {
  mock = installMockTransport("chair", { delay: 0 });
  const application = { ...mock.state.registration, status, decision: { outcome: status, actor, at: stamp } };
  vi.spyOn(membershipApi, "registrations").mockResolvedValue({ items: [application], next_cursor: null });
  page = await mountWorkspace(<RegistrationsPage />);await waitForPage(page);
  const decision = page.container.querySelector('[aria-label="Решение по заявке"]')!;
  expect(decision.textContent).toContain("Решение принял: Проверяющий Тестовый");
  expect(decision.textContent).toContain("11:12");expect(decision.textContent).toContain("МСК");
  expect(decision.querySelector("time")?.dateTime).toBe(stamp);
  expect(page.container.querySelector("details")?.open).toBe(false);
  expect(decision.querySelector("a, img")).toBeNull();
});

it("shows the saved reviewer to the rejected applicant without linking to staff profiles", async () => {
  mock = installMockTransport("rejected", { delay: 0 });
  mock.state.registration.decision = { outcome: "rejected", actor, at: stamp };
  page = await mountWorkspace(<AccountStatePage />, { role: "rejected" });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Решение по заявке"]')?.textContent).toContain(actor.display_name);
  expect(page.container.querySelector("a")).toBeNull();
});

it("does not invent historical data or keep a previous rejection on a resubmitted application", async () => {
  mock = installMockTransport("rejected", { delay: 0 });
  const application = { ...mock.state.registration, decision: null };
  page = await mountWorkspace(<RegistrationDecision application={application} />);await waitForPage(page);
  expect(page.container.textContent).toContain("Решение принял: Не указан");
  expect(page.container.textContent).toContain("Дата и время не сохранены");
  await page.cleanup();
  page = await mountWorkspace(<RegistrationDecision application={{ ...application, status: "pending" }} />);await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Решение по заявке"]')).toBeNull();
});
