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
