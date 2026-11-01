// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountWorkspace, settle } from "../../test/workspace";
import { isTaskPagePath } from "../../utils/routes";
import { FeedbackProvider } from "./FeedbackButton";
import { WorkspaceLayout, WorkspaceSkeleton } from "./WorkspaceLayout";

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

it("GL-20: a narrow tablet up to 960 px tucks it as well (deadline cells reach under it)", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(max-width: 960px)", media, addEventListener() {}, removeEventListener() {} }));
  page = await mountWorkspace(<FeedbackProvider><p>Страница</p></FeedbackProvider>);
  await scrollTo(400);expect(trigger().className).toMatch(/tucked/);
});

it("GL-20: on a phone it steps aside while a text field has focus, not for a checkbox", async () => {
  page = await mountWorkspace(<FeedbackProvider><input name="phone" /><input name="email" /><input type="checkbox" name="agree" /></FeedbackProvider>);
  const input = (name: string) => page!.container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => input("phone").focus());expect(trigger().className).toMatch(/tucked/);
  await act(async () => input("email").focus());expect(trigger().className).toMatch(/tucked/);
  await act(async () => input("agree").focus());expect(trigger().className).not.toMatch(/tucked/);
  await act(async () => input("phone").focus());await act(async () => input("phone").blur());expect(trigger().className).not.toMatch(/tucked/);
  phone = false;
  await page.cleanup();page = await mountWorkspace(<FeedbackProvider><input name="phone" /></FeedbackProvider>);
  await act(async () => input("phone").focus());expect(trigger().className).not.toMatch(/tucked/);
});

it("GL-20: on a wide screen it stays where it is", async () => {
  phone = false;
  page = await mountWorkspace(<FeedbackProvider><p>Страница</p></FeedbackProvider>);
  await scrollTo(400);expect(trigger().className).not.toMatch(/tucked/);
});

it("D-03: only a task page counts, not the task lists that share the prefix", () => {
  for (const path of ["/tasks/task-1", "/tasks/task-1/", "/tasks/queue-key-12"]) expect(isTaskPagePath(path), path).toBe(true);
  for (const path of ["/tasks", "/tasks/", "/tasks/new", "/tasks/unresolved", "/tasks/queues", "/tasks/queues/q-1", "/events/e-1", "/"]) expect(isTaskPagePath(path), path).toBe(false);
  const css = readFileSync(`${__dirname}/FeedbackButton.module.css`, "utf8");
  // The same button and offsets; only the side changes.
  expect(css).toMatch(/\.trigger \{ position: fixed; right: 22px; bottom: 22px;[^}]*width: 48px; height: 48px;/);
  expect(css).toMatch(/(^|\n)\.start \{ right: auto; left: 22px; \}/);
});

it("D-03: on a wide task page the button stands bottom-left below the side menu when it fits, elsewhere bottom-right", async () => {
  let wide = true;
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(min-width: 961px)" && wide, media, addEventListener() {}, removeEventListener() {} }));
  // The chair's menu on the stand: 28 px from the top, 647 px tall, so it ends at 675 px.
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.tagName === "ASIDE" ? new DOMRect(28, 28, 232, 647) : new DOMRect(); });
  const height = (value: number) => act(async () => { Object.assign(window, { innerHeight: value });window.dispatchEvent(new Event("resize")); });
  const layout = (path: string) => mountWorkspace(<FeedbackProvider><Routes><Route element={<WorkspaceLayout />}><Route path="*" element={<h1>Страница</h1>} /></Route></Routes></FeedbackProvider>, { path });
  try {
    await height(900);
    page = await layout("/tasks/task-1");await settle();
    expect(trigger().className).toMatch(/start/);
    // The button needs its 48 px, 22 px below and 8 px above it: 675 + 8 + 70 = 753 px.
    await height(752);expect(trigger().className).not.toMatch(/start/);
    await height(753);expect(trigger().className).toMatch(/start/);
    // The report form opens from there and gives the focus back to the button.
    await act(async () => trigger().focus());await act(async () => trigger().click());await settle();
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Закрыть обращение"]')!;expect(close).not.toBeNull();
    await act(async () => close.click());await settle();
    expect(document.activeElement).toBe(trigger());expect(trigger().className).toMatch(/start/);
    for (const path of ["/tasks", "/tasks/queues", "/tasks/new", "/tasks/unresolved", "/", "/events/e-1"]) {
      await page.cleanup();page = await layout(path);await settle();
      expect(trigger().className, path).not.toMatch(/start/);
    }
    // While the session is checked (F5) the frame's menu registers too: no jump from the other corner.
    await page.cleanup();page = await mountWorkspace(<FeedbackProvider><WorkspaceSkeleton /></FeedbackProvider>, { path: "/tasks/task-1" });
    expect(trigger().className).toMatch(/start/);
    // Below 961 px the menu is a top bar: bottom-right as before, tucking on a scroll down (GL-20).
    wide = false;await page.cleanup();page = await layout("/tasks/task-1");await settle();
    expect(trigger().className).not.toMatch(/start/);
  } finally { rect.mockRestore();Object.assign(window, { innerHeight: 768 }); }
});
