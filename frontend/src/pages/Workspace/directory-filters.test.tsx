// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change } from "../../test/workspace";
import { directoryApi } from "../../utils/api/directory.api";
import type { ContactInfoOut } from "../../utils/api/types";
import { DirectoryPage } from "./DirectoryPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

const person = (user_id: number, surname: string, group_number: string, budget: boolean): ContactInfoOut => ({
  user_id, surname, name: "Тест", patronymic: "", kkr_name: surname, group_number, location: "", blocks: "",
  phone: "", vk: "", tg: "", email: `${user_id}@example.com`, budget, in_profcom: true,
});
const select = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label))!.querySelector("select")!;

it("contacts filter by funding and by the course of the group", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([
    person(201, "Первокурсникова", "101", true),
    person(202, "Контрактов", "301", false),
    person(203, "Третьекурсников", " 305", true),
    person(204, "Безгруппов", "", true),
  ]);
  page = await mountWorkspace(<DirectoryPage />, { role: "organizer" });
  await settle(); await settle();
  const shown = () => ["Первокурсникова", "Контрактов", "Третьекурсников", "Безгруппов"].filter((n) => page!.container.textContent!.includes(n));
  expect(shown()).toHaveLength(4);
  expect(Array.from(select(page.container, "Курс").options).map((o) => o.textContent)).toEqual(["Все курсы", "1 курс", "3 курс"]);
  await change(select(page.container, "Форма обучения"), "contract");
  expect(shown()).toEqual(["Контрактов"]);
  await change(select(page.container, "Форма обучения"), "budget");
  expect(shown()).toEqual(["Первокурсникова", "Третьекурсников", "Безгруппов"]);
  await change(select(page.container, "Курс"), "3");
  expect(shown()).toEqual(["Третьекурсников"]);
  await change(select(page.container, "Форма обучения"), "");
  expect(shown()).toEqual(["Контрактов", "Третьекурсников"]);
});

it("contacts use compact cards and separate account management", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([
    person(201, "Первокурсникова", "101", true),
    person(202, "Контрактов", "301", false),
  ]);
  page = await mountWorkspace(<DirectoryPage />, { role: "chair" });
  await settle(); await settle();

  expect(page.container.querySelector('details[class*="filterDetails"]')).not.toBeNull();
  expect(page.container.textContent).toContain("Показано контактов: 2 из 2");
  const cards = page.container.querySelectorAll('[class*="contactGrid"] > section');
  expect(cards).toHaveLength(2);
  const disclosures = cards[0].querySelectorAll("details");
  expect(disclosures[0].querySelector("summary")?.textContent).toBe("Подробнее");
  expect(disclosures[0].querySelector('[class*="contactLinks"]')).not.toBeNull();
  expect(disclosures[0].textContent).not.toContain("Причина архивирования");
  expect(disclosures[1].querySelector("summary")?.textContent).toBe("Управление аккаунтом");
  expect(disclosures[1].textContent).toContain("Причина архивирования");
});
