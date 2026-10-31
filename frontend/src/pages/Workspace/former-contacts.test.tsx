// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { FormerContactsPage } from "./DirectoryPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined; });
const addForm = () => Array.from(document.querySelectorAll<HTMLFormElement>("form"))
  .find((form) => form.closest("section, dialog")?.querySelector("h2")?.textContent === "Добавить бывшего участника")!;

it("a new former card checks the address and starts empty again after its save (PE-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<FormerContactsPage />);await waitForPage(page);
  const before = mock.state.former.length;
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
