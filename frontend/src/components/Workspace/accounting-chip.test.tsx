// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountingChip } from "./AccountingChip";
import { createFixtures } from "../../mocks/fixtures";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import type { UnresolvedAssignment } from "../../utils/api/contract";
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
it("read-only accounting preview never requests a private endpoint without the input capability", async () => {
  const row = item();row.assignment.capabilities = [];const read = vi.spyOn(tasksApi, "assessment");page = await mountWorkspace(<AccountingChip item={row} />);await act(async () => page!.container.querySelector("a")!.focus());await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Нет доступа");expect(read).not.toHaveBeenCalled();
});
it("a refused assessment refresh removes cached hours and evaluation immediately", async () => {
  const row = item(), read = vi.spyOn(tasksApi, "assessment").mockResolvedValue({ ...createFixtures("chair").assessments[0], hours: 73, evaluation: 1.5, workflow_status: "accepted" });page = await mountWorkspace(<AccountingChip item={row} />);await act(async () => page!.container.querySelector("a")!.focus());await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("73");read.mockRejectedValue(new ApiError("Нет доступа", 403));await act(async () => page!.client.invalidateQueries({ queryKey: ["assessments", row.assignment.assignment_id] }));await waitForPage(page);expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain("73");expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("недоступен");
});
