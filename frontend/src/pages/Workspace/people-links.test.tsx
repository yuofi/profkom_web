// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { BlockPage, BlockRequestsPage } from "./MembershipPages";
import { LeadershipPage } from "./SessionPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined; });
const card = (title: string) => Array.from(page!.container.querySelectorAll("section")).find((section) => section.querySelector(":scope > h2")?.textContent === title)!;
const hrefs = (root: Element) => Array.from(root.querySelectorAll("a")).map((link) => link.getAttribute("href"));

it("leadership, block members and block requests link people to their profiles (PE-18)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<LeadershipPage />);await waitForPage(page);
  // The chair is the session user: the own chip opens /profile (PE-17).
  expect(hrefs(card("Текущий состав"))).toEqual(["/profile", "/contacts/105"]);
  await page.cleanup();
  const block = mock.state.blocks.find((item) => item.members.length > 0)!;
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${block.block_id}` });await waitForPage(page);
  const members = block.members.map((member) => member.user.user_id === 104 ? "/profile" : `/contacts/${member.user.user_id}`);
  expect(hrefs(card("Состав блока")).filter((href) => href?.startsWith("/contacts/") || href === "/profile")).toEqual(members);
  await page.cleanup();
  page = await mountWorkspace(<BlockRequestsPage />);await waitForPage(page);
  const title = Array.from(page.container.querySelectorAll("h2")).find((heading) => heading.textContent?.includes("→"))!;
  expect(title.querySelector("a")?.getAttribute("href")).toBe(`/contacts/${mock.state.requests[0].user.user_id}`);
});

it("a plain block member is told whom to ask to leave, with links (PE-22)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const block = mock.state.blocks.find((item) => item.block_id === "block-info")!;
  expect(block.members.some((member) => member.user.user_id === 101)).toBe(true);
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${block.block_id}`, role: "organizer" });await waitForPage(page);
  const hint = Array.from(card("Состав блока").querySelectorAll("div")).find((row) => row.querySelector(":scope > span")?.textContent?.startsWith("Чтобы выйти из блока"))!;
  expect(hint).toBeDefined();
  const expected = [block.master!.user.user_id, ...block.master!.deputy_user_ids, block.hr?.user_id].filter(Boolean).map((userId) => `/contacts/${userId}`);
  expect(hrefs(hint)).toEqual([...new Set(expected)]);
  await page.cleanup();
  mock.restore();
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: "/blocks/block-info" });await waitForPage(page);
  expect(card("Состав блока").textContent).not.toContain("Чтобы выйти из блока");
});

it("the block HR pencil is an icon button that a phone row does not stretch (PE-31)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: "/blocks/block-info" });await waitForPage(page);
  const pencil = page.container.querySelector<HTMLButtonElement>('button[aria-label="Изменить HR блока"]')!;
  expect(pencil.className).toMatch(/iconButton/);
  // Only the block page's header keeps «Все блоки» unstretched; other headers keep the phone rule.
  const all = Array.from(page.container.querySelectorAll<HTMLAnchorElement>("a")).find((link) => link.textContent === "Все блоки")!;
  expect(all.parentElement!.className).toMatch(/blockHeaderActions/);
});
