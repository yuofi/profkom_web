// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change } from "../../test/workspace";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
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
  expect(cards[0].querySelector("details")).toBeNull();
  const details = Array.from(cards[0].querySelectorAll("button")).find((b) => b.textContent === "Подробнее")!;
  await act(async () => details.click());
  const dialog = page.container.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[class*="contactLinks"]')).not.toBeNull();
  expect(dialog.textContent).not.toContain("Причина архивирования");
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Закрыть сведения об участнике"]')!.click());
  expect(page.container.querySelector("dialog")).toBeNull();
  const manage = Array.from(cards[0].querySelectorAll("button")).find((b) => b.textContent === "Управление аккаунтом")!;
  await act(async () => manage.click());
  expect(page.container.querySelector("dialog")?.textContent).toContain("Причина архивирования");
  expect(page.container.querySelectorAll('[class*="contactGrid"] > section')).toHaveLength(2);
});

it("links full block names without avatar chips and marks only the explicit master ID", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const title = "Очень длинное название блока для проверки компактной карточки и полной ссылки";
  const master = person(201, "Одинаковая", "301", true), namesake = person(202, "Одинаковая", "301", true);
  namesake.blocks = title;
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([master, namesake]);
  vi.spyOn(membershipApi, "blocks").mockResolvedValue([{ ...mock.state.blocks[0], block_id: "stable-master-block", name: title, master: { ...mock.state.blocks[0].master!, user: { user_id: master.user_id, display_name: "Одинаковая Тест", avatar_url: null } } }]);
  page = await mountWorkspace(<DirectoryPage />, { role: "chair" });
  await settle();await settle();
  const cards = page.container.querySelectorAll('[class*="contactGrid"] > section');
  expect(cards).toHaveLength(2);
  for (const card of cards) {
    const link = card.querySelector<HTMLAnchorElement>('a[href="/blocks/stable-master-block"]')!;
    expect(link.textContent).toBe(title);expect(link.title).toBe(title);
    expect(link.querySelector("img, [class*=avatar]")).toBeNull();
  }
  expect(cards[0].querySelector('[data-block-master="true"]')).not.toBeNull();
  expect(cards[0].querySelector('[data-block-master] a')?.getAttribute("aria-description")).toBe("Руководит блоком");
  expect(cards[0].querySelector('[data-block-master] a svg[aria-hidden="true"]')).not.toBeNull();
  expect(cards[1].querySelector('a[href="/blocks/stable-master-block"] svg')).toBeNull();
  expect(cards[0].textContent).not.toContain("мастер");expect(cards[0].querySelector('[class*="masterBlock"]')).not.toBeNull();
  expect(cards[1].textContent).not.toContain("мастер");expect(cards[1].querySelector('[class*="masterBlock"]')).toBeNull();
  expect(master.blocks).toBe("");
});
