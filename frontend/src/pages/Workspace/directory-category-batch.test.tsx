// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, change, submit, waitForPage } from "../../test/workspace";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
import { ApiError } from "../../utils/api/request";
import type { ContactInfoOut } from "../../utils/api/types";
import type { ParticipantCategory } from "../../utils/api/contract";
import { DirectoryPage } from "./DirectoryPages";

// The contacts screen must not eagerly load MembershipPages -> EventPages/editors.
vi.mock("./MembershipPages", () => { throw Error("Directory must not import the membership route module"); });

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const person = (id: number): ContactInfoOut => ({ user_id: id, surname: `Контакт ${id}`, name: "Тест", patronymic: "", kkr_name: "Тест", group_number: "301", location: "", blocks: "", phone: "", vk: "", tg: "", email: `${id}@example.com`, budget: true, in_profcom: true });
const category = (id: number, value: "junior" | "activist" = "junior"): ParticipantCategory => ({ user_id: id, category: value, revision: 7, capabilities: [] });
const categorySelect = () => Array.from(page!.container.querySelectorAll("label")).find(l => l.textContent?.startsWith("Категория"))!.querySelector("select")!;
const badges = () => Array.from(page!.container.querySelectorAll('[class*="header"] [class*="category"]')).map(node => node.textContent);

it("uses one batch and zero individual category reads for 100 cards and category filters", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const people = Array.from({ length: 100 }, (_, i) => person(201 + i));
  vi.spyOn(directoryApi, "contacts").mockResolvedValue(people);
  const batch = vi.spyOn(membershipApi, "categories").mockResolvedValue(people.map(p => category(p.user_id, p.user_id % 2 ? "junior" : "activist")));
  const single = vi.spyOn(membershipApi, "category");
  page = await mountWorkspace(<DirectoryPage />, { role: "organizer" });await waitForPage(page);
  expect(batch).toHaveBeenCalledTimes(1);expect(batch).toHaveBeenCalledWith(people.map(p => p.user_id));expect(single).not.toHaveBeenCalled();
  expect(page.container.querySelectorAll('[class*="contactGrid"] > section')).toHaveLength(100);
  await change(categorySelect(), "activist");
  expect(page.container.querySelectorAll('[class*="contactGrid"] > section')).toHaveLength(50);
  expect(batch).toHaveBeenCalledTimes(1);expect(single).not.toHaveBeenCalled();
});

it("keeps missing targets unknown and reports partial categories rather than inventing activist", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([person(201), person(202)]);
  vi.spyOn(membershipApi, "categories").mockResolvedValue([category(201)]);
  page = await mountWorkspace(<DirectoryPage />, { role: "organizer" });await waitForPage(page);
  expect(badges()).toEqual(["Джуниор", "Категория недоступна"]);
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Часть категорий недоступна");
  await change(categorySelect(), "activist");
  expect(page.container.querySelectorAll('[class*="contactGrid"] > section')).toHaveLength(0);
  expect(page.container.textContent).not.toContain("Подходящих контактов нет");
});

it("drops forbidden cached categories and refetches the single batch on retry", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([person(201)]);
  const batch = vi.spyOn(membershipApi, "categories").mockResolvedValue([category(201)]);
  page = await mountWorkspace(<DirectoryPage />, { role: "organizer" });await waitForPage(page);
  expect(badges()).toEqual(["Джуниор"]);
  batch.mockRejectedValueOnce(new ApiError("Access ended", 403, "forbidden"));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["participantCategory"] }); });await waitForPage(page);
  expect(badges()).toEqual(["Категория недоступна"]);
  const retry = Array.from(page.container.querySelectorAll("button")).find(b => b.textContent === "Повторить загрузку категорий")!;
  await act(async () => retry.click());await waitForPage(page);
  expect(badges()).toEqual(["Джуниор"]);expect(batch).toHaveBeenCalledTimes(3);
});

it("reads a fresh individual category only when management opens and preserves reason/revision save", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const single = vi.spyOn(membershipApi, "category");
  const update = vi.spyOn(membershipApi, "updateCategory");
  const batch = vi.spyOn(membershipApi, "categories");
  page = await mountWorkspace(<DirectoryPage />, { role: "chair" });await waitForPage(page);
  expect(single).not.toHaveBeenCalled();expect(batch).toHaveBeenCalledTimes(1);
  const manage = Array.from(page.container.querySelectorAll("button")).find(b => b.textContent === "Управление аккаунтом")!;
  await act(async () => manage.click());await waitForPage(page);
  expect(single).toHaveBeenCalledTimes(1);
  const form = page.container.querySelector<HTMLSelectElement>('dialog select[name="category"]')!.closest("form")!;
  await change(form.querySelector<HTMLSelectElement>('[name="category"]')!, "activist");
  await change(form.querySelector<HTMLTextAreaElement>('[name="reason"]')!, "Подтверждённая ручная смена");
  await submit(form);await waitForPage(page);
  expect(update).toHaveBeenCalledWith(single.mock.calls[0][0], { expected_revision: 1, category: "activist", reason: "Подтверждённая ручная смена" });
  expect(batch.mock.calls.length).toBeGreaterThan(1);
});
