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
