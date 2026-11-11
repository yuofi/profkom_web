// @vitest-environment jsdom
import MockAdapter from "axios-mock-adapter";
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { api } from "../../utils/api";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, field, change, submit, waitForPage } from "../../test/workspace";
import { RegistrationForm } from "../../components/Workspace/RegistrationForm";
import { registrationFieldsSchema } from "../../utils/contactFields";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let adapter: MockAdapter | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; adapter?.restore(); adapter = undefined; });

async function advance() { await submit(page!.container.querySelector("form")!); await waitForPage(page!); }
async function click(label: string) { await act(async () => [...page!.container.querySelectorAll("button")].find(b => b.textContent === label)!.click()); await waitForPage(page!); }
async function open() {
  const fixture = createFixtures("pending");
  fixture.registration.fields = { ...fixture.registration.fields, phone: "+79990000000", tg: "@student_test",
    vk: "id123", residence: "Москва", no_patronymic: false, patronymic: null };
  adapter = new MockAdapter(api);
  adapter.onPatch("/registrations/me").reply(config => {
    const { fields } = JSON.parse(config.data);
    return [200, { ...fixture.registration, fields, revision: 2 }];
  });
  page = await mountWorkspace(<RegistrationForm application={fixture.registration} />, { role: "pending" });
}

it("requires the applicant to fill patronymic or actively check its absence", async () => {
  await open();
  expect((field(page!.container, "no_patronymic") as HTMLInputElement).checked).toBe(false);
  expect((field(page!.container, "patronymic") as HTMLInputElement).required).toBe(true);
  expect(page!.container.textContent).toContain("Все поля обязательны");
  await submit(page!.container.querySelector("form")!);
  await waitForPage(page!);
  expect(adapter!.history.patch).toHaveLength(0);
  await change(field(page!.container, "patronymic"), "Иванович");
  await change(field(page!.container, "no_patronymic"), "true");
  expect((field(page!.container, "patronymic") as HTMLInputElement).disabled).toBe(true);
  await advance(); await advance();
  expect(adapter!.history.patch).toHaveLength(0);
  await advance();
  await waitForPage(page!, () => adapter!.history.patch.length === 1);
  const sent = JSON.parse(adapter!.history.patch[0].data);
  expect(sent.fields.patronymic).toBeNull();
  expect(sent.fields.no_patronymic).toBe(true);
});

it("unchecking absence restores the required empty patronymic field", async () => {
  await open();
  await change(field(page!.container, "no_patronymic"), "true");
  await change(field(page!.container, "no_patronymic"), "false");
  const input = field(page!.container, "patronymic") as HTMLInputElement;
  expect(input.required).toBe(true); expect(input.value).toBe("");
  await submit(page!.container.querySelector("form")!); await waitForPage(page!);
  expect(adapter!.history.patch).toHaveLength(0);
});

it.each([
  [null, false, false], [" ", false, false], [null, true, true],
  ["Иванович", false, true], ["Иванович", true, false],
])("keeps client validation aligned for patronymic %s and absence %s", (patronymic, no_patronymic, valid) => {
  const fields = createFixtures("pending").registration.fields;
  const result = registrationFieldsSchema.safeParse({ ...fields, phone: "+79990000000", tg: "@student_test",
    vk: "id123", residence: "Москва", patronymic, no_patronymic });
  expect(result.success).toBe(valid);
});

it("keeps one draft through back navigation and does not save intermediate steps", async () => {
  await open(); await change(field(page!.container, "surname"), "Проверочная");
  await change(field(page!.container, "no_patronymic"), "true");
  await advance(); expect(page!.container.textContent).toContain("Шаг 2 из 3");
  await change(field(page!.container, "residence"), "Новый город");
  await click("Назад"); expect(field(page!.container, "surname").value).toBe("Проверочная");
  expect((field(page!.container, "no_patronymic") as HTMLInputElement).checked).toBe(true);
  await advance(); expect(field(page!.container, "residence").value).toBe("Новый город");
  await change(field(page!.container, "group_number"), "999"); await advance();
  expect(page!.container.textContent).toContain("Шаг 2 из 3");
  expect(field(page!.container, "group_number").getAttribute("aria-invalid")).toBe("true");
  expect(adapter!.history.patch).toHaveLength(0);
});
it("returns to an earlier field when the server rejects it on the final save", async () => {
  await open(); adapter!.onPatch("/registrations/me").reply(422, { detail: [{ loc: ["body", "fields", "surname"], msg: "Проверьте фамилию", type: "value_error" }] });
  await change(field(page!.container, "no_patronymic"), "true");
  await advance(); await advance(); await advance();
  expect(adapter!.history.patch).toHaveLength(1);
  expect(page!.container.textContent).toContain("Шаг 1 из 3");
  expect(field(page!.container, "surname").getAttribute("aria-invalid")).toBe("true");
});

it("lets the applicant choose which field to correct after a full-save validation error", async () => {
  await open();
  await change(field(page!.container, "surname"), "");
  await change(field(page!.container, "name"), "");
  await act(async () => page!.container.querySelector("form")!.dispatchEvent(new KeyboardEvent("keydown", { key:"s",ctrlKey:true,bubbles:true,cancelable:true })));
  await waitForPage(page!);
  expect(document.activeElement).toBe(field(page!.container, "surname"));
  await act(async () => field(page!.container, "name").focus());
  await change(field(page!.container, "name"), "Анна");await waitForPage(page!);
  expect(document.activeElement).toBe(field(page!.container, "name"));
  expect(adapter!.history.patch).toHaveLength(0);
});
