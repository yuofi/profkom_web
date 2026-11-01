// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace } from "../../test/workspace";
import { SummaryTable } from "./SummaryTable";
import { decisionLabels } from "../../utils/decisions";
import type { Decision } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { plural } from "./seasonAnalyticsView";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });

it("keeps a participant on one line with an icon action and labels every value for the phone cards", async () => {
  const summary = createFixtures("chair").summary, select = vi.fn();
  page = await mountWorkspace(<SummaryTable summary={summary} onParticipantSelect={select} />);
  const row = page.container.querySelector("tbody tr")!, cells = [...row.querySelectorAll("td")];
  expect(cells).toHaveLength(7);
  expect(cells.map(cell => cell.getAttribute("data-label"))).toEqual(["Место", null, "ККР блоков", "ККР мероприятий", "Всего", "Отметки", "Прошлые отметки"]);
  // Group, category and the action share the participant's line instead of three stacked lines.
  const line = cells[1].firstElementChild!;
  expect(line.querySelector("small")?.textContent).toContain(summary.rows[0].category === "junior" ? "Джуниор" : "Активист");
  const action = line.querySelector<HTMLButtonElement>("button")!;
  expect(action.getAttribute("aria-label")).toBe(`Начисления и работа: ${summary.rows[0].user.display_name}`);
  await act(async () => action.click());
  expect(select).toHaveBeenCalledWith(summary.rows[0]);
});

it("folds the participant filters under a counted summary that a phone can open", async () => {
  const { SeasonParticipants } = await import("./SeasonParticipants");
  const { change, field } = await import("../../test/workspace");
  page = await mountWorkspace(<SeasonParticipants summary={createFixtures("chair").summary} />);
  const details = page.container.querySelector<HTMLDetailsElement>('[aria-label="Фильтры участников"] details')!;
  expect(details.querySelector("summary")?.textContent).toBe("Фильтры");
  // The search stays outside the fold; the other filters are inside it.
  expect(details.querySelector('input[type="search"]')).toBeNull();
  expect(details.querySelector('select[name="category"]')).not.toBeNull();
  await change(field(page.container, "category"), "junior");
  expect(details.querySelector("summary")?.textContent).toBe("Фильтры · 1");
});

it("opens the folded filters once the window widens past the phone layout", async () => {
  const { SeasonParticipants } = await import("./SeasonParticipants");
  // A phone-width start: the filters are folded; the wide layout hides the summary that unfolds them.
  const listeners = new Set<() => void>(), query = { matches: false, media: "(min-width: 769px)", addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  try {
    page = await mountWorkspace(<SeasonParticipants summary={createFixtures("chair").summary} />);
    const details = page.container.querySelector<HTMLDetailsElement>('[aria-label="Фильтры участников"] details')!;
    expect(details.open).toBe(false);
    query.matches = true;
    await act(async () => listeners.forEach(listener => listener()));
    expect(details.open).toBe(true);
    await page.cleanup();page = undefined;
    expect(listeners.size).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

it("marks an empty past-marks cell so the phone card can leave it out", async () => {
  const summary = structuredClone(createFixtures("chair").summary);
  summary.rows = [{ ...summary.rows[0], previous_decisions: [] }, { ...summary.rows[0], participant_id: "with-marks", previous_decisions: [Object.keys(decisionLabels)[0] as Decision] }];
  page = await mountWorkspace(<SummaryTable summary={summary} />);
  const past = [...page.container.querySelectorAll('td[data-label="Прошлые отметки"]')];
  expect(past.map(cell => cell.hasAttribute("data-empty"))).toEqual([true, false]);
  expect(past[0].textContent).toBe("Нет отметок");
});

it("keeps search, order, version and XLSX in the first row and the five filters in the second (D-07)", async () => {
  const { SeasonParticipants } = await import("./SeasonParticipants");
  const summary = createFixtures("chair").summary;
  page = await mountWorkspace(<SeasonParticipants summary={summary} />);
  const bar = page.container.querySelector('[aria-label="Фильтры участников"]')!, row = [...bar.children];
  expect(row[0].querySelector('input[type="search"]')).not.toBeNull();
  expect(row[1].querySelector('select[aria-label="Порядок"]')).not.toBeNull();
  // «Предварительные итоги» stay in the header; the caption names the version and the count.
  const count = summary.rows.length;
  expect(row[2].querySelector("p")?.textContent).toBe(`Версия 1 · ${count} ${plural(count, "участник", "участника", "участников")}`);
  expect(row[2].querySelector("button")?.textContent).toBe("Скачать XLSX");
  expect(row[3].tagName).toBe("DETAILS");
  expect([...row[3].querySelectorAll("[name]")].map(item => item.getAttribute("name"))).toEqual(["block__query", "block", "category", "is_master", "is_archived", "marks"]);
  // One order select, outside the folded filters.
  expect(page.container.querySelectorAll('select[aria-label="Порядок"]')).toHaveLength(1);
  expect(row[3].querySelector('select[aria-label="Порядок"]')).toBeNull();
  expect(page.container.textContent).not.toContain("Предварительные итоги");
});

it("keeps the approval date in the caption of an approved summary (D-07)", async () => {
  const { SeasonParticipants } = await import("./SeasonParticipants");
  const summary = { ...createFixtures("chair").summary, state: "approved" as const, version: 3, approved_at: "2026-10-20T10:00:00Z" };
  page = await mountWorkspace(<SeasonParticipants summary={summary} />);
  expect(page.container.querySelector('[aria-label="Фильтры участников"] > div p')?.textContent).toMatch(new RegExp(`^Утверждено ${displayDate(summary.approved_at)} · Версия 3 · ${summary.rows.length} участник`));
});

it("moves the one order select among the folded filters on a phone and back to the first row on a wide screen (D-07)", async () => {
  const { SeasonParticipants } = await import("./SeasonParticipants");
  const { change } = await import("../../test/workspace");
  const listeners = new Set<() => void>(), query = { matches: false, media: "(min-width: 769px)", addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  try {
    page = await mountWorkspace(<SeasonParticipants summary={createFixtures("chair").summary} />);
    const details = page.container.querySelector<HTMLDetailsElement>('[aria-label="Фильтры участников"] details')!;
    const orders = () => [...page!.container.querySelectorAll<HTMLSelectElement>('select[aria-label="Порядок"]')];
    expect(orders()).toHaveLength(1);
    expect(details.contains(orders()[0])).toBe(true);
    await change(orders()[0], "name");
    expect(details.querySelector("summary")?.textContent).toBe("Фильтры · 1");
    query.matches = true;
    await act(async () => listeners.forEach(listener => listener()));
    expect(orders()).toHaveLength(1);
    expect(details.contains(orders()[0])).toBe(false);
    expect(orders()[0].value).toBe("name");
  } finally { vi.unstubAllGlobals(); }
});
