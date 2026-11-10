// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { Task } from "../../utils/api/contract";
import { TaskCreateForm } from "./TaskCreateForm";
import { TaskSeasonParameter } from "./TaskSeasonParameter";
import { TaskStatusMenu } from "./TaskStatusMenu";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const fixture = () => createFixtures("chair");
const missingTask = (): Task => ({ ...fixture().tasks[0], scope: { kind: "block", id: "block-info" }, season_id: null, revision: 7, status: "completed", capabilities: ["change_task_status", "assign_season"], allowed_statuses: ["closed", "open", "in_progress"] });
const click = async (label: string) => { const button = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;expect(button).toBeDefined();await act(async () => button.click());await waitForPage(page!); };

async function creation(noSeasons = false) {
  mock = installMockTransport("chair", { delay: 0 });
  if (noSeasons) mock.state.seasons = [];
  const queue = { ...mock.state.queues[0], queue_id: "block-queue", key: "BLOCK", scope: { kind: "block" as const, id: "block-info" }, capabilities: ["create_task"], task_creation: { available: true, reason: null } };
  mock.state.queues.push(queue);
  vi.spyOn(taskQueuesApi, "get").mockResolvedValue(queue);
  const create = vi.spyOn(tasksApi, "create").mockResolvedValue(missingTask());
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TaskCreateForm queueId={queue.queue_id} />} /><Route path="/tasks/:id" element={<p>Создана</p>} /></Routes>, { path: "/tasks/new" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));return create;
}
it("keeps explicit Укажу позже through rerenders and sends null without requiring an open season", async () => {
  const create = await creation();
  const season = field(page!.container, "season");await change(season, "");
  await change(field(page!.container, "title"), "Задача без сезона");
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["seasons"] }); });await waitForPage(page!);
  expect(field(page!.container, "season").value).toBe("");
  await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create).toHaveBeenCalledOnce();expect(create.mock.calls[0][0].season_id).toBeNull();
});
it("offers block creation when the season list is empty", async () => {
  const create = await creation(true);
  expect(field(page!.container, "season").value).toBe("");
  await change(field(page!.container, "title"), "Подготовка будущей работы");await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(create).toHaveBeenCalledOnce();expect(create.mock.calls[0][0].season_id).toBeNull();
});
it("shows a missing-season badge and first assignment to a capable ordinary editor", async () => {
  const task = missingTask(), seasons = fixture().seasons.map((season, index) => ({ ...season, state: index === 0 ? "summarizing" as const : "closed" as const }));
  vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: seasons, next_cursor: null });
  const update = vi.spyOn(tasksApi, "update").mockResolvedValue({ ...task, season_id: seasons[0].season_id, revision: 8 });
  page = await mountWorkspace(<dl><TaskSeasonParameter task={task} /></dl>, { session: { ...fixture().session, capabilities: [] } });await waitForPage(page);
  expect(page.container.textContent).toContain("Укажите сезон до закрытия");await click("Указать сезон");
  expect([...page.container.querySelectorAll("option")].some(option => option.value === seasons[1]?.season_id)).toBe(false);
  await change(field(page.container, "season_id"), seasons[0].season_id);await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(update).toHaveBeenCalledExactlyOnceWith(task.task_id, { expected_revision: 7, season_id: seasons[0].season_id });expect(page.container.querySelector("dialog")).toBeNull();
});
it("does not offer initial assignment without the task capability", async () => {
  vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: fixture().seasons, next_cursor: null });
  page = await mountWorkspace(<dl><TaskSeasonParameter task={{ ...missingTask(), capabilities: [] }} /></dl>);await waitForPage(page);
  expect(page.container.textContent).toContain("Укажите сезон до закрытия");expect(page.container.querySelector("button")).toBeNull();
});
it("keeps the initial-assignment editor while an in-flight save receives an assigned task projection", async () => {
  const original = missingTask(), saved = { ...original, season_id: fixture().seasons[0].season_id, revision: 8, capabilities: [] };
  vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: fixture().seasons, next_cursor: null });
  let resolveSave!: (task: Task) => void, updateProjection!: (task: Task) => void;
  const update = vi.spyOn(tasksApi, "update").mockImplementation(() => new Promise<Task>(resolve => { resolveSave = resolve; }));
  function Probe() { const [task, setTask] = useState(original);updateProjection = setTask;return <dl><TaskSeasonParameter task={task} /></dl>; }
  page = await mountWorkspace(<Probe />);await waitForPage(page);await click("Указать сезон");
  await change(field(page.container, "season_id"), saved.season_id);await submit(page.container.querySelector("form")!);
  expect(update).toHaveBeenCalledOnce();await act(async () => updateProjection(saved));
  expect(page.container.querySelector("dialog")?.textContent).toContain("Укажите сезон, в котором будет учитываться работа");
  expect(page.container.querySelector('dialog [name="target"]')).toBeNull();
  await act(async () => resolveSave(saved));await waitForPage(page);expect(page.container.querySelector("dialog")).toBeNull();
});
async function closeDialog() {
  const task = missingTask();vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: fixture().seasons, next_cursor: null });
  const status = vi.spyOn(tasksApi, "changeStatus").mockResolvedValue({ ...task, status: "closed", season_id: fixture().seasons[0].season_id, revision: 8 });
  const patch = vi.spyOn(tasksApi, "update"), closed = vi.fn();
  page = await mountWorkspace(<TaskStatusMenu task={task} onClosed={closed} />);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());await click("Закрыта");
  return { status, patch, closed, task };
}
it("closing a seasonless block task opens a chooser; cancelling writes nothing", async () => {
  const { status, patch, closed } = await closeDialog();expect(page!.container.querySelector("dialog")).not.toBeNull();
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Закрыть окно"]')!.click());await waitForPage(page!);
  expect(status).not.toHaveBeenCalled();expect(patch).not.toHaveBeenCalled();expect(closed).not.toHaveBeenCalled();expect(page!.container.querySelector("dialog")).toBeNull();
});
it("assigns and closes in one status command, then invokes the existing KKR callback", async () => {
  const { status, patch, closed, task } = await closeDialog();
  await change(field(page!.container, "season_id"), fixture().seasons[0].season_id);await submit(page!.container.querySelector("form")!);await waitForPage(page!);
  expect(status).toHaveBeenCalledExactlyOnceWith(task.task_id, { expected_revision: 7, status: "closed", season_id: fixture().seasons[0].season_id });expect(patch).not.toHaveBeenCalled();expect(closed).toHaveBeenCalledOnce();expect(closed.mock.calls[0][0].status).toBe("closed");
});
