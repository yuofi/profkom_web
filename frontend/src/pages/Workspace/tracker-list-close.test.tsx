// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { TrackerListPage } from "./TrackerList";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; transport?.restore(); transport = undefined; vi.restoreAllMocks(); });
function Location() { const location = useLocation(); return <output data-location>{location.pathname}{location.search}</output>; }

it.each([false, true])("closing from a list checks the saved task's accounting permission (%s)", async (mayViewAccounting) => {
  transport = installMockTransport("chair", { delay: 0 });
  const fixture = createFixtures("chair");
  let task: Task = { ...fixture.tasks[0], status: "completed", allowed_statuses: ["open", "in_progress", "closed"],
    capabilities: ["change_task_status", ...(mayViewAccounting ? [] : ["view_assessment_inputs"])] };
  vi.spyOn(tasksApi, "listPage").mockImplementation(async () => ({ items: [task], next_cursor: null, total: 1, scopes: [], assignees: [] }));
  const save = vi.spyOn(tasksApi, "changeStatus").mockImplementation(async () => {
    task = { ...task, revision: task.revision + 1, status: "closed", closed_at: "2026-10-30T00:00:00Z",
      capabilities: mayViewAccounting ? ["view_assessment_inputs"] : [], allowed_statuses: [] };
    return task;
  });
  const originalRevision = task.revision;
  page = await mountWorkspace(<><Routes><Route path="/tasks" element={<TrackerListPage />} /><Route path="/tasks/:id" element={<p>Описание задачи</p>} /></Routes><Location /></>, { path: "/tasks" });
  await waitForPage(page);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Статус задачи: Выполнена"]')!.click());
  await act(async () => [...page!.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes("Закрыта"))!.click());
  await waitForPage(page, () => save.mock.calls.length === 1 && (mayViewAccounting
    ? page!.container.querySelector("[data-location]")?.textContent === `/tasks/${task.task_id}?kkr=1`
    : !!page!.container.querySelector('[aria-label="Статус задачи: Закрыта"]:not(:disabled)')));
  expect(save).toHaveBeenCalledWith(task.task_id, { expected_revision: originalRevision, status: "closed" });
  expect(page.container.querySelector("[data-location]")?.textContent).toBe(mayViewAccounting ? `/tasks/${task.task_id}?kkr=1` : "/tasks");
  expect(page.container.querySelector("table") !== null).toBe(!mayViewAccounting);
});
