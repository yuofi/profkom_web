// @vitest-environment jsdom
import { act } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle } from "../../test/workspace";
import { isChunkLoadError, reloadOnceForStaleChunk } from "../../utils/chunkReload";
import { WorkspaceLayout } from "./WorkspaceLayout";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); sessionStorage.clear(); });

function Broken({ error }: { error: Error }): never { throw error; }
async function mountBroken(error: Error) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}>
    <Route path="/" element={<p>Главная страница</p>} />
    <Route path="/tasks/:id" element={<><Link to="/">Уйти</Link><Broken error={error} /></>} />
  </Route></Routes>, { path: "/tasks/task-1" });
  await settle();
  return page;
}

it("GL-01: a page that fails to render keeps the menu and offers a way out", async () => {
  const { container } = await mountBroken(new TypeError("Cannot read properties of undefined (reading 'map')"));
  expect(container.querySelector('nav[aria-label="Основная навигация"]')).not.toBeNull();
  const alert = container.querySelector("main [role=alert]")!;
  expect(alert.querySelector("h1")?.textContent).toBe("Не удалось показать страницу");
  expect(alert.textContent).not.toContain("reading 'map'");
  expect([...alert.querySelectorAll("button, a")].map(item => item.textContent)).toEqual(["Обновить страницу", "На главную"]);
  // Another page starts with a clean boundary.
  await act(async () => container.querySelector<HTMLAnchorElement>('main a[href="/"]')!.click());
  expect(container.querySelector("main")?.textContent).toContain("Главная страница");
});

it("GL-01: code removed by a deploy is named and reloads only once", async () => {
  sessionStorage.setItem("profkom-stale-chunk-reload", String(Date.now()));
  const { container } = await mountBroken(new TypeError("Failed to fetch dynamically imported module: /assets/SeasonPages-old.js"));
  expect(container.querySelector('nav[aria-label="Основная навигация"]')).not.toBeNull();
  expect(container.querySelector("main [role=alert] h1")?.textContent).toBe("Сайт обновился");
});

it("GL-01: the stale-code reload has a loop guard", () => {
  expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
  expect(isChunkLoadError(new TypeError("x is undefined"))).toBe(false);
  const reload = vi.fn();
  expect(reloadOnceForStaleChunk(reload, 1_000_000)).toBe(true);
  expect(reloadOnceForStaleChunk(reload, 1_030_000)).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reloadOnceForStaleChunk(reload, 1_100_000)).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});
