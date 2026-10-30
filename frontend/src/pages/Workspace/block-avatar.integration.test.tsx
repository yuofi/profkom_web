// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { membershipApi } from "../../utils/api/membership.api";
import { filesApi } from "../../utils/api/files.api";
import { api } from "../../utils/api";
import { BlockPage } from "./MembershipPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uAAAAAASUVORK5CYII="), char => char.charCodeAt(0));
async function read<T>(request: () => Promise<T>) { let value!: T;await act(async () => { value = await request(); });return value; }
const editor = () => page!.container.querySelector<HTMLFormElement>('dialog form')!;
async function openEditor() { await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Изменить аватар блока"]')!.click());await waitForPage(page!, () => !!editor()?.querySelector('input[type="file"]')); }
it("uploads real block-avatar bytes through the editor, binds explicitly and clears without changing membership", async () => {
  const viewer = await liveParticipant("block-avatar-viewer"), session = await liveLogin();
  const initial = (await membershipApi.blocks()).find(block => block.name === "Integration IT")!;expect(initial).toBeDefined();
  const save = vi.spyOn(membershipApi, "updateBlock"), upload = vi.spyOn(filesApi, "upload");
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${initial.block_id}`, session });await waitForPage(page, () => !!page!.container.querySelector('button[aria-label="Изменить аватар блока"]'));expect(editor()).toBeNull();await openEditor();
  const before = await read(() => membershipApi.block(initial.block_id));
  const input = editor().querySelector<HTMLInputElement>('input[type="file"]')!, file = new File([png], "block-avatar.png", { type: "image/png" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [file] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page, () => !!editor()?.textContent?.includes("Выбрано: block-avatar.png"));
  expect(save).not.toHaveBeenCalled();const completed = await upload.mock.results[0].value;
  await submit(editor());await waitForPage(page, () => !page!.container.querySelector('dialog'));
  expect(save).toHaveBeenCalledWith(initial.block_id, { expected_revision: before.revision, avatar_file_id: completed.file_id });
  const saved = await read(() => membershipApi.block(initial.block_id));expect(saved.avatar_url).toBe(`/api/files/${completed.file_id}/content`);expect(saved.members).toEqual(before.members);expect(saved.master).toEqual(before.master);
  const bytes = await read(() => api.get<ArrayBuffer>(`/files/${completed.file_id}/content`, { responseType: "arraybuffer" }));expect([...new Uint8Array(bytes.data)]).toEqual([...png]);
  await page.cleanup();page = undefined;await liveLogin(viewer.email);
  expect((await membershipApi.block(initial.block_id)).avatar_url).toBe(saved.avatar_url);await expect(membershipApi.updateBlock(initial.block_id, { expected_revision: saved.revision, avatar_file_id: null })).rejects.toMatchObject({ status: 403 });
  const chair = await liveLogin();page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${initial.block_id}`, session: chair });await waitForPage(page, () => !!page!.container.querySelector('button[aria-label="Изменить аватар блока"]'));await openEditor();
  await act(async () => [...editor().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Убрать аватар")!.click());await submit(editor());await waitForPage(page, () => !page!.container.querySelector('dialog'));
  const cleared = await read(() => membershipApi.block(initial.block_id));expect(cleared.avatar_url).toBeNull();expect(cleared.members).toEqual(before.members);
  await expect(read(() => filesApi.download(completed.file_id))).rejects.toMatchObject({ status: 404 });
});
