// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle, submit, waitForPage } from "../../test/workspace";
import { UserContext } from "../../utils/me";
import { ProfileEditPage } from "../../pages/ProfileEditPage/ProfileEditPage";
import { PgasPage } from "../../pages/Pgas/PgasPage";
import { pgasApi } from "../../utils/api/pgas.api";
import { ContactChip } from "../ContactChip/ContactChip";

vi.mock("../../assets/vk.svg?react", () => ({ default: () => null }));
vi.mock("../../assets/telegram.svg?react", () => ({ default: () => null }));

// jsdom has no top layer: showModal stands in for the browser and records that it was used.
const shown: HTMLDialogElement[] = [];
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; shown.push(this); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); shown.length = 0; });
const button = (container: ParentNode, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text)!;
async function open(opener: HTMLButtonElement) { opener.focus(); await act(async () => opener.click()); await settle(); return page!.container.querySelector("dialog")!; }
async function escape(dialog: HTMLDialogElement) { await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true }))); await settle(); }

it("the password window is a modal dialog that Escape closes back to its opener", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<UserContext.Provider value={createFixtures("chair").profile}><ProfileEditPage /></UserContext.Provider>);
  await waitForPage(page);
  const opener = button(page.container, "Изменить пароль");
  const dialog = await open(opener);
  expect(shown).toEqual([dialog]);
  expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Изменение пароля");
  await escape(dialog);
  expect(page.container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("the PGAS upload window names every missing field at once and closes on Escape", async () => {
  vi.spyOn(pgasApi, "getAll").mockResolvedValue([]);
  const create = vi.spyOn(pgasApi, "create");
  page = await mountWorkspace(<PgasPage />); await waitForPage(page);
  const dialog = await open(button(page.container, "Загрузить файл"));
  expect(shown).toEqual([dialog]);
  expect(dialog.querySelector("[required]")).toBeNull();
  expect(dialog.querySelector("form")!.noValidate).toBe(true);
  await submit(dialog.querySelector("form")!); await waitForPage(page);
  expect(create).not.toHaveBeenCalled();
  for (const text of ["Название мероприятия обязательно", "Выберите период документа", "Прикрепите файл"]) expect(dialog.textContent).toContain(text);
  expect(button(dialog, "Выбрать файл").getAttribute("aria-invalid")).toBe("true");
  // The visible label names the file button too.
  const named = button(dialog, "Выбрать файл").getAttribute("aria-labelledby")!.split(" ").map(id => document.getElementById(id)?.textContent);
  expect(named).toEqual(["Файл документа", "Выбрать файл"]);
  await escape(dialog);
  expect(page.container.querySelector("dialog")).toBeNull();
});

it("a contact chip opens from a keyboard button into a modal dialog", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
  page = await mountWorkspace(<ContactChip initialContent={"Фамилия: Иванова\nИмя: Анна\nГруппа: 301"} />);
  const trigger = page.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']")!;
  expect(trigger.textContent).toContain("Иванова Анна");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  const dialog = await open(trigger);
  expect(shown).toEqual([dialog]);
  expect(dialog.getAttribute("aria-label")).toBe("Контакт: Иванова Анна");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await escape(dialog);
  expect(page.container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("a contact chip's avatar is decorative beside the name; the dialog's zoomable one is named in Russian (smoke FV-3)", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
  page = await mountWorkspace(<ContactChip initialContent={"Фамилия: Иванова\nИмя: Анна\nГруппа: 301"} />);
  const chipAvatar = page.container.querySelector("img")!;
  expect(chipAvatar.getAttribute("alt")).toBe("");expect(chipAvatar.getAttribute("role")).toBeNull();
  const dialog = await open(page.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']")!);
  expect(dialog.querySelector<HTMLImageElement>('img[role="button"]')?.alt).toBe("Фото: Иванова Анна");
  // Field icons are font ligatures («person», «groups»): hidden, the Russian labels name the fields.
  expect(dialog.querySelectorAll(".material-symbols-rounded").length).toBeGreaterThan(0);expect(dialog.querySelectorAll('.material-symbols-rounded:not([aria-hidden="true"])')).toHaveLength(0);
  await escape(dialog);await page.cleanup();
  page = await mountWorkspace(<ContactChip initialContent={"Группа: 301"} />);
  const unnamed = await open(page.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']")!);
  expect(unnamed.querySelector<HTMLImageElement>('img[role="button"]')?.alt).toBe("Фото профиля");
});
