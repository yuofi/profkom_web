// @vitest-environment jsdom
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemberProfilePage } from "./MemberProfilePage";
import { directoryApi } from "../../utils/api/directory.api";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage } from "../../test/workspace";
vi.mock("../../assets/vk.svg?react", () => ({ default: () => null }));
vi.mock("../../assets/telegram.svg?react", () => ({ default: () => null }));
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
beforeEach(() => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))));
afterEach(async () => { await page?.cleanup(); page = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([true, false])("participant links use only the currently visible directory projection (active: %s)", async active => {
  const person = { ...createFixtures("chair").profile, user_id: 77, surname: "Синтетический", name: "Участник", in_profcom: active };
  const one = vi.spyOn(directoryApi, "contact").mockResolvedValue([person]), all = vi.spyOn(directoryApi, "contacts");
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/77" });
  await waitForPage(page);
  // One directory entry, never the whole directory (PF-15).
  expect(one).toHaveBeenCalledExactlyOnceWith(77);expect(all).not.toHaveBeenCalled();
  if (active) {
    expect(page.container.textContent).toContain("Синтетический Участник");
    expect(page.container.textContent).not.toContain("Управление своим профилем");
  } else {
    expect(page.container.textContent).toContain("Профиль участника недоступен");
    expect(page.container.textContent).not.toContain("Синтетический Участник");
  }
});
it("profile contact links have accessible names and open a call or a letter in one tap (PE-16)", async () => {
  const person = { ...createFixtures("chair").profile, user_id: 78, surname: "Связной", name: "Участник", in_profcom: true, vk: "https://vk.com/id78", tg: "@contact_78", phone: "+7 (999) 000-00-78", email: "contact78@example.com" };
  vi.spyOn(directoryApi, "contact").mockResolvedValue([person]);
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/78" });
  await waitForPage(page);
  expect(page.container.querySelector('a[aria-label="VK"]')?.getAttribute("href")).toContain("vk.com");
  expect(page.container.querySelector('a[aria-label="Telegram"]')?.getAttribute("href")).toContain("t.me");
  expect(page.container.querySelector('a[href="tel:+79990000078"]')?.textContent).toContain("+7 (999) 000-00-78");
  expect(page.container.querySelector('a[href="mailto:contact78@example.com"]')?.textContent).toContain("contact78@example.com");
  // The link's name is the action and the value, not the icon's ligature text.
  expect(page.container.querySelector('a[href="tel:+79990000078"]')?.getAttribute("aria-label")).toBe("Позвонить: +7 (999) 000-00-78");
  expect(page.container.querySelector('a[href="mailto:contact78@example.com"]')?.getAttribute("aria-label")).toBe("Написать: contact78@example.com");
});
it("an old phone without digits stays plain text, not an empty tel: link (PE-16)", async () => {
  const person = { ...createFixtures("chair").profile, user_id: 80, surname: "Старый", name: "Телефон", in_profcom: true, phone: "abc", email: "old80@example.com" };
  vi.spyOn(directoryApi, "contact").mockResolvedValue([person]);
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/80" });
  await waitForPage(page);
  expect(page.container.textContent).toContain("abc");
  expect(page.container.querySelector('a[href^="tel:"]')).toBeNull();
});
it("the participant page is titled with the person's full name (PE-25)", async () => {
  const person = { ...createFixtures("chair").profile, user_id: 79, surname: "Заголовков", name: "Пётр", patronymic: "Ильич", in_profcom: true };
  vi.spyOn(directoryApi, "contact").mockResolvedValue([person]);
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/79" });
  await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Заголовков Пётр Ильич");
});
it("shows a participant from an already loaded directory at once and refuses a malformed id without a request", async () => {
  const person = { ...createFixtures("chair").profile, user_id: 77, surname: "Кэшированный", name: "Участник", in_profcom: true };
  let release!: (value: typeof person[]) => void;
  const one = vi.spyOn(directoryApi, "contact").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });client.setQueryData(["contacts"], [person]);
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/77", client });
  expect(page.container.textContent).toContain("Кэшированный Участник");expect(one).toHaveBeenCalledWith(77);
  await act(async () => release([{ ...person, surname: "Свежий" }]));await waitForPage(page);
  expect(page.container.textContent).toContain("Свежий Участник");
  await page.cleanup();one.mockClear();
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/abc" });await waitForPage(page);
  expect(one).not.toHaveBeenCalled();expect(page.container.textContent).toContain("Профиль участника недоступен");
});
it("the zoomable profile avatar, its zoom window and close button are named in Russian (smoke FV-3)", async () => {
  const person = { ...createFixtures("chair").profile, user_id: 81, surname: "Фотогенов", name: "Пётр", patronymic: "Ильич", in_profcom: true, location: "Общежитие", phone: "abc" };
  vi.spyOn(directoryApi, "contact").mockResolvedValue([person]);
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/81" });
  await waitForPage(page);
  const avatar = page.container.querySelector<HTMLImageElement>('img[role="button"]')!;
  expect(avatar.alt).toBe("Фото: Фотогенов Пётр");expect(page.container.querySelector('img[alt="Avatar"]')).toBeNull();
  // Icons are font ligatures: their English names («location_on», «call») stay out of the card's accessible text.
  const card = avatar.parentElement!.parentElement!;
  expect(card.textContent).toContain("Общежитие");expect(card.querySelectorAll(".material-symbols-rounded").length).toBeGreaterThan(0);
  expect(card.querySelectorAll('.material-symbols-rounded:not([aria-hidden="true"])')).toHaveLength(0);
  avatar.focus();await act(async () => avatar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const zoom = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!, close = zoom.querySelector("button")!;
  expect(zoom.getAttribute("aria-label")).toBe("Просмотр изображения");expect(zoom.querySelector("img")?.alt).toBe("Фото: Фотогенов Пётр");
  expect(close.getAttribute("aria-label")).toBe("Закрыть изображение");expect(document.activeElement).toBe(close);
  await act(async () => close.click());expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();expect(document.activeElement).toBe(avatar);
});
