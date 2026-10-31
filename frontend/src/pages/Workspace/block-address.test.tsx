// @vitest-environment jsdom
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { membershipApi } from "../../utils/api/membership.api";
import { BlockPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });

it("moves an old block address by name to the block's id before building its links", async () => {
  transport = installMockTransport("chair", { delay: 0 });
  const block = transport.state.blocks.find(item => item.capabilities.includes("create_volunteer_merit")) ?? transport.state.blocks[0];
  block.capabilities = [...new Set([...block.capabilities, "create_volunteer_merit", "view_tasks"])];
  const original = membershipApi.block;
  // The server also answers the name of a block; the mock knows only ids.
  vi.spyOn(membershipApi, "block").mockImplementation(id => original(id === block.name ? block.block_id : id));
  const where: string[] = [];
  function Where() { const location = useLocation();where.push(location.pathname);return null; }
  page = await mountWorkspace(<><Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes><Where /></>, { path: `/blocks/${encodeURIComponent(block.name)}` });
  await waitForPage(page);
  expect(where.at(-1)).toBe(`/blocks/${block.block_id}`);
  const hrefs = [...page.container.querySelectorAll("a")].map(link => link.getAttribute("href") ?? "");
  expect(hrefs).toContain(`/merits?source_kind=block_volunteer&scope_id=${block.block_id}`);
  expect(hrefs).toContain(`/tasks?scope_kind=block&scope_id=${block.block_id}`);
  expect(hrefs.some(href => href.includes(encodeURIComponent(block.name)))).toBe(false);
});
