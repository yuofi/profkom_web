// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { blockLifecycleApi } from "../../utils/api/blockLifecycle.api";
import { membershipApi } from "../../utils/api/membership.api";
import type { Block } from "../../utils/api/contract";
import { BlockSettingsAction, BlockDeletionStatus, CreateBlockAction } from "./BlockSettings";
import { BlocksPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks();vi.useRealTimers(); });
const fixture = () => createFixtures("chair");
const block = (caps = ["rename_block", "edit_block", "start_block_deletion"]): Block => ({ ...fixture().blocks[0], revision: 11, capabilities: caps, archived_at: null, deletion_request: null });
const request = (state: "pending" | "scheduled" = "pending"): NonNullable<Block["deletion_request"]> => ({ request_id: "deletion-1", state, revision: 2, created_at: "2026-11-10T09:00:00Z", scheduled_at: state === "scheduled" ? "2026-11-10T10:00:00Z" : null, delete_after: state === "scheduled" ? "2026-11-13T10:00:00Z" : null, finished_at: null, cancel_reason: null, approvals: [{ actor: fixture().people[0], at: "2026-11-10T09:00:00Z" }, ...(state === "scheduled" ? [{ actor: fixture().people[1], at: "2026-11-10T10:00:00Z" }] : [])], capabilities: state === "pending" ? ["approve_block_deletion", "cancel_block_deletion"] : ["cancel_block_deletion"] });
const click = async (label: string) => { const button = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;expect(button).toBeDefined();await act(async () => button.click());await waitForPage(page!); };
it.each([true, false])("catalog creation button follows the server create_block capability: %s", async granted => {
  mock = installMockTransport("chair", { delay: 0 });const session = { ...mock.state.session, capabilities: granted ? ["create_block"] : [] };
  page = await mountWorkspace(<BlocksPage />, { session });await waitForPage(page);
  expect(page.container.textContent?.includes("Создать блок")).toBe(granted);
});
it("creates an empty block with the entered name and navigates to its actual card", async () => {
  const saved = block(), create = vi.spyOn(blockLifecycleApi, "create").mockResolvedValue(saved);
  page = await mountWorkspace(<Routes><Route path="/" element={<CreateBlockAction />} /><Route path="/blocks/:id" element={<p>Новая карточка</p>} /></Routes>);
  await click("Создать блок");await change(field(page.container, "name"), "Новая команда");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(create.mock.calls[0][0]).toMatchObject({ name: "Новая команда", community_url: null });expect(page.container.textContent).toContain("Новая карточка");
});
it("renames with the current block revision and retains the existing avatar picker", async () => {
  const original = block(), update = vi.spyOn(membershipApi, "updateBlock").mockResolvedValue({ ...original, name: "P2B", revision: 12 });
  page = await mountWorkspace(<BlockSettingsAction block={original} />);await click("Настройки блока");
  expect(page.container.querySelector('[aria-label="Изменить аватар блока"]')).not.toBeNull();
  await change(field(page.container, "name"), "P2B");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(update).toHaveBeenCalledExactlyOnceWith(original.block_id, { expected_revision: 11, name: "P2B" });
});
it("masters keep avatar editing but receive neither rename nor deletion controls", async () => {
  page = await mountWorkspace(<BlockSettingsAction block={block(["edit_block"])} />);await click("Настройки блока");
  expect(page.container.querySelector('[aria-label="Изменить аватар блока"]')).not.toBeNull();expect(page.container.querySelector('[name="name"]')).toBeNull();expect(page.container.textContent).not.toContain("Запросить удаление блока");
});
it("requires explicit first confirmation and uses the block revision, never a direct DELETE", async () => {
  const original = block(), start = vi.spyOn(blockLifecycleApi, "startDeletion").mockResolvedValue({ ...original, revision: 12, deletion_request: request() });
  page = await mountWorkspace(<BlockSettingsAction block={original} />);await click("Настройки блока");await click("Запросить удаление блока");
  expect(start).not.toHaveBeenCalled();expect(page.container.textContent).toContain("Ваш запрос станет первым подтверждением");
  await click("Подтвердить запрос");expect(start).toHaveBeenCalledExactlyOnceWith(original.block_id, { expected_revision: 11 });
});
it("shows both approvers, Moscow deletion time and allows cancellation during the 72-hour timer", async () => {
  const original = { ...block(), deletion_request: request("scheduled") }, cancel = vi.spyOn(blockLifecycleApi, "cancelDeletion").mockResolvedValue({ ...block(), revision: 12, deletion_request: { ...request("scheduled"), state: "cancelled", capabilities: [] } });
  page = await mountWorkspace(<BlockDeletionStatus block={original} />);
  expect(page.container.textContent).toContain("Оба подтверждения получены");expect(page.container.querySelectorAll('[aria-label="Подтверждения удаления"] li')).toHaveLength(2);
  expect(page.container.textContent).toContain("13:00");expect(page.container.textContent).toContain("МСК");expect(page.container.textContent).toContain("Прежние задачи, гайды и ККР сохранятся");
  await click("Отменить удаление");expect(cancel).toHaveBeenCalledExactlyOnceWith(original.block_id, { expected_revision: 11, request_id: "deletion-1" });
});
it("the first approver cannot see a second approval action when the server omits it", async () => {
  page = await mountWorkspace(<BlockDeletionStatus block={{ ...block(), deletion_request: { ...request(), capabilities: ["cancel_block_deletion"] } }} />);
  expect(page.container.textContent).toContain("1 из 2");expect(page.container.textContent).not.toContain("Подтвердить удаление");expect(page.container.querySelector('[role="timer"]')).toBeNull();
});
it("archived history is readable without polling or offering lifecycle actions", async () => {
  const read = vi.spyOn(membershipApi, "block");
  page = await mountWorkspace(<BlockDeletionStatus block={{ ...block([]), archived_at: "2026-11-13T10:00:00Z", deletion_request: { ...request("scheduled"), state: "executed", capabilities: [] } }} />);
  await waitForPage(page);expect(page.container.textContent).toContain("Блок удалён");expect(page.container.querySelector("button")).toBeNull();expect(read).not.toHaveBeenCalled();
});
it("second approval stays in a confirm dialog and sends CAS with request ID", async () => {
  const original = { ...block(), deletion_request: request() }, approve = vi.spyOn(blockLifecycleApi, "approveDeletion").mockResolvedValue({ ...original, revision: 12, deletion_request: request("scheduled") });
  function Probe() { const [value] = useState(original);return <BlockDeletionStatus block={value} />; }
  page = await mountWorkspace(<Probe />);await click("Подтвердить удаление");expect(approve).not.toHaveBeenCalled();await click("Подтвердить и запустить 72 часа");
  expect(approve).toHaveBeenCalledExactlyOnceWith(original.block_id, { expected_revision: 11, request_id: "deletion-1" });
});
it("polls only the active detail and stops after cancellation observed from another tab", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
  const original = { ...block(), deletion_request: request("scheduled") }, cancelled = { ...original, revision: 12, deletion_request: { ...request("scheduled"), state: "cancelled" as const, capabilities: [] } };
  const read = vi.spyOn(membershipApi, "block").mockResolvedValue(cancelled), catalog = vi.spyOn(membershipApi, "blocks");
  page = await mountWorkspace(<BlockDeletionStatus block={original} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });await waitForPage(page);
  expect(read).toHaveBeenCalledExactlyOnceWith(original.block_id, { include_deputies: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });await waitForPage(page);
  expect(read).toHaveBeenCalledOnce();expect(catalog).not.toHaveBeenCalled();
});
