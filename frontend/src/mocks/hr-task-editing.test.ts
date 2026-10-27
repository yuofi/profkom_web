// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "./transport";
import { tasksApi } from "../utils/api/tasks.api";
import { richText } from "../utils/api/contract";
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(() => { mock?.restore();mock = undefined; });
function setup(role: "hr" | "hr-deputy", independent = false, closed = false) {
  mock = installMockTransport(role, { delay: 0 });const state = mock.state, task = state.tasks[0];
  const other = state.people.find(person => person.user_id !== state.session.user_id)!;
  task.created_by = other;task.assignees = [];task.capabilities = task.capabilities.filter(cap => !["edit_task", "edit_task_description"].includes(cap));
  if (independent) {
    const queue = { ...state.queues[0], queue_id: "foreign-private-queue", scope: null, owner: other, is_private: true };state.queues.push(queue);
    task.scope = { kind: "queue", id: queue.queue_id };task.queue = { queue_id: queue.queue_id, name: queue.name, key: queue.key };
  }
  if (closed) state.seasons.find(season => season.season_id === task.season_id)!.state = "closed";
  return task;
}
it.each([false, true])("lets the HR master edit another author's task and Markdown checklist (independent: %s)", async independent => {
  const task = setup("hr", independent), beforePrivate = structuredClone({ inputs: mock!.state.inputs, assessments: mock!.state.assessments, summary: mock!.state.summary });
  let current = await tasksApi.get(task.task_id);expect(current.capabilities).toEqual(expect.arrayContaining(["edit_task", "edit_task_description", "edit_task_metadata", "edit_task_checklist"]));
  current = await tasksApi.update(task.task_id, { expected_revision: current.revision, title: "Проверенная задача", description: richText("- [x] Проверено HR") });
  expect(current.title).toBe("Проверенная задача");expect(current.description.body).toBe("- [x] Проверено HR");expect(current.assignees).toEqual([]);
  expect({ inputs: mock!.state.inputs, assessments: mock!.state.assessments, summary: mock!.state.summary }).toEqual(beforePrivate);
  expect((await tasksApi.history(task.task_id)).items.flatMap(event => event.changes ?? []).map(change => change.field)).toEqual(expect.arrayContaining(["title", "description"]));
});
it.each([false, true])("keeps closed-season task edits unavailable to a non-owner HR master (independent: %s)", async independent => {
  const task = setup("hr", independent, true), current = await tasksApi.get(task.task_id);
  expect(current.capabilities).not.toContain("edit_task");expect(current.capabilities).not.toContain("edit_task_description");
  await expect(tasksApi.update(task.task_id, { expected_revision: current.revision, description: richText("Подмена") })).rejects.toMatchObject({ status: 403 });
});
it("does not turn an HR deputy's global read access into global editing", async () => {
  const task = setup("hr-deputy", true), current = await tasksApi.get(task.task_id);expect(current.capabilities).toContain("change_task_type");expect(current.capabilities).not.toContain("edit_task");
  await expect(tasksApi.update(task.task_id, { expected_revision: current.revision, description: richText("Подмена") })).rejects.toMatchObject({ status: 403 });
});
