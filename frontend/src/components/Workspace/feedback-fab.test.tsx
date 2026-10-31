// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountWorkspace } from "../../test/workspace";
import { FeedbackProvider } from "./FeedbackButton";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, phone = true;
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({ matches: phone, media, addEventListener() {}, removeEventListener() {} })));
afterEach(async () => { await page?.cleanup();page = undefined;phone = true;vi.unstubAllGlobals();Object.assign(window, { scrollY: 0 }); });
const scrollTo = (y: number) => act(async () => { Object.assign(window, { scrollY: y });window.dispatchEvent(new Event("scroll")); });
const trigger = () => page!.container.querySelector<HTMLButtonElement>('button[aria-label^="Сообщить об ошибке"]')!;

it("GL-20: on a phone the feedback button steps aside while scrolling down and returns on scroll up", async () => {
  page = await mountWorkspace(<FeedbackProvider><p>Страница</p></FeedbackProvider>);
  expect(trigger().className).not.toMatch(/tucked/);
  await scrollTo(400);expect(trigger().className).toMatch(/tucked/);
  await scrollTo(300);expect(trigger().className).not.toMatch(/tucked/);
});

it("GL-20: on a wide screen it stays where it is", async () => {
  phone = false;
  page = await mountWorkspace(<FeedbackProvider><p>Страница</p></FeedbackProvider>);
  await scrollTo(400);expect(trigger().className).not.toMatch(/tucked/);
});
