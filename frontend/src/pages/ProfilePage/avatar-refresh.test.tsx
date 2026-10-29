// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { UserProvider } from "../../utils/ctx";
import { ProfileEditPage } from "../ProfileEditPage/ProfileEditPage";

// The unit config has no SVG components plugin; the icons do not matter here.
vi.mock("../../assets/vk.svg?react", () => ({ default: () => null }));
vi.mock("../../assets/telegram.svg?react", () => ({ default: () => null }));

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
// jsdom has no media queries; the profile card asks for the phone layout.
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({
  matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent: () => false,
})));
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.unstubAllGlobals(); });

it("an avatar remains a draft until the common profile save and refreshes without a reload", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(<UserProvider><ProfileEditPage /></UserProvider>, { role: "organizer", path: "/profile/edit" });
  await waitForPage(page, () => Array.from(page!.container.querySelectorAll("button")).some((button) => button.querySelector("img") && button.textContent));
  const avatar = () => page!.container.querySelector<HTMLImageElement>('img[alt="Avatar"]')!.getAttribute("src");
  const preset = Array.from(page.container.querySelectorAll("button")).find((b) => b.querySelector("img") && b.textContent);
  expect(preset).toBeTruthy();
  const chosen = preset!.querySelector("img")!.getAttribute("src");
  expect(avatar()).not.toBe(chosen);
  await act(async () => preset!.click());
  await waitForPage(page);
  expect(mock.adapter.history.patch.filter(request => request.url === "/profile/me/editor")).toHaveLength(0);
  expect(avatar()).not.toBe(chosen);
  await act(async () => Array.from(page!.container.querySelectorAll("button")).find(button => button.textContent === "Сохранить")!.click());
  await waitForPage(page, () => page!.container.textContent?.includes("Профиль успешно обновлён") ?? false);
  expect(mock.adapter.history.patch.filter(request => request.url === "/profile/me/editor")).toHaveLength(1);
  expect(avatar()).toBe(chosen);
});
