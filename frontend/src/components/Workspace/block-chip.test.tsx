// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { installMockTransport } from "../../mocks/transport";
import { membershipApi } from "../../utils/api/membership.api";
import { ApiError } from "../../utils/api/request";
import { BlockChip } from "./BlockChip";
import { TeamChip } from "./TeamChip";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });

it("display block identities have initials and never fetch, navigate or open a preview", async () => {
  const get = vi.spyOn(membershipApi, "block");
  page = await mountWorkspace(<BlockChip block={{ block_id: "block-id", name: "Дизайн ВМК" }} interactive={false} />);
  await act(async () => page!.container.querySelector("span")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(page.container.textContent).toContain("ДВ");expect(page.container.textContent).toContain("Дизайн ВМК");expect(page.container.querySelector("a,button,[tabindex]")).toBeNull();expect(document.querySelector('[role="tooltip"]')).toBeNull();expect(get).not.toHaveBeenCalled();
});
it("a block preview is lazy, authorized and discards cached details after a current 404", async () => {
  transport = installMockTransport("chair", { delay: 0 });const block = transport.state.blocks[0];
  const get = vi.spyOn(membershipApi, "block");
  page = await mountWorkspace(<Routes><Route path="/" element={<BlockChip block={block} />} /><Route path="/blocks/:id" element={<p>Блок открыт</p>} /></Routes>);
  expect(get).not.toHaveBeenCalled();const link = page.container.querySelector<HTMLAnchorElement>("a")!;expect(link.getAttribute("href")).toBe(`/blocks/${block.block_id}`);
  await act(async () => link.focus());await waitForPage(page, () => !!document.querySelector('[role="tooltip"] dl'));
  expect(get).toHaveBeenCalledWith(block.block_id);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(block.name);expect(document.querySelector('[role="tooltip"] a, [role="tooltip"] button')).toBeNull();
  get.mockRejectedValue(new ApiError("Недоступно", 404));await act(async () => { await page!.client.invalidateQueries({ queryKey: ["workspaceBlocks", block.block_id] }); });await waitForPage(page);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Блок недоступен.");expect(document.querySelector('[role="tooltip"] dl')).toBeNull();
});
it("missing block labels resolve from the real DTO without replacing the shared cache shape", async () => {
  transport = installMockTransport("chair", { delay: 0 });const block = transport.state.blocks[0];
  page = await mountWorkspace(<TeamChip scope={{ kind: "block", id: block.block_id }} />);await waitForPage(page);
  expect(page.container.textContent).toContain(block.name);expect(page.container.textContent).not.toContain(block.block_id);
  expect(page.client.getQueryData(["workspaceBlocks", block.block_id])).toMatchObject({ block_id: block.block_id, members: block.members, name: block.name });
});
it("supplied subevent and independent queue identities keep their own routes", async () => {
  const get = vi.spyOn(membershipApi, "block");
  page = await mountWorkspace(<><TeamChip scope={{ kind: "subevent", id: "sub-id" }} title="Команда встречи" /><TeamChip scope={{ kind: "queue", id: "queue-id" }} title="Рабочая очередь" /><TeamChip scope={{ kind: "block", id: "not-an-invented-name" }} interactive={false} /></>);
  expect([...page.container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/subevents/sub-id", "/tasks/queues/queue-id"]);expect(page.container.textContent).not.toContain("not-an-invented-name");expect(get).not.toHaveBeenCalled();
});
