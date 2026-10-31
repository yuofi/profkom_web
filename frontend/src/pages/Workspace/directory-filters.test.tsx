// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change, submit } from "../../test/workspace";
import { directoryApi } from "../../utils/api/directory.api";
import { membershipApi } from "../../utils/api/membership.api";
import type { ContactInfoOut } from "../../utils/api/types";
import { DirectoryPage } from "./DirectoryPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  // Archiving is a per-target capability of the category read (PE-01): known mock people.
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([
    person(101, "Первокурсникова", "101", true),
    person(102, "Контрактов", "301", false),
  ]);
  page = await mountWorkspace(<DirectoryPage />, { role: "chair" });
  await settle(); await settle();

  expect(page.container.querySelector('details[class*="filterDetails"]')).not.toBeNull();
  expect(page.container.textContent).toContain("Показано контактов: 2 из 2");
  const cards = page.container.querySelectorAll('[class*="contactGrid"] > section');
  expect(cards).toHaveLength(2);
  expect(cards[0].querySelector("details")).toBeNull();
  expect(cards[0].querySelector('h2 a[href="/contacts/101"]')).not.toBeNull();
  const details = Array.from(cards[0].querySelectorAll("a")).find((link) => link.textContent === "Подробнее")!;
  expect(details.getAttribute("href")).toBe("/contacts/101");
  expect(page.container.querySelector("dialog")).toBeNull();
  const manage = Array.from(cards[0].querySelectorAll("button")).find((b) => b.textContent === "Управление аккаунтом")!;
  await act(async () => manage.click());
  expect(page.container.querySelector("dialog")?.textContent).toContain("Причина архивирования");
  expect(Array.from(page.container.querySelectorAll("dialog h3")).map((h) => h.textContent)).toEqual(["Категория участника", "Архивация аккаунта"]);
  expect(page.container.querySelector('dialog section[class*="dangerZone"] details > summary')?.textContent).toBe("Архивировать аккаунт…");
  expect(page.container.querySelectorAll('[class*="contactGrid"] > section')).toHaveLength(2);
});

it("account management hides archiving that the server refuses and closes before its reread", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([person(101, "Обычная", "101", true), person(104, "Председатель", "301", true)]);
  const category = vi.spyOn(membershipApi, "category");
  page = await mountWorkspace(<DirectoryPage />, { role: "chair" });
  await settle(); await settle();
  const manage = (index: number) => Array.from(page!.container.querySelectorAll('[class*="contactGrid"] > section')[index].querySelectorAll("button")).find((b) => b.textContent === "Управление аккаунтом")!;
  await act(async () => manage(1).click());await settle();
  const chairDialog = page.container.querySelector("dialog")!;
  expect(chairDialog.textContent).not.toContain("Причина архивирования");
  expect(chairDialog.textContent).toContain("Председателя архивируют только после передачи поста");
  await act(async () => chairDialog.querySelector<HTMLButtonElement>('button[aria-label="Закрыть сведения об участнике"]')!.click());
  await act(async () => manage(0).click());await settle();
  const form = Array.from(page.container.querySelectorAll<HTMLFormElement>("dialog form")).find((f) => f.querySelector('[name="reason"]') && f.textContent?.includes("Архивировать аккаунт"))!;
  const reads = category.mock.calls.length;
  expect(reads).toBeGreaterThan(0);
  await change(form.querySelector("textarea")!, "Окончил обучение");
  await submit(form);await settle();await settle();
  expect(mock.adapter.history.post.map((request) => request.url)).toContain("/accounts/101/archive");
  expect(page.container.querySelector("dialog")).toBeNull();
  expect(category.mock.calls.length).toBe(reads);
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

it("widening the window from a phone opens the collapsed filters again (PE-09)", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  let listener: ((event: MediaQueryListEvent) => void) | undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: (_: string, handler: (event: MediaQueryListEvent) => void) => { listener = handler; }, removeEventListener: () => { listener = undefined; } }));
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([person(201, "Первокурсникова", "101", true)]);
  page = await mountWorkspace(<DirectoryPage />, { role: "organizer" });
  await settle();
  const filters = () => page!.container.querySelector<HTMLDetailsElement>('details[class*="filterDetails"]')!;
  expect(filters().open).toBe(false);
  await act(async () => listener!({ matches: true } as MediaQueryListEvent));
  expect(filters().open).toBe(true);
});
