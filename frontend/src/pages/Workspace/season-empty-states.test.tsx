// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { SeasonPage } from "./SeasonPages";
import { SummaryTable } from "./SummaryTable";
import { CorrectionsPage, MeritsPage, SourcesPage } from "./MeritPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined; });
const routes = <Routes>
  <Route path="/seasons/:id" element={<SeasonPage />} />
  <Route path="/seasons/:id/merits" element={<MeritsPage />} />
  <Route path="/seasons/:id/sources" element={<SourcesPage />} />
  <Route path="/seasons/:id/corrections" element={<CorrectionsPage />} />
</Routes>;
async function mount(path: string) {
  await page?.cleanup();transport?.restore();
  transport = installMockTransport("chair", { delay: 0 });page = await mountWorkspace(routes, { path });await waitForPage(page);return page;
}
const requested = (pattern: RegExp) => transport!.adapter.history.get.some(request => pattern.test(request.url ?? ""));

it.each(["merits", "sources", "corrections"])("says an unknown season is not found on /%s and asks nothing about it", async subpage => {
  await mount(`/seasons/season-missing/${subpage}`);
  expect(page!.container.querySelector("h1")?.textContent).toBe("Сезон не найден");
  expect([...page!.container.querySelectorAll('a[href="/seasons"]')].map(link => link.textContent)).toContain("Все сезоны");
  expect(page!.container.querySelector("form, select")).toBeNull();
  expect(requested(/season-missing|^\/merits|^\/assessments/)).toBe(false);
});

it("asks no summary for an unknown season on the hub", async () => {
  await mount("/seasons/season-missing");
  expect(page!.container.textContent).toContain("Сезон не найден.");
  expect(requested(/season-missing/)).toBe(false);
});

it("shows a planned season as not open: no summary, no places and no mark menus", async () => {
  await mount("/seasons/season-next");
  const tab = page!.container.querySelector('section[aria-label="Участники и ККР"]')!;
  expect(tab.querySelector("h2")?.textContent).toBe("Сезон ещё не открыт");
  expect(tab.querySelector("a")?.getAttribute("href")).toBe("/seasons/season-next?tab=analytics");
  expect(requested(/\/seasons\/season-next\/summary/)).toBe(false);
  expect(page!.container.querySelector('button[aria-label^="Изменить отметки:"]')).toBeNull();
  expect(page!.container.textContent).not.toContain("Версия 1");
});

it("leaves out places while every total is zero", async () => {
  const summary = structuredClone(createFixtures("chair").summary);
  summary.rows = summary.rows.map((row, index) => ({ ...row, rank: 1, total_score: 0, participant_id: `zero-${index}` }));
  page = await mountWorkspace(<SummaryTable summary={summary} />);
  expect([...page.container.querySelectorAll("tbody tr td:first-child strong")].map(cell => cell.textContent)).toEqual(summary.rows.map(() => "—"));
  await page.cleanup();
  summary.rows[0] = { ...summary.rows[0], total_score: 2.5 };
  page = await mountWorkspace(<SummaryTable summary={summary} />);
  expect(page.container.querySelector("tbody tr td:first-child strong")?.textContent).toBe("1");
});

it.each(["merits", "sources", "corrections"])("names the season and leads back to it on /%s", async subpage => {
  await mount(`/seasons/season-1/${subpage}`);
  expect(page!.container.querySelector("header p")?.textContent).toBe("Сезон «Осень и зима 2026»");
  expect([...page!.container.querySelectorAll('header a[href="/seasons/season-1"]')].map(link => link.textContent)).toContain("К сезону");
});

it("lists detailed accruals as compact rows without the calculation version", async () => {
  await mount("/seasons/season-1/sources");
  const filters = page!.container.querySelector('[aria-label="Фильтры начислений"]')!;
  expect(filters.querySelector('select[name="source_kind"]')).not.toBeNull();
  expect(filters.querySelector('[data-field-name="participant_id"]')).not.toBeNull();
  const table = page!.container.querySelector('table')!;
  expect([...table.querySelectorAll("thead th")].map(cell => cell.textContent)).toEqual(["Участник", "Источник", "Часы", "Оценка", "Дата", "ККР"]);
  expect(table.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  expect(page!.container.textContent).not.toContain("Версия расчёта");
  expect(page!.container.textContent).not.toContain("kkr_v");
});
