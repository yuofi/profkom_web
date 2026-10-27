// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { membershipApi } from "../../utils/api/membership.api";
import { sessionApi } from "../../utils/api/session.api";
import { getBlockRoute, getContactRoute } from "../../utils/routes";
import { BlocksPage } from "./MembershipPages";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
it("shows the real leadership and every block to an ordinary approved reader without granting management", async () => {
  const actor = await liveParticipant("organization-reader"), session = await liveLogin(actor.email);
  const [blocks, leadership] = await Promise.all([membershipApi.blocks(), sessionApi.leadership()]);
  expect(leadership.capabilities).not.toContain("transfer_chair");
  page = await mountWorkspace(<Routes><Route path="/blocks" element={<BlocksPage />} /></Routes>, { path: "/blocks", session });
  await waitForPage(page, () => !!page!.container.querySelector('section[aria-label="Структура Профкома"]'));
  const tree = page.container.querySelector('section[aria-label="Структура Профкома"]')!;
  const top = tree.querySelector('section[aria-label="Руководство Профкома"]')!;
  for (const user of [leadership.chair, ...leadership.deputies]) {
    if (!user) continue;
    expect(top.textContent).toContain(user.display_name);
    if (user.user_id !== null) expect(top.querySelector(`a[href="${getContactRoute(user.user_id)}"]`)).not.toBeNull();
  }
  const branches = tree.querySelector('ul[aria-label="Блоки Профкома"]')!;expect(branches.children).toHaveLength(blocks.length);
  expect(tree.querySelector('section[aria-label^="Руководство блока "]')).toBeNull();
  const expand = [...tree.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Развернуть все")!;
  expect(expand).toBeDefined();await act(async () => expand.click());await waitForPage(page);
  for (const block of blocks) {
    expect(branches.querySelector(`a[href="${getBlockRoute(block.block_id)}"]`)).not.toBeNull();
    const leaders = tree.querySelector(`section[aria-label="Руководство блока ${block.name}"]`)!;
    if (block.master) expect(leaders.textContent).toContain(block.master.user.display_name);
  }
  expect(page.container.querySelector('a[href="/blocks/requests"]')).not.toBeNull();
  expect(tree.querySelector('input[type="search"]')).not.toBeNull();
  expect(tree.querySelector('form,select,input:not([type="search"])')).toBeNull();
});
