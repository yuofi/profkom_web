// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { UserChip } from "./UserChip";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { api } from "../../utils/api";
import { ApiError } from "../../utils/api/request";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
async function mount() {
  transport = installMockTransport("chair", { delay: 0 });const person = transport.state.people[0];
  page = await mountWorkspace(<Routes><Route path="/tasks" element={<UserChip user={person} />} /><Route path="/contacts/:id" element={<p>Профиль участника</p>} /></Routes>, { path: "/tasks" });await waitForPage(page);return person;
}
it("shows an avatar and delayed authorized profile preview, then navigates through the chip", async () => {
  const person = await mount(), link = page!.container.querySelector<HTMLAnchorElement>("a")!;
  expect(link.querySelector("img")).not.toBeNull();expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => { link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));await new Promise(resolve => setTimeout(resolve, 390)); });await waitForPage(page!);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Профиль участника");expect(document.querySelector('[role="tooltip"] img')).not.toBeNull();
  expect(link.href).toContain(`/contacts/${person.user_id}`);
  await act(async () => link.click());await waitForPage(page!);expect(page!.container.textContent).toContain("Профиль участника");expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
it("drops previously fetched directory details on refusal and closes the preview with Escape", async () => {
  await mount();const link = page!.container.querySelector<HTMLAnchorElement>("a")!;
  await act(async () => link.focus());await waitForPage(page!);expect(document.querySelector('[role="tooltip"] dl')).not.toBeNull();
  vi.spyOn(api, "request").mockRejectedValue(new ApiError("Нет доступа",403,"forbidden"));await act(async () => { await page!.client.invalidateQueries({ queryKey: ["contacts"] }); });await waitForPage(page!);
  expect(document.querySelector('[role="tooltip"] dl')).toBeNull();expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Дополнительные сведения недоступны");
  await act(async () => link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
it("does not request an external avatar address", async () => {
  page = await mountWorkspace(<UserChip user={{ user_id: 99, display_name: "Синтетический участник", avatar_url: "https://outside.invalid/photo.png" }} />);
  expect(page.container.querySelector("img")?.getAttribute("src")).toBe("/avatars/default.svg");
});

it("keeps a trailing person action separate from profile navigation and disables preview while its editor is open", async () => {
  transport = installMockTransport("chair", { delay: 0 });const person = transport.state.people[0], action = vi.fn();
  page = await mountWorkspace(<Routes><Route path="/tasks" element={<UserChip user={person} previewDisabled trailingAction={{ label: "Изменить исполнителя", onClick: action }} />} /><Route path="/contacts/:id" element={<p>Профиль открыт</p>} /></Routes>, { path: "/tasks" });await waitForPage(page);
  const link = page.container.querySelector<HTMLAnchorElement>("a")!, edit = page.container.querySelector<HTMLButtonElement>('button[aria-label="Изменить исполнителя"]')!;
  expect(link.contains(edit)).toBe(false);expect(link.parentElement).toBe(edit.parentElement);await act(async () => link.focus());await waitForPage(page);expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => edit.click());await waitForPage(page);expect(action).toHaveBeenCalledTimes(1);expect(page.container.textContent).not.toContain("Профиль открыт");expect(transport.adapter.history.get.some(request => request.url === "/contacts")).toBe(false);
});
