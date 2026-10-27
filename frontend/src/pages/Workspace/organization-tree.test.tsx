// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { change, mountWorkspace, waitForPage } from "../../test/workspace";
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
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
const toggles = () => [...page!.container.querySelectorAll<HTMLButtonElement>('button[aria-controls][aria-expanded]')];
const controlled = (toggle: HTMLButtonElement) => document.getElementById(toggle.getAttribute("aria-controls")!)!;
const expandAll = async () => { await act(async () => button("Развернуть все").click()); };
it("renders top leadership and block/member branches with separate roles and shared avatar chips", async () => {
  const f = fixture(), block = structuredClone(f.blocks[0]);
  const deputy: UserRef = { user_id: 8101, display_name: "Заместитель Вне Состава", avatar_url: "/avatars/default.svg" };
  const member: UserRef = { user_id: 8102, display_name: "Обычный Участник", avatar_url: null };
  block.master!.deputy_user_ids = [deputy.user_id!, deputy.user_id!, 8103];
  block.members = [{ user: block.master!.user, block_category: "member" }, { user: deputy, block_category: "member" }, { user: member, block_category: "junior" }];
  page = await mountWorkspace(<OrganizationTree blocks={[block]} leadership={f.leadership} people={[deputy]} />);
  await expandAll();
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
  await expandAll();
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
  page = await mountWorkspace(<BlocksPage />, { path: "/blocks", role: "organizer" });await waitForPage(page);
  await expandAll();
  const deputyLink = page.container.querySelector<HTMLAnchorElement>(`a[href="/contacts/${user.user_id}"]`)!;
  expect(deputyLink.textContent).toContain("Служебный Заместитель");expect(deputyLink.querySelector("img")).not.toBeNull();expect(document.querySelector('[role="tooltip"]')).toBeNull();await act(async () => deputyLink.focus());await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Профиль участника");
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

it("starts with collapsed blocks, keeps controls native and separate from block navigation", async () => {
  const f = fixture();
  page = await mountWorkspace(<Routes><Route path="/blocks" element={<OrganizationTree blocks={f.blocks} leadership={f.leadership} people={f.people} />} /><Route path="/blocks/:id" element={<p>Страница блока открыта</p>} /></Routes>, { path: "/blocks" });
  expect(toggles()).toHaveLength(f.blocks.length);for (const toggle of toggles()) { expect(toggle.getAttribute("aria-expanded")).toBe("false");expect(controlled(toggle).hidden).toBe(true);expect(controlled(toggle).children).toHaveLength(0); }
  expect(page.container.querySelector('[aria-label="Руководство Профкома"]')?.textContent).toContain(f.leadership.chair!.display_name);
  const [first, second] = toggles(), target = first.getAttribute("aria-controls");
  await act(async () => first.click());expect(first.getAttribute("aria-expanded")).toBe("true");expect(controlled(first).hidden).toBe(false);expect(controlled(first).textContent).toContain("Мастер");expect(second.getAttribute("aria-expanded")).toBe("false");
  await act(async () => first.click());expect(first.getAttribute("aria-controls")).toBe(target);expect(controlled(first).hidden).toBe(true);
  const link = page.container.querySelector<HTMLAnchorElement>(`a[href="/blocks/${f.blocks[0].block_id}"]`)!;expect(link.contains(first)).toBe(false);
  await act(async () => link.click());expect(page.container.textContent).toContain("Страница блока открыта");
});

it("expands and collapses all blocks without changing participant counts or top leadership", async () => {
  const f = fixture();page = await mountWorkspace(<OrganizationTree blocks={f.blocks} leadership={f.leadership} people={f.people} />);
  const counts = [...page.container.querySelectorAll('[aria-label="Блоки Профкома"]>li')].map(item => item.textContent?.match(/Участников: \d+/)?.[0]);
  expect(button("Свернуть все").disabled).toBe(true);await expandAll();expect(button("Развернуть все").disabled).toBe(true);for (const toggle of toggles()) expect(controlled(toggle).hidden).toBe(false);
  await act(async () => button("Свернуть все").click());for (const toggle of toggles()) expect(controlled(toggle).hidden).toBe(true);
  expect([...page.container.querySelectorAll('[aria-label="Блоки Профкома"]>li')].map(item => item.textContent?.match(/Участников: \d+/)?.[0])).toEqual(counts);
  expect(page.container.querySelector('[aria-label="Руководство Профкома"]')?.textContent).toContain(f.leadership.chair!.display_name);
});

it("searches block, master, service-deputy and member names, opens whole matching branches and restores manual state", async () => {
  const f = fixture(), first = structuredClone(f.blocks[0]), second = structuredClone(f.blocks[1]);
  const deputy = { user_id: 8401, display_name: "Ёлкин Заместитель", avatar_url: null }, member = { user_id: 8402, display_name: "Лев Волонтёров", avatar_url: null };
  first.name = "Разработка сайта";first.master!.user = { ...first.master!.user, display_name: "Мария Мастерова" };first.master!.deputy_user_ids = [deputy.user_id];first.members = [{ user: member, block_category: "member" }];
  second.name = "Кадровый блок";second.master = null;second.members = [];
  page = await mountWorkspace(<OrganizationTree blocks={[first, second]} leadership={f.leadership} people={[deputy]} />);
  await act(async () => toggles()[1].click());const input = page.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  for (const query of ["Разработка", "МАСТЕРОВА", "елкин", "волонтеров", "Заместитель Ёлкин"]) {
    await change(input, query);expect(toggles()).toHaveLength(1);const toggle = toggles()[0];expect(toggle.getAttribute("aria-label")).toBe(`Свернуть блок ${first.name}`);expect(toggle.getAttribute("aria-expanded")).toBe("true");expect(toggle.disabled).toBe(true);expect(controlled(toggle).hidden).toBe(false);
    expect(controlled(toggle).textContent).toContain(first.master!.user.display_name);expect(controlled(toggle).textContent).toContain(deputy.display_name);expect(controlled(toggle).textContent).toContain(member.display_name);expect(page.container.querySelector('[role="status"]')?.textContent).toContain("Найдено блоков: 1 из 2");expect(button("Развернуть все").disabled).toBe(true);expect(button("Свернуть все").disabled).toBe(true);
  }
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Сбросить поиск"]')!.click());
  expect(input.value).toBe("");expect(document.activeElement).toBe(input);expect(toggles()).toHaveLength(2);expect(toggles()[0].getAttribute("aria-expanded")).toBe("false");expect(toggles()[1].getAttribute("aria-expanded")).toBe("true");
  await change(input, "   ");expect(toggles()[0].getAttribute("aria-expanded")).toBe("false");expect(toggles()[1].getAttribute("aria-expanded")).toBe("true");
});

it("finds the always-visible global leadership and offers a reset for empty results", async () => {
  const f = fixture(), chair = { user_id: 8501, display_name: "Глобальный Председатель", avatar_url: null };
  page = await mountWorkspace(<OrganizationTree blocks={f.blocks} leadership={{ ...f.leadership, chair }} people={f.people} />);
  const input = page.container.querySelector<HTMLInputElement>('input[type="search"]')!;await change(input, "Глобальный");
  expect(page.container.querySelector('[aria-label="Руководство Профкома"]')?.textContent).toContain(chair.display_name);expect(page.container.querySelector('[role="status"]')?.textContent).toContain("Совпадений в руководстве Профкома: 1");expect(page.container.textContent).toContain("В блоках совпадений нет");expect(toggles()).toHaveLength(0);
  await change(input, "НетТакогоУчастника");expect(page.container.textContent).toContain("Ничего не найдено");expect(page.container.querySelector('[role="status"]')?.textContent).toContain("Совпадений в руководстве Профкома: 0");
  await act(async () => button("Показать все блоки").click());expect(input.value).toBe("");expect(toggles()).toHaveLength(f.blocks.length);for (const toggle of toggles()) expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
