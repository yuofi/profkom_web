// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Link, Outlet, RouterProvider } from "react-router-dom";
import { UnsavedChangesProvider } from "./UnsavedChanges";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { installMockTransport } from "../../mocks/transport";
import { filesApi } from "../../utils/api/files.api";
import { membershipApi } from "../../utils/api/membership.api";
import { ApiError } from "../../utils/api/request";
import { fileAccept, fileLimitMiB, fileMetadata } from "../../utils/filePolicy";
import { BlockAvatarPicker } from "./BlockAvatarPicker";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
async function mount() { transport = installMockTransport("chair", { delay: 0 });const block = transport.state.blocks[0];page = await mountWorkspace(<BlockAvatarPicker block={block} />);return block; }
async function choose(name = "block.png") {
  const input = page!.container.querySelector<HTMLInputElement>('input[type="file"]')!, file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [file] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page!, () => !!page!.container.textContent?.includes(`Выбрано: ${name}`));return file;
}
const button = (label: string) => [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;
it("uses the personal-avatar image whitelist and 10 MiB limit for the block context", () => {
  expect(fileLimitMiB("block")).toBe(10);expect(fileAccept("block")).toBe(".png,.jpg,.jpeg,.webp");
  expect(() => fileMetadata("block", { name: "code.txt", type: "text/plain", size: 10 })).toThrow();expect(() => fileMetadata("block", { name: "a.png", type: "image/png", size: 10 * 1024 * 1024 + 1 })).toThrow();
});
it("uploads a completed contextual draft then explicitly saves and clears it with the block revision", async () => {
  const block = await mount(), revision = block.revision, save = vi.spyOn(membershipApi, "updateBlock"), upload = vi.spyOn(filesApi, "upload");
  const file = await choose();expect(upload).toHaveBeenCalledWith(file, { owner_kind: "block", owner_id: block.block_id, purpose: "avatar" }, expect.any(Function), expect.any(AbortSignal));expect(save).not.toHaveBeenCalled();
  const completed = await upload.mock.results[0].value;await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(save).toHaveBeenLastCalledWith(block.block_id, { expected_revision: revision, avatar_file_id: completed.file_id });expect(block.avatar_url).toBe(`/api/files/${completed.file_id}/content`);
  await act(async () => button("Убрать аватар").click());await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(save).toHaveBeenLastCalledWith(block.block_id, { expected_revision: revision + 1, avatar_file_id: null });expect(block.avatar_url).toBeNull();
});
it("a 409 retains the completed draft and never silently retries against a newer revision", async () => {
  await mount();const save = vi.spyOn(membershipApi, "updateBlock").mockRejectedValue(new ApiError("Запись изменилась", 409));
  await choose("keep.png");await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(save).toHaveBeenCalledTimes(1);expect(page!.container.textContent).toContain("Выбрано: keep.png");expect(page!.container.textContent).toContain("Обновить данные");
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);expect(save).toHaveBeenCalledTimes(1);expect(page!.container.textContent).toContain("Выбрано: keep.png");
});
it("failed uploads do not create a bind request and readers never get the editor", async () => {
  const block = await mount(), save = vi.spyOn(membershipApi, "updateBlock");vi.spyOn(filesApi, "upload").mockRejectedValue(new ApiError("Ошибка файла", 422));
  const input = page!.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => { Object.defineProperty(input, "files", { value: [new File(["x"], "a.png", { type: "image/png" })] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page!, () => !!page!.container.querySelector('[role="alert"]'));
  expect(save).not.toHaveBeenCalled();expect(page!.container.textContent).not.toContain("Выбрано:");await page!.cleanup();page = undefined;
  page = await mountWorkspace(<BlockAvatarPicker block={{ ...block, capabilities: [] }} />);expect(page.container.querySelector("form")).toBeNull();
});


it("leaving with a completed avatar draft offers the shared guard and discard never binds it", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  transport = installMockTransport("chair", { delay: 0 });const block = transport.state.blocks[0], avatarBefore = block.avatar_url, save = vi.spyOn(membershipApi, "updateBlock");
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [{ path: "/edit", element: <><BlockAvatarPicker block={block} /><Link to="/next">Дальше</Link></> }, { path: "/next", element: <p>Другая страница</p> }] }], { initialEntries: ["/edit"] });
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  page = { container, client, cleanup: async () => { await act(async () => root.unmount());router.dispose();client.clear();container.remove(); } };
  await choose("draft.png");await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
  expect(router.state.location.pathname).toBe("/edit");expect(container.querySelector("dialog")?.textContent).toContain("Есть несохранённые изменения");
  await act(async () => button("Остаться").click());expect(container.textContent).toContain("Выбрано: draft.png");
  await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());await act(async () => button("Уйти без сохранения").click());
  expect(router.state.location.pathname).toBe("/next");expect(save).not.toHaveBeenCalled();expect(block.avatar_url).toBe(avatarBefore);
});
