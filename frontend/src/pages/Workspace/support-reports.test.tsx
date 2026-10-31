// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { supportApi } from "../../utils/api/support.api";
import { sectionOf } from "../../components/Workspace/sections";
import { SupportPage } from "./SupportPage";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

const report = (report_id: string, state: string, task_key: string | null) => ({
  report_id, state, revision: 1, kind: "bug" as const, task_id: task_key && `task-${report_id}`, task_key,
  diagnostics_expires_at: "2026-11-30T00:00:00", title: `Обращение ${report_id}`, body: "Текст", created_at: "2026-10-20T10:00:00",
});

it("keeps /support inside the profile section, except for the support staff who work there", () => {
  expect(sectionOf("/support").label).toBe("Мой профиль");
  expect(sectionOf("/profile").label).toBe("Мой профиль");
  expect(sectionOf("/support", { supportStaff: true }).label).toBe("Рабочее пространство");
  expect(sectionOf("/profile", { supportStaff: true }).label).toBe("Мой профиль");
});

it("shows the status and sending date of each own report", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(supportApi, "context").mockResolvedValue({ configured: false, revision: 1, block_id: null, queue_id: null, can_configure: false, can_manage_staff: false, can_triage: false, staff_user_ids: [] });
  vi.spyOn(supportApi, "mine").mockResolvedValue({ items: [report("a", "linked", "WEBSUPPORT-1"), report("b", "pending", null), report("c", "withdrawn", null)], next_cursor: null } as never);
  page = await mountWorkspace(<SupportPage />); await waitForPage(page);
  const cards = [...page.container.querySelectorAll("section")].filter(card => card.textContent?.includes("Обращение "));
  const text = page.container.textContent ?? "";
  expect(text).toContain("Передано в поддержку");
  expect(text).toContain("Ожидает тикета");
  expect(text).toContain("Отозвано");
  expect(text.match(/Отправлено \d/g)).toHaveLength(3);
  expect(cards.length).toBeGreaterThanOrEqual(3);
});
