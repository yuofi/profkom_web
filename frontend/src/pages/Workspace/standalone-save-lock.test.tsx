// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle, change, field, submit, waitForPage } from "../../test/workspace";
import { UserContext } from "../../utils/me";
import { ProfileEditPage } from "../ProfileEditPage/ProfileEditPage";
import { PgasPage } from "../Pgas/PgasPage";
import { MaterialEditor } from "./MaterialEditor";
import { profileFeaturesApi } from "../../utils/api/profileFeatures.api";
import { authApi } from "../../utils/api/auth.api";
import { pgasApi } from "../../utils/api/pgas.api";
import { materialsApi } from "../../utils/api/materials.api";
import type { PgasEntryIn, PgasEntryOut } from "../../utils/api/types";
import * as uploads from "../../utils/s3-utils";

vi.mock("../../assets/vk.svg?react", () => ({ default: () => null }));
vi.mock("../../assets/telegram.svg?react", () => ({ default: () => null }));

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });
const pgasResponse = (data: PgasEntryIn): PgasEntryOut => ({ ...data, file_name: data.file_name ?? "local.pdf", file_type: data.file_type ?? "application/pdf", entry_id: 1234, created_at: "2026-10-26T12:00:00Z", uploaded_by: 1 });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
async function click(container: ParentNode, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!button) throw Error(`Missing button: ${text}`);
  await act(async () => button.click()); await settle();
}
function expectLocked(container: ParentNode) {
  const controls = container.querySelectorAll("input, select, button");
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control.matches(":disabled"), control.outerHTML).toBe(true);
}

it.each([false, true])("profile locks the submitted draft through a delayed save (failure: %s)", async (fails) => {
  mock = installMockTransport("chair", { delay: 0 });
  const pending = deferred();
  const original = profileFeaturesApi.saveEditor;
  const save = vi.spyOn(profileFeaturesApi, "saveEditor").mockImplementation(async (...args) => { await pending.promise; if (fails) throw Error("Синтетический сбой сохранения"); return original(...args); });
  page = await mountWorkspace(<UserContext.Provider value={createFixtures("chair").profile}><ProfileEditPage /></UserContext.Provider>);
  await waitForPage(page);
  const location = field(page.container, "location");
  const form = location.closest("form")!;
  await change(location, "Черновик А"); await submit(form);
  expect(save).toHaveBeenCalledTimes(1);
  expectLocked(form);
  await act(async () => pending.resolve()); await waitForPage(page);
  expect(location.matches(":disabled")).toBe(false);
  expect(location.value).toBe("Черновик А");
  if (fails) expect(form.querySelector('[role="alert"]')).not.toBeNull();
  await change(location, "Черновик Б после сохранения");
  if (!fails) expect(page.container.textContent).toContain("Есть несохранённые изменения");
  expect(location.value).toBe("Черновик Б после сохранения");
});

it.each([false, true])("the password modal cannot erase a pending password change (failure: %s)", async (fails) => {
  mock = installMockTransport("chair", { delay: 0 });
  const pending = deferred();
  const original = authApi.changePassword;
  const save = vi.spyOn(authApi, "changePassword").mockImplementation(async (...args) => { await pending.promise; if (fails) throw Error("Синтетический сбой сохранения"); return original(...args); });
  page = await mountWorkspace(<UserContext.Provider value={createFixtures("chair").profile}><ProfileEditPage /></UserContext.Provider>);
  await waitForPage(page);
  await click(page.container, "Изменить пароль");
  const form = field(page.container, "oldPassword").closest("form")!;
  await change(field(form, "oldPassword"), "local-old-draft");
  await change(field(form, "newPassword"), "local-new-draft");
  await change(field(form, "newPasswordAgain"), "local-new-draft");
  await submit(form);
  expect(save).toHaveBeenCalledTimes(1);
  expectLocked(form);
  const close = page.container.querySelector<HTMLButtonElement>('[aria-label="Закрыть окно пароля"]')!;
  expect(close.disabled).toBe(true);
  await act(async () => close.click());
  expect(form.isConnected).toBe(true);
  await act(async () => pending.resolve()); await waitForPage(page);
  expect(field(form, "newPassword").matches(":disabled")).toBe(false);
  if (fails) expect(field(form, "newPassword").value).toBe("local-new-draft");
});

it.each([false, true])("PGAS locks its file picker, fields and dismissal while a file save is pending (failure: %s)", async (fails) => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(uploads, "uploadFile").mockResolvedValue("file:local-synthetic-file");
  const pending = deferred();
  const save = vi.spyOn(pgasApi, "create").mockImplementation(async (data) => { await pending.promise; if (fails) throw Error("Синтетический сбой сохранения"); return pgasResponse(data); });
  page = await mountWorkspace(<PgasPage />); await waitForPage(page);
  await click(page.container, "Загрузить файл");
  const modal = page.container.querySelector('[role="dialog"]')!;
  await change(field(modal, "title"), "Документ А");
  await change(field(modal, "half_year"), "1");
  const input = modal.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["%PDF-1.4\n"], "local.pdf", { type: "application/pdf" });
  Object.defineProperty(input, "files", { value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await submit(modal.querySelector("form")!);
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: "Документ А", file_name: "local.pdf" }));
  expectLocked(modal);
  await click(modal, "Отмена");
  expect(modal.isConnected).toBe(true);
  await act(async () => pending.resolve()); await waitForPage(page);
  if (fails) {
    expect(modal.isConnected).toBe(true);
    expect(field(modal, "title").value).toBe("Документ А");
    expect(field(modal, "title").matches(":disabled")).toBe(false);
    expect(input.files?.[0]).toBe(file);
    expect(modal.textContent).toContain("local.pdf");
    save.mockImplementation(async (data) => pgasResponse(data));
    await submit(modal.querySelector("form")!); await waitForPage(page);
    expect(uploads.uploadFile).toHaveBeenLastCalledWith("pgas", file);
  }
  expect(modal.isConnected).toBe(false);
});

it.each([[false, false], [false, true], [true, false], [true, true]])("current material editor locks its pending draft and retains failed input (editing: %s, failure: %s)", async (editing, fails) => {
  mock = installMockTransport("chair", { delay: 0 });
  const material = await materialsApi.get(mock.state.materials[0].material_id), pending = deferred(), close = vi.fn();
  const originalCreate = materialsApi.create, originalUpdate = materialsApi.update;
  const create = vi.spyOn(materialsApi, "create").mockImplementation(async data => { await pending.promise;if (fails) throw Error("Синтетический сбой сохранения");return originalCreate(data); });
  const update = vi.spyOn(materialsApi, "update").mockImplementation(async (id, data) => { await pending.promise;if (fails) throw Error("Синтетический сбой сохранения");return originalUpdate(id, data); });
  page = await mountWorkspace(<MaterialEditor material={editing ? material : undefined} onClose={close} />);await waitForPage(page);
  await change(field(page.container, "title"), "Гайд А");
  await change(field(page.container, "description"), "Описание черновика");
  if (!editing) await change(field(page.container, "kind"), "general");
  const form = field(page.container, "title").closest("form")!;
  await submit(form);
  expect((editing ? update : create)).toHaveBeenCalledTimes(1);
  for (const name of ["title", "description", "original", "body", ...(!editing ? ["kind"] : [])]) expect(field(page.container, name).matches(":disabled")).toBe(true);
  await click(page.container, editing ? "Готово" : "Отмена");expect(close).not.toHaveBeenCalled();
  await act(async () => pending.resolve());await waitForPage(page);
  if (fails) {
    expect(field(page.container, "title").value).toBe("Гайд А");
    expect(field(page.container, "description").value).toBe("Описание черновика");
    expect(field(page.container, "title").matches(":disabled")).toBe(false);
    await change(field(page.container, "description"), "Уточнённый черновик");
    create.mockImplementation(originalCreate);update.mockImplementation(originalUpdate);
    await submit(form);await waitForPage(page);
    const saved = editing ? update.mock.calls.at(-1)?.[1] : create.mock.calls.at(-1)?.[0];
    expect(saved).toEqual(expect.objectContaining({ title: "Гайд А", description: "Уточнённый черновик" }));
  }
});
