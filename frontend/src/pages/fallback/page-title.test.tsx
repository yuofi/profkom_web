// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotFoundPage } from "./NotFoundPage";
import { env } from "../../utils/env";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })));
afterEach(async () => { await act(async () => root?.unmount());root = undefined;document.body.innerHTML = "";vi.unstubAllGlobals(); });

it("PF-11: a page sets its title with React's own <title>, without a provider", async () => {
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><NotFoundPage /></MemoryRouter>));
  expect(document.title).toBe("404: Страница не найдена | Профком ВМК");
  await act(async () => root!.unmount());root = undefined;
  expect(document.head.querySelector("title")?.textContent ?? "").not.toContain("404");
});

it("PF-11: the build settings are checked without a schema library", () => {
  expect(env.VITE_BACKEND_URL.length).toBeGreaterThan(0);
  expect(["development", "production", "test"]).toContain(env.VITE_ENVIRONMENT);
});
