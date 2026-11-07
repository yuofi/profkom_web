// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { takeTask } from "../../test/taskResults";
import { tasksApi } from "../../utils/api/tasks.api";
import type { Task } from "../../utils/api/contract";
import { TaskStatusMenu } from "./TaskStatusMenu";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
const task = (status: Task["status"] = "open"): Task => ({ ...createFixtures("chair").tasks[0], status, assignees: [], watchers: [], revision: 5, capabilities: ["change_task_status", "take_task", "submit_task_result"] });
it.each(["open", "in_progress"] as const)("offers only the status chip for %s, never «Взять в работу» or «Сдать результат» (owner 2026-11-08, В6)", async status => {
  page = await mountWorkspace(<TaskStatusMenu task={task(status)} />);
  const labels = [...page.container.querySelectorAll("button")].map(button => button.textContent?.trim());
  expect(labels).not.toContain("Взять в работу");expect(labels).not.toContain("Сдать результат");
  expect(page.container.querySelector('[aria-haspopup="menu"][aria-label^="Статус задачи:"]')).not.toBeNull();
});
it("a direct status-chip choice changes only the public status", async () => {
  const original = task(), directStatus = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...original, status: "in_progress", revision: 6 });
  page = await mountWorkspace(<TaskStatusMenu task={original} />);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  const option = [...page.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === "В работе")!;await act(async () => option.click());await waitForPage(page);
  expect(directStatus).toHaveBeenCalledExactlyOnceWith(original.task_id, { expected_revision: 5, status: "in_progress" });expect(original.assignees).toEqual([]);
});
it("mock TAKE, kept like the server's endpoint, reuses a removed ledger row and preserves its private accounting", async () => {
  transport = installMockTransport("chair", { delay: 0 });const state = transport.state, original = state.tasks[0], own = state.user, assignment = original.assignments[0];
  assignment.assignee = own;original.assignees = [];original.watchers = [own];original.status = "closed";
  const privateRow = state.assessments.find(row => row.assignment_id === assignment.assignment_id)!;privateRow.workflow_status = "accepted";privateRow.hours = 4;privateRow.evaluation = 1;privateRow.effective_completed_at = "2026-10-20T12:00:00Z";
  const before = structuredClone(privateRow), saved = await takeTask(original.task_id, { expected_revision: original.revision });
  expect(saved.status).toBe("in_progress");expect(saved.assignees).toEqual([own]);expect(saved.watchers).toEqual([]);expect(saved.assignments.filter(row => row.assignee.user_id === own.user_id)).toHaveLength(1);expect(privateRow).toEqual(before);
  await expect(takeTask(saved.task_id, { expected_revision: saved.revision - 1 })).rejects.toMatchObject({ status: 409 });expect(privateRow).toEqual(before);
});
