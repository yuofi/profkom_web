// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { BlockRequestsPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined; });
const button = (root: ParentNode, label: string) => Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);

it("approve and reject stand in one row and the reason is asked in a dialog (PE-27)", async () => {
  mock = installMockTransport("leader", { delay: 0 });
  page = await mountWorkspace(<BlockRequestsPage />, { role: "leader" });await waitForPage(page);
  const card = Array.from(page.container.querySelectorAll("section")).find((section) => section.querySelector(":scope > h2")?.textContent?.includes("→"))!;
  const approve = button(card, "Одобрить вступление")!;
  const reject = button(card, "Отклонить")!;
  expect(approve.closest("form")!.parentElement).toBe(reject.parentElement);
  expect(card.textContent).not.toContain("Доступность решения определяет сервер");
  expect(card.textContent).toMatch(/Если решение не принято до .+, его смогут принять председатель или его заместители\./);
  expect(document.querySelector("dialog")).toBeNull();
  await act(async () => reject.click());
  const dialog = document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("Отклонить заявку в блок");
  await change(field(dialog, "reason"), "Набор закрыт");
  await submit(dialog.querySelector("form")!);await waitForPage(page);
  expect(mock.state.requests[0].state).toBe("rejected");
  const sent = mock.adapter.history.post.find((request) => request.url?.endsWith("/request-1/reject"))!;
  expect(JSON.parse(sent.data)).toMatchObject({ reason: "Набор закрыт" });
  expect(document.querySelector("dialog")).toBeNull();
});

it("the history is a compact list shown twenty at a time (PE-27)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const base = mock.state.requests[0];
  for (let index = 0; index < 25; index++)
    mock.state.requests.push({ ...base, request_id: `request-old-${index}`, state: "rejected", capabilities: [], decided_at: "2026-10-15T09:00:00Z", decision_reason: `Причина ${index}`, substitute_available_at: null });
  page = await mountWorkspace(<BlockRequestsPage />, { role: "chair" });await waitForPage(page);
  const history = Array.from(page.container.querySelectorAll("details")).find((d) => d.querySelector("summary")?.textContent === "История · 25")!;
  const rows = () => history.querySelectorAll(":scope > ul > li");
  expect(rows()).toHaveLength(20);
  expect(rows()[0].querySelector(":scope > details > summary")?.textContent).toContain("→");
  await act(async () => button(history, "Показать ещё · 5")!.click());
  expect(rows()).toHaveLength(25);
  expect(button(history, "Показать ещё · 5")).toBeUndefined();
});
