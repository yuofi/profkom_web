// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { act } from "react";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { FormerContactsPage } from "./DirectoryPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined; });
const addForm = () => Array.from(document.querySelectorAll<HTMLFormElement>("form"))
  .find((form) => form.closest("section, dialog")?.querySelector("h2")?.textContent === "Добавить бывшего участника")!;
// Adding is a header action that opens its dialog (PE-35).
const openAdd = async () => {
  const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Добавить бывшего участника")!;
  await act(async () => button.click());
};

it("a new former card checks the address and starts empty again after its save (PE-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<FormerContactsPage />);await waitForPage(page);
  const before = mock.state.former.length;
  expect(addForm()).toBeUndefined();
  await openAdd();
  let form = addForm();
  await change(field(form, "surname"), "Повторов");await change(field(form, "name"), "Иван");
  await change(field(form, "email"), "not-an-email");await change(field(form, "periods"), "2020–2022");
  await submit(form);await waitForPage(page);
  expect(form.textContent).toContain("Проверьте адрес почты");
  expect(mock.state.former).toHaveLength(before);
  await change(field(form, "email"), "former@example.com");
  await submit(form);await waitForPage(page);
  expect(mock.state.former).toHaveLength(before + 1);
  form = addForm();
  expect(["surname", "name", "email", "periods"].map((name) => field(form, name).value)).toEqual(["", "", "", ""]);
  await submit(form);await waitForPage(page);
  expect(mock.state.former).toHaveLength(before + 1);
});

it("a search without matches says so (PE-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<FormerContactsPage />);await waitForPage(page);
  await change(page.container.querySelector<HTMLInputElement>('input[type="search"]')!, "Несуществующая фамилия");
  expect(page.container.textContent).toContain("Ничего не найдено");
});

it("a card without periods says so and the VK link has its icon (PE-35)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.former[0].participation_periods = [];
  page = await mountWorkspace(<FormerContactsPage />);await waitForPage(page);
  const card = Array.from(page.container.querySelectorAll("section")).find((section) => section.textContent?.includes("former@example.com"))!;
  expect(card.textContent).toContain("Периоды не указаны");
  expect(card.querySelector('a[href="https://vk.com/former"] [class*="vkIcon"]')).not.toBeNull();
});
