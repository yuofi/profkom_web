// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace } from "../../test/workspace";
import { SummaryTable } from "./SummaryTable";

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
