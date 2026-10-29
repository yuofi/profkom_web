// @vitest-environment jsdom
import { act } from "react";
import MockAdapter from "axios-mock-adapter";
import { afterEach, expect, it } from "vitest";
import { api } from "../../utils/api";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { directoryApi } from "../../utils/api/directory.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { ApiError } from "../../utils/api/request";
import { userMessage } from "../../utils/api/messages";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { AccountArchivePage, FormerContactsPage } from "./DirectoryPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
let adapter: MockAdapter | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;adapter?.restore();adapter = undefined; });
const formerInput = () => ({ surname: "Тестовая", name: "Карточка", patronymic: "", phone: "", email: "synthetic@example.com", tg: "", vk: "", participation_periods: [{ from_year: 2020, to_year: 2022 }] });
it("mock former cards require the current positive revision and leave fields unchanged on missing/stale commands", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const created = await directoryApi.saveFormer(formerInput());expect(created.revision).toBe(1);expect(created.capabilities).toContain("edit_former_contact");
  const before = structuredClone(created);
  await expect(directoryApi.saveFormer({ ...formerInput(), surname: "Не сохранять" }, created.contact_id)).rejects.toMatchObject({ status: 422, code: "validation_error" });
  expect((await directoryApi.former()).items.find(contact => contact.contact_id === created.contact_id)).toEqual(before);
  const saved = await directoryApi.saveFormer({ ...formerInput(), surname: "Сохранено", expected_revision: 1 }, created.contact_id);expect(saved.revision).toBe(2);expect(saved).not.toHaveProperty("expected_revision");
  await expect(directoryApi.saveFormer({ ...formerInput(), surname: "Устарело", expected_revision: 1 }, created.contact_id)).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
  expect((await directoryApi.former()).items.find(contact => contact.contact_id === created.contact_id)).toEqual(saved);
});
it("mock former cards expose read access without editor capabilities to ordinary participants", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  expect((await directoryApi.former()).items[0].capabilities).toEqual([]);
  await expect(directoryApi.saveFormer(formerInput())).rejects.toMatchObject({ status: 403 });
  await expect(directoryApi.saveFormer({ ...formerInput(), expected_revision: 1 }, "former-1")).rejects.toMatchObject({ status: 403 });
});
it("the former editor adopts its own returned revision for a second save and preserves a draft through a foreign conflict", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<FormerContactsPage />);await waitForPage(page);
  const form = page.container.querySelector<HTMLFormElement>("form")!;
  await change(field(form, "surname"), "Первое изменение");await submit(form);await waitForPage(page);
  await change(field(form, "surname"), "Второе изменение");await submit(form);await waitForPage(page);
  const requests = () => mock!.adapter.history.patch.filter(request => request.url === "/contacts/archive/former-1").map(request => JSON.parse(request.data));
  expect(requests().map(request => request.expected_revision)).toEqual([1, 2]);expect(mock.state.former[0].surname).toBe("Второе изменение");expect(mock.state.former[0].revision).toBe(3);
  mock.state.former[0].revision = 4;mock.state.former[0].name = "Чужое изменение";
  await change(field(form, "surname"), "Мой несохранённый ввод");await submit(form);await waitForPage(page);
  expect(requests().at(-1).expected_revision).toBe(3);expect(field(form, "surname").value).toBe("Мой несохранённый ввод");expect(mock.state.former[0].surname).toBe("Второе изменение");expect(form.textContent).toContain("Запись изменилась");
  const refresh = Array.from(form.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Обновить данные")!;expect(refresh).toBeDefined();await act(async () => refresh.click());await waitForPage(page);
  expect(field(form, "surname").value).toBe("Мой несохранённый ввод");
  const keepDraft = Array.from(form.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Сохранить мой ввод с обновлённой версией")!;expect(keepDraft).toBeDefined();await act(async () => keepDraft.click());
  await submit(form);await waitForPage(page);expect(requests().at(-1).expected_revision).toBe(4);expect(mock.state.former[0].revision).toBe(5);expect(mock.state.former[0].surname).toBe("Мой несохранённый ввод");
});
it("restores legacy assignments only through explicit block IDs and retains their mapping through a master conflict", async () => {
  adapter = new MockAdapter(api);const fixture = createFixtures("chair");
  const blockId = "0d907796-189c-4bf6-b82b-7b121fa2bdeb", roleId = "archived-role-17";
  const block = { ...fixture.blocks[0], block_id: blockId, name: "Старое совпадающее название" };
  const account = { ...fixture.archived[0], master_conflicts: [] };
  let restored = false, attempts = 0;
  adapter.onGet("/accounts/archive").reply(() => [200, { items: restored ? [] : [account], next_cursor: null }]);adapter.onGet("/blocks").reply(200, [block]);
  adapter.onPost(`/accounts/${account.user_id}/restore`).reply(() => {
    attempts++;
    if (attempts === 1) return [409, { detail: { code: "archive_scope_mapping_required", message: "Map archived scopes", fields: { assignments: [{ role_assignment_id: roleId, legacy_scope_id: block.name }] } } }];
    if (attempts === 2) return [409, { detail: { code: "master_conflicts", message: "Resolve master conflicts", fields: { master_conflicts: [{ block_id: blockId, block_name: "Новое название блока", current_master: fixture.people[1] }] } } }];
    restored = true;return [200, { account_state: "active" }];
  });
  page = await mountWorkspace(<AccountArchivePage />);await waitForPage(page);
  const form = page.container.querySelector<HTMLFormElement>("form")!;await submit(form);await waitForPage(page);
  expect(page.container.textContent).toContain("выберите блок вручную");expect(field(form, `mapping-${roleId}`).value).toBe("");
  await submit(form);await waitForPage(page);expect(attempts).toBe(1);
  await pick(form, `mapping-${roleId}`, blockId);await submit(form);await waitForPage(page);
  expect(field(form, `mapping-${roleId}`).value).toBe(blockId);
  const conflictLabel = Array.from(form.querySelectorAll("label")).find(label => label.textContent?.startsWith("Кто остаётся мастером"))!;
  expect(conflictLabel.textContent).toContain("Новое название блока");expect(conflictLabel.textContent).not.toContain(blockId);
  await pick(form, `master-${blockId}`, String(fixture.people[1].user_id));await submit(form);await waitForPage(page);
  expect(restored).toBe(true);expect(page.container.textContent).toContain("Архив пуст");
  const requests = adapter.history.post.map(request => JSON.parse(request.data));
  expect(requests[0].block_scope_mappings).toEqual([]);
  for (const request of requests.slice(1)) expect(request.block_scope_mappings).toEqual([{ role_assignment_id: roleId, block_id: blockId }]);
  expect(requests[2].master_conflicts).toEqual([{ block_id: blockId, keep_user_id: fixture.people[1].user_id }]);
  expect(JSON.stringify(requests)).not.toContain(block.name);
  expect(userMessage(new ApiError("Map archived scopes", 409, "archive_scope_mapping_required"))).toBe("Для прежних назначений выберите действующие блоки.");
});
it("mock readiness reads the private workflow and matches close blockers without mutating state", async () => {
  mock = installMockTransport("chair", { delay: 0 });const season = mock.state.seasons.find(item => item.season_id === "season-1")!;
  mock.state.tasks[0].assignments[0].status = "accepted";
  const before = JSON.stringify(mock.state);
  const readiness = await seasonsApi.readiness(season.season_id);expect(readiness.ready).toBe(false);expect(readiness.revision).toBe(season.revision);expect(JSON.stringify(mock.state)).toBe(before);
  expect(readiness.blockers).toContainEqual(expect.objectContaining({ kind: "unfinished_assignment", owner_id: mock.state.tasks[0].assignments[0].assignment_id }));
  try { await seasonsApi.command(season.season_id, "close", { expected_revision: season.revision });throw Error("Expected close refusal"); } catch (error) { expect(error).toMatchObject({ status: 409, code: "season_not_ready", fields: { blockers: readiness.blockers } }); }
  expect(JSON.stringify(mock.state)).toBe(before);
  mock.state.assessments.forEach(inputs => { inputs.workflow_status = "cancelled"; });
  expect((await seasonsApi.readiness(season.season_id)).blockers.some(blocker => blocker.owner_kind === "assignment")).toBe(false);
});
it("mock readiness rejects unknown seasons and ordinary readers and never marks a planned season ready", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  await expect(seasonsApi.readiness("not-a-season")).rejects.toMatchObject({ status: 404 });
  const planned = mock.state.seasons.find(season => season.state === "planned")!;
  planned.previous_season_id = null;expect((await seasonsApi.readiness(planned.season_id)).ready).toBe(false);
  mock.restore();mock = installMockTransport("organizer", { delay: 0 });
  await expect(seasonsApi.readiness("season-1")).rejects.toMatchObject({ status: 403 });
});
