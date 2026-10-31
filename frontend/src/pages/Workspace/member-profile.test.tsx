// @vitest-environment jsdom
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
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([person]);
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/77" });
  await waitForPage(page);
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
  vi.spyOn(directoryApi, "contacts").mockResolvedValue([person]);
  page = await mountWorkspace(<Routes><Route path="/contacts/:id" element={<MemberProfilePage />} /></Routes>, { path: "/contacts/78" });
  await waitForPage(page);
  expect(page.container.querySelector('a[aria-label="VK"]')?.getAttribute("href")).toContain("vk.com");
  expect(page.container.querySelector('a[aria-label="Telegram"]')?.getAttribute("href")).toContain("t.me");
  expect(page.container.querySelector('a[href="tel:+79990000078"]')?.textContent).toContain("+7 (999) 000-00-78");
  expect(page.container.querySelector('a[href="mailto:contact78@example.com"]')?.textContent).toContain("contact78@example.com");
});
