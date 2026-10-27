// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";
import type { Task } from "../../utils/api/contract";
import { TaskStatusMenu } from "./TaskStatusMenu";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
const task = (status: Task["status"] = "assigned"): Task => ({ ...createFixtures("chair").tasks[0], status, assignees: [], watchers: [], revision: 5, capabilities: ["change_task_status", "take_task"] });
async function takeButton() { const button = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Взять в работу");expect(button).toBeDefined();await act(async () => button!.click());await waitForPage(page!); }
it.each(["assigned", "in_progress"] as const)("uses atomic TAKE for an unassigned reader of %s and keeps the status chip out of actions", async status => {
  const original = task(status), saved = { ...original, status: "in_progress" as const, revision: 6, assignees: [createFixtures("chair").user], capabilities: ["change_task_status"] };
  const take = vi.spyOn(tasksApi, "take").mockResolvedValue(saved), directStatus = vi.spyOn(tasksApi, "changeStatus"), changed = vi.fn();
  page = await mountWorkspace(<TaskStatusMenu task={original} variant="actions" onChanged={changed} />);
  expect(page.container.querySelector('[aria-haspopup="menu"]')).toBeNull();await takeButton();
  expect(take).toHaveBeenCalledExactlyOnceWith(original.task_id, { expected_revision: 5 });expect(directStatus).not.toHaveBeenCalled();expect(changed).toHaveBeenCalledOnce();expect(original.assignees).toEqual([]);
  expect(page.client.getQueryData(["tasks", original.task_id])).toMatchObject({ revision: 6, status: "in_progress", assignees: saved.assignees });
});
it("a direct status-chip choice never invokes TAKE", async () => {
  const original = task(), directStatus = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...original, status: "in_progress", revision: 6 }), take = vi.spyOn(tasksApi, "take");
  page = await mountWorkspace(<TaskStatusMenu task={original} />);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  const option = [...page.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === "В работе")!;await act(async () => option.click());await waitForPage(page);
  expect(directStatus).toHaveBeenCalledExactlyOnceWith(original.task_id, { expected_revision: 5, status: "in_progress" });expect(take).not.toHaveBeenCalled();
});
it("stale TAKE reports the error without publishing a half-joined task", async () => {
  const original = task();vi.spyOn(tasksApi, "take").mockRejectedValue(new ApiError("Версия устарела", 409));
  page = await mountWorkspace(<TaskStatusMenu task={original} variant="actions" />);await takeButton();expect(page.container.querySelector('[role="alert"]')).not.toBeNull();expect(original.assignees).toEqual([]);expect(page.client.getQueryData(["tasks", original.task_id])).toBeUndefined();
});
it("mock TAKE reuses a removed ledger row and preserves its private accounting", async () => {
  transport = installMockTransport("chair", { delay: 0 });const state = transport.state, original = state.tasks[0], own = state.user, assignment = original.assignments[0];
  assignment.assignee = own;original.assignees = [];original.watchers = [own];original.status = "accepted";
  const privateRow = state.assessments.find(row => row.assignment_id === assignment.assignment_id)!;privateRow.workflow_status = "accepted";privateRow.hours = 4;privateRow.evaluation = 1;privateRow.effective_completed_at = "2026-10-20T12:00:00Z";
  const before = structuredClone(privateRow), saved = await tasksApi.take(original.task_id, { expected_revision: original.revision });
  expect(saved.status).toBe("in_progress");expect(saved.assignees).toEqual([own]);expect(saved.watchers).toEqual([]);expect(saved.assignments.filter(row => row.assignee.user_id === own.user_id)).toHaveLength(1);expect(privateRow).toEqual(before);
  await expect(tasksApi.take(saved.task_id, { expected_revision: saved.revision - 1 })).rejects.toMatchObject({ status: 409 });expect(privateRow).toEqual(before);
});
