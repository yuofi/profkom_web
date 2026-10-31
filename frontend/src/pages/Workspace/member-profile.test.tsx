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
