// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { membershipApi } from "../../utils/api/membership.api";
import { directoryApi } from "../../utils/api/directory.api";
import { sessionApi } from "../../utils/api/session.api";
import { ApiError } from "../../utils/api/request";
import { api } from "../../utils/api";
import { BlocksPage } from "./MembershipPages";
import { OrganizationTree } from "./OrganizationTree";
import type { Leadership, UserRef } from "../../utils/api/contract";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
const fixture = () => {
  const f = createFixtures("organizer");
  const leadership: Leadership = { chair: f.people[3], deputies: [f.people[4]], revision: 1, capabilities: [] };
  return { ...f, leadership };
};
it("renders top leadership and block/member branches with separate roles and shared avatar chips", async () => {
  const f = fixture(), block = structuredClone(f.blocks[0]);
  const deputy: UserRef = { user_id: 8101, display_name: "Заместитель Вне Состава", avatar_url: "/avatars/default.svg" };
  const member: UserRef = { user_id: 8102, display_name: "Обычный Участник", avatar_url: null };
  block.master!.deputy_user_ids = [deputy.user_id!, deputy.user_id!, 8103];
  block.members = [{ user: block.master!.user, block_category: "member" }, { user: deputy, block_category: "member" }, { user: member, block_category: "junior" }];
  page = await mountWorkspace(<OrganizationTree blocks={[block]} leadership={f.leadership} people={[deputy]} />);
  const tree = page.container.querySelector('[aria-label="Структура Профкома"]')!, global = tree.querySelector('[aria-label="Руководство Профкома"]')!, branches = tree.querySelector('[aria-label="Блоки Профкома"]')!;
  expect(global.compareDocumentPosition(branches) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(global.textContent).toContain(f.leadership.chair!.display_name);expect(global.textContent).toContain(f.leadership.deputies[0].display_name);
  const leaders = branches.querySelector(`[aria-label="Руководство блока ${block.name}"]`)!;
  expect(leaders.querySelectorAll(`a[href="/contacts/${deputy.user_id}"]`)).toHaveLength(1);expect(leaders.textContent).toContain("Профиль недоступен");expect(leaders.querySelector('a[href="/contacts/8103"]')).toBeNull();
  expect(branches.textContent).toContain("Участников: 4");
  const members = branches.querySelector(`[aria-label="Участники блока ${block.name}"]`)!;
  expect(members.tagName).toBe("UL");expect(members.closest("li")?.parentElement).toBe(branches);expect(members.querySelectorAll("li")).toHaveLength(1);expect(members.textContent).toContain(member.display_name);expect(members.textContent).toContain("Новичок");expect(members.textContent).not.toContain(deputy.display_name);expect(members.textContent).not.toContain(block.master!.user.display_name);
  expect(tree.querySelectorAll('[role="tree"],[role="treeitem"]')).toHaveLength(0);for (const link of tree.querySelectorAll('a[href^="/contacts/"]')) expect(link.querySelector("img")).not.toBeNull();expect(tree.querySelector(`a[href="/blocks/${block.block_id}"]`)?.textContent).toContain(block.name);
});
it("keeps a service deputy outside membership and handles vacant leadership and empty blocks", async () => {
  const f = fixture(), block = structuredClone(f.blocks[0]), deputy = { user_id: 8201, display_name: "Служебный Заместитель", avatar_url: null };
  block.master!.deputy_user_ids = [deputy.user_id, deputy.user_id, block.master!.user.user_id!];block.members = [];
  const it = { ...structuredClone(block), block_id: "tree-it", name: "IT", members: [{ user: f.people[0], block_category: "junior" as const }] };
  page = await mountWorkspace(<OrganizationTree blocks={[{ ...block, name: "HR" }, it]} leadership={{ ...f.leadership, chair: null, deputies: [] }} people={[deputy]} />);
  expect(page.container.querySelector(`a[href="/blocks/${block.block_id}"]`)?.closest("li")?.textContent).toContain("Участников: 2");expect(page.container.querySelector('a[href="/blocks/tree-it"]')?.closest("li")?.textContent).toContain("Участников: 3");
  expect(page.container.querySelector('[aria-label="Руководство блока HR"]')?.textContent).toContain(deputy.display_name);expect(page.container.textContent).toContain("Других участников пока нет");expect(page.container.textContent).toContain("Не назначен");
  await page.cleanup();page = await mountWorkspace(<OrganizationTree blocks={[]} leadership={{ ...f.leadership, chair: null, deputies: [] }} people={[]} />);expect(page.container.textContent).toContain("Блоки пока не добавлены.");expect(page.container.textContent).toContain("Блоков: 0");
});
it("loads all blocks and leaders using three shared reads, retaining requests and block navigation", async () => {
  transport = installMockTransport("organizer", { delay: 0 });page = await mountWorkspace(<Routes><Route path="/blocks" element={<BlocksPage />} /><Route path="/blocks/requests" element={<p>Заявки открыты</p>} /></Routes>, { path: "/blocks", role: "organizer" });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Структура Профкома"]')).not.toBeNull();for (const block of transport.state.blocks) expect(page.container.querySelector(`a[href="/blocks/${block.block_id}"]`)).not.toBeNull();for (const url of ["/blocks", "/leadership", "/contacts"]) expect(transport.adapter.history.get.filter(item => item.url === url)).toHaveLength(1);expect(transport.adapter.history.get.some(item => /^\/blocks\//.test(item.url ?? ""))).toBe(false);
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/blocks/requests"]')!.click());expect(page.container.textContent).toContain("Заявки открыты");
});
it("resolves a service deputy regardless of ordinary membership and retains lazy authorized profile previews", async () => {
  transport = installMockTransport("organizer", { delay: 0 });const f = fixture(), user = { ...f.profile, user_id: 8301, surname: "Служебный", name: "Заместитель", patronymic: "", in_profcom: false };
  transport.state.blocks[0].master!.deputy_user_ids = [user.user_id];transport.state.blocks[0].members = [];vi.spyOn(directoryApi, "contacts").mockResolvedValue([user]);
  page = await mountWorkspace(<BlocksPage />, { path: "/blocks", role: "organizer" });await waitForPage(page);const link = page.container.querySelector<HTMLAnchorElement>(`a[href="/contacts/${user.user_id}"]`)!;
  expect(link.textContent).toContain("Служебный Заместитель");expect(link.querySelector("img")).not.toBeNull();expect(document.querySelector('[role="tooltip"]')).toBeNull();await act(async () => link.focus());await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Профиль участника");
});
it("hides cached identities on 403 even if another source has a retryable error", async () => {
  transport = installMockTransport("organizer", { delay: 0 });page = await mountWorkspace(<BlocksPage />, { path: "/blocks", role: "organizer" });await waitForPage(page);expect(page.container.querySelector('[aria-label="Структура Профкома"]')).not.toBeNull();
  vi.spyOn(api, "request").mockImplementation(config => Promise.reject(config.url === "/blocks" ? new ApiError("Temporary", 500, "temporary") : new ApiError("Forbidden", 403, "forbidden")));await act(async () => { await Promise.all([page!.client.invalidateQueries({ queryKey: ["workspaceBlocks"] }),page!.client.invalidateQueries({ queryKey: ["leadership"] })]); });await waitForPage(page);
  expect(page.container.querySelector('[aria-label="Структура Профкома"]')).toBeNull();expect(page.container.querySelectorAll('a[href^="/contacts/"]')).toHaveLength(0);expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Нет доступа");
});
it("does not fetch or show cached organisation data for a pending session", async () => {
  const f = createFixtures("pending"), get = vi.spyOn(membershipApi, "blocks"), leadership = vi.spyOn(sessionApi, "leadership"), people = vi.spyOn(directoryApi, "contacts");page = await mountWorkspace(<BlocksPage />, { path: "/blocks", role: "pending" });await waitForPage(page);
  await act(async () => { page!.client.setQueryData(["workspaceBlocks"], f.blocks);page!.client.setQueryData(["leadership"], { chair: f.people[3], deputies: [], revision: 1, capabilities: [] });page!.client.setQueryData(["contacts"], [f.profile]); });await waitForPage(page);
  expect(get).not.toHaveBeenCalled();expect(leadership).not.toHaveBeenCalled();expect(people).not.toHaveBeenCalled();expect(page.container.querySelector('[aria-label="Структура Профкома"]')).toBeNull();
});
