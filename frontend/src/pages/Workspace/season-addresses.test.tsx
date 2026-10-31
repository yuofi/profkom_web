// @vitest-environment jsdom
import { type ReactNode } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import type { MockRole } from "../../mocks/fixtures";
import { change, mountWorkspace, waitForPage } from "../../test/workspace";
import { SeasonPage, SeasonsPage, SummaryPage } from "./SeasonPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
function Where() { const location = useLocation();return <output data-where>{location.pathname + location.search}</output>; }
async function mount(element: ReactNode, path: string, role: MockRole = "chair") {
  await page?.cleanup();transport?.restore();
  transport = installMockTransport(role, { delay: 0 });page = await mountWorkspace(<>{element}<Where /></>, { path, role });await waitForPage(page);return page;
}
const where = () => page!.container.querySelector("[data-where]")?.textContent;
const routes = <Routes><Route path="/seasons" element={<SeasonsPage />} /><Route path="/seasons/:id/summary" element={<SummaryPage />} /><Route path="/seasons/:id" element={<SeasonPage />} /></Routes>;

it("replaces the old summary address with the season's own one", async () => {
  await mount(routes, "/seasons/season-1/summary");
  expect(where()).toBe("/seasons/season-1");
  expect(page!.container.querySelector('nav[aria-label="Разделы сезона"] a[aria-current="page"]')?.textContent).toBe("Участники и ККР");
  expect(page!.container.querySelector('[role="status"]')).toBeNull();
});

it("says why the summary is absent when the old address is opened without the right", async () => {
  await mount(routes, "/seasons/season-1/summary", "organizer");
  expect(where()).toBe("/seasons/season-1");
  expect(page!.container.querySelector('[role="status"]')?.textContent).toBe("Итоги сезона доступны председателю, заместителям и HR.");
});

it("addresses the participants tab without a query and keeps the other tabs across seasons", async () => {
  await mount(routes, "/seasons/season-1?tab=history");
  const select = page!.container.querySelector<HTMLSelectElement>('select[aria-label="Выбранный сезон"]')!;
  await change(select, "season-previous");await waitForPage(page!);
  expect(where()).toBe("/seasons/season-previous?tab=history");
  await mount(routes, "/seasons/season-1");
  await change(page!.container.querySelector<HTMLSelectElement>('select[aria-label="Выбранный сезон"]')!, "season-previous");await waitForPage(page!);
  expect(where()).toBe("/seasons/season-previous");
  expect(page!.container.querySelector('nav[aria-label="Разделы сезона"] a')?.getAttribute("href")).toBe("/seasons/season-previous");
});

it("leaves out the participants preview on the participants tab and keeps it on the others", async () => {
  await mount(routes, "/seasons/season-1");
  const workflow = () => [...page!.container.querySelectorAll("details")].find(details => details.textContent?.startsWith("Работа сезона"))!;
  workflow().open = true;workflow().dispatchEvent(new Event("toggle"));await waitForPage(page!);
  expect(workflow().textContent).not.toContain("Участники сезона");
  await mount(routes, "/seasons/season-1?tab=history");
  workflow().open = true;workflow().dispatchEvent(new Event("toggle"));await waitForPage(page!);
  expect(workflow().textContent).toContain("Участники сезона");
  expect([...workflow().querySelectorAll("a")].find(link => link.textContent?.includes("Все участники"))?.getAttribute("href")).toBe("/seasons/season-1");
});

it("names the section like the menu and does not link the stamp to the page itself", async () => {
  await mount(routes, "/seasons");
  const stamp = [...page!.container.querySelectorAll("header *")].find(node => node.textContent?.startsWith("Профком ВМК ·") && node.children.length === 0)!;
  expect(stamp.textContent).toBe("Профком ВМК · Сезоны и ККР");
  expect(stamp.tagName).not.toBe("A");
  await mount(routes, "/seasons/season-1");
  expect(page!.container.querySelector('a[href="/seasons"]')?.textContent).toBe("Профком ВМК · Сезоны и ККР");
});
