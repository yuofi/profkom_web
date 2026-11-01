// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountingChip } from "./AccountingChip";
import { createFixtures } from "../../mocks/fixtures";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import type { AssignmentStatus, UnresolvedAssignment } from "../../utils/api/contract";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
function item(): UnresolvedAssignment {
  const fixture = createFixtures("chair"), task = fixture.tasks[0];
  if (!task.season_id || !task.deadline_at) throw new Error("Scoped fixture must retain its season and deadline");
  return { assignment: { ...task.assignments[0], capabilities: ["view_assessment_inputs"], status: "not_completed" }, task_id: task.task_id, task_title: task.title, season_id: task.season_id, scope: { kind: "block", id: "block-info" }, deadline_at: task.deadline_at, scope_title: "Инфо" };
}
it("links to the exact assessment and only mounts its private query when the preview opens", async () => {
  const row = item(), read = vi.spyOn(tasksApi, "assessment").mockResolvedValue({ ...createFixtures("chair").assessments[0], hours: 0, evaluation: 0, workflow_status: "not_completed" });
  page = await mountWorkspace(<AccountingChip item={row} />);await waitForPage(page);expect(read).not.toHaveBeenCalled();const link = page.container.querySelector("a")!;expect(link.getAttribute("href")).toBe(`/tasks/${row.task_id}?assignment_id=${encodeURIComponent(row.assignment.assignment_id)}`);
  await act(async () => link.focus());await waitForPage(page);expect(read).toHaveBeenCalledWith(row.assignment.assignment_id);const preview = document.querySelector('[role="tooltip"]')!;expect(preview.textContent).toContain("Не выполнено");expect([...preview.querySelectorAll("dd")].slice(0, 2).map(node => node.textContent)).toEqual(["0", "0"]);expect(link.getAttribute("aria-describedby")).toBe(preview.id);
});
it("an open task's chip leads to the plain card and says when the assessment becomes available", async () => {
  const row = { ...item(), task_status: "in_progress" as const };vi.spyOn(tasksApi, "assessment").mockResolvedValue({ ...createFixtures("chair").assessments[0], workflow_status: "assigned" });
  page = await mountWorkspace(<AccountingChip item={row} />);await waitForPage(page);const link = page.container.querySelector("a")!;
  expect(link.getAttribute("href")).toBe(`/tasks/${row.task_id}`);
  await act(async () => link.focus());await waitForPage(page);const preview = document.querySelector('[role="tooltip"]')!;
  expect(preview.textContent).toContain("Оценка станет доступна после закрытия задачи.");expect(preview.textContent).not.toContain("Нажмите на чип");
});
it("read-only accounting preview never requests a private endpoint without the input capability", async () => {
  const row = item();row.assignment.capabilities = [];const read = vi.spyOn(tasksApi, "assessment");page = await mountWorkspace(<AccountingChip item={row} />);await act(async () => page!.container.querySelector("a")!.focus());await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Нет доступа");expect(read).not.toHaveBeenCalled();
});
it("a refused assessment refresh removes cached hours and evaluation immediately", async () => {
  const row = item(), read = vi.spyOn(tasksApi, "assessment").mockResolvedValue({ ...createFixtures("chair").assessments[0], hours: 73, evaluation: 1.5, workflow_status: "accepted" });page = await mountWorkspace(<AccountingChip item={row} />);await act(async () => page!.container.querySelector("a")!.focus());await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("73");read.mockRejectedValue(new ApiError("Нет доступа", 403));await act(async () => page!.client.invalidateQueries({ queryKey: ["assessments", row.assignment.assignment_id] }));await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain("73");expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("недоступен");
});
const stateNames: Record<AssignmentStatus, string> = {
  assigned: "Ожидает оценки", in_progress: "В работе", help_required: "Нужны уточнения", submitted: "Ожидает проверки",
  needs_revision: "На доработке", accepted: "Зачтено", not_completed: "Не выполнено", cancelled: "Исключено из ККР",
};
it.each(Object.keys(stateNames) as AssignmentStatus[])("owner 2026-11-01: a «%s» accounting chip is sized by every state name and shows only its own", async (status) => {
  const row = item();row.assignment.status = status;
  page = await mountWorkspace(<AccountingChip item={row} />);await waitForPage(page);
  const link = page.container.querySelector("a")!, label = link.querySelector<HTMLElement>("[data-sizer]")!;
  expect(label.dataset.sizer!.split("\n").sort()).toEqual(Object.values(stateNames).sort());
  expect(label.textContent).toBe(stateNames[status]);expect(link.textContent).toBe(stateNames[status]);
  expect(link.getAttribute("aria-label")).toBe(`Учёт ККР: ${row.assignment.assignee.display_name} · ${stateNames[status]}`);
});
it("owner 2026-11-01: the accounting label box takes the longest name and wraps inside it in a narrow column", () => {
  const css = readFileSync(`${__dirname}/AccountingChip.module.css`, "utf8");
  expect(css).toMatch(/\.label::after \{[^}]*content:attr\(data-sizer\);[^}]*height:0;[^}]*visibility:hidden;[^}]*white-space:pre;/);
  expect(css).toMatch(/\.label \{[^}]*flex-direction:column;[^}]*max-width:100%;/);
  expect(css).toMatch(/\.label>span \{[^}]*text-align:center;/);
});
