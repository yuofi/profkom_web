// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace } from "../../test/workspace";
import { SummaryTable } from "./SummaryTable";
import { decisionLabels } from "../../utils/decisions";
import type { Decision } from "../../utils/api/contract";

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
