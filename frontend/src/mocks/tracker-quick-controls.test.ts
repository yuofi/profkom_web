// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "./transport";
import { tasksApi } from "../utils/api/tasks.api";
import { api } from "../utils/api";
import { richText } from "../utils/api/contract";
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(() => { mock?.restore();mock = undefined; });
function reader(closed = false) {
  mock = installMockTransport("organizer", { delay: 0 });
  const state = mock.state, task = state.tasks[0];
  task.assignees = [];task.watchers = [];task.created_by = state.people.find(person => person.user_id !== state.session.user_id)!;
  task.capabilities = task.capabilities.filter(cap => !["edit_task", "edit_task_description", "edit_task_metadata", "edit_task_checklist"].includes(cap));
  task.checklist = [{ item_id: "quick-first", text: "Первый пункт", checked: false }, { item_id: "quick-second", text: "Второй пункт", checked: false }];
  task.starts_at = "2026-10-24T12:00:00Z";
  if (closed) state.seasons.find(season => season.season_id === task.season_id)!.state = "closed";
  return { state, task };
}
function privateData() { return structuredClone({ inputs: mock!.state.inputs, assessments: mock!.state.assessments, summary: mock!.state.summary }); }

it.each([false, true])("lets an unassigned reader classify and toggle in a closed=%s season without protected editing", async closed => {
  const { state, task } = reader(closed), initial = await tasksApi.get(task.task_id), beforePrivate = privateData();
  expect(initial.capabilities).toEqual(expect.arrayContaining(["change_task_type", "change_task_priority", "toggle_task_checklist"]));
  expect(initial.capabilities).not.toEqual(expect.arrayContaining(["edit_task_metadata", "edit_task_checklist"]));
  const priority = await tasksApi.update(task.task_id, { expected_revision: initial.revision, priority: "urgent" });
  expect(priority.priority).toBe("urgent");expect(priority.revision).toBe(initial.revision + 1);
  const milestone = await tasksApi.update(task.task_id, { expected_revision: priority.revision, task_type: "milestone" });
  expect(milestone.task_type).toBe("milestone");expect(milestone.starts_at).toBeNull();expect(milestone.revision).toBe(priority.revision + 1);
  const toggled = await tasksApi.toggleChecklist(task.task_id, "quick-first", { expected_revision: milestone.revision, checked: true });
  expect(toggled.checklist).toEqual([{ item_id: "quick-first", text: "Первый пункт", checked: true }, { item_id: "quick-second", text: "Второй пункт", checked: false }]);
  expect(toggled.revision).toBe(milestone.revision + 1);expect(toggled.status).toBe(initial.status);expect(toggled.assignees).toEqual([]);
  expect(privateData()).toEqual(beforePrivate);
  const events = (await tasksApi.history(task.task_id)).items;
  expect(events.at(-2)?.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: "task_type", before: "task", after: "milestone" }), expect.objectContaining({ field: "starts_at", before: initial.starts_at, after: null })]));
  expect(events.at(-1)).toMatchObject({ kind: "task_updated", description: "Изменена отметка чеклиста", actor: { user_id: state.session.user_id }, changes: [{ field: "checklist", label: "Чеклист", before: ["- [ ] Первый пункт", "- [ ] Второй пункт"], after: ["- [x] Первый пункт", "- [ ] Второй пункт"] }] });
});

it("rejects protected mixed patches atomically and retains old field permissions", async () => {
  const { task } = reader();const before = await tasksApi.get(task.task_id), beforePrivate = privateData();
  for (const extra of [{ starts_at: null }, { checklist: [{ text: "Подмена текста", checked: true }] }, { title: "Подмена названия" }, { description: richText("Подмена описания") }, { file_ids: [] }, { parent_task_id: null }]) {
    await expect(tasksApi.update(task.task_id, { expected_revision: before.revision, priority: "urgent", ...extra })).rejects.toMatchObject({ status: 403 });
    expect(await tasksApi.get(task.task_id)).toEqual(before);
  }
  await expect(tasksApi.update(task.task_id, { expected_revision: before.revision, task_type: "milestone", starts_at: null })).rejects.toMatchObject({ status: 403 });
  expect(await tasksApi.get(task.task_id)).toEqual(before);expect(privateData()).toEqual(beforePrivate);expect((await tasksApi.history(task.task_id)).items).toEqual([]);
});

it("makes per-item toggles idempotent, checks stale versions first and rejects foreign IDs/extra fields", async () => {
  const { task, state } = reader(), before = await tasksApi.get(task.task_id);
  const changed = await tasksApi.toggleChecklist(task.task_id, "quick-first", { expected_revision: before.revision, checked: true });
  const history = await tasksApi.history(task.task_id), timestamp = changed.updated_at;
  const replay = await tasksApi.toggleChecklist(task.task_id, "quick-first", { expected_revision: changed.revision, checked: true });
  expect(replay.revision).toBe(changed.revision);expect(replay.updated_at).toBe(timestamp);expect(await tasksApi.history(task.task_id)).toEqual(history);
  await expect(tasksApi.toggleChecklist(task.task_id, "quick-first", { expected_revision: before.revision, checked: true })).rejects.toMatchObject({ status: 409 });
  state.tasks.push({ ...structuredClone(task), task_id: "foreign-task", checklist: [{ item_id: "foreign-item", text: "Другой пункт", checked: false }] });
  await expect(tasksApi.toggleChecklist(task.task_id, "foreign-item", { expected_revision: changed.revision, checked: true })).rejects.toMatchObject({ status: 404 });
  await expect(tasksApi.toggleChecklist(task.task_id, "missing-item", { expected_revision: before.revision, checked: true })).rejects.toMatchObject({ status: 409 });
  await expect(api.post(`/tasks/${task.task_id}/checklist/quick-first/toggle`, { expected_revision: changed.revision, checked: false, text: "Подмена" })).rejects.toMatchObject({ response: { status: 422 } });
  await expect(api.post(`/tasks/${task.task_id}/checklist/quick-first/toggle`, { expected_revision: changed.revision, checked: "false" })).rejects.toMatchObject({ response: { status: 422 } });
  expect((await tasksApi.get(task.task_id)).checklist).toEqual(changed.checklist);expect((await tasksApi.get("foreign-task")).checklist![0].checked).toBe(false);
});

it("keeps one-epic and multi-milestone group constraints on reader classification", async () => {
  mock = installMockTransport("chair", { delay: 0 });const state = mock.state;
  const make = async (title: string, task_type: "task" | "epic" | "milestone") => tasksApi.create({ queue_id: state.queues[0].queue_id, season_id: state.seasons[0].season_id, title, task_type, priority: "normal", description: richText(""), deadline_at: "2026-10-29T12:00:00Z", assignees: [] });
  let task = await make("Работа", "task");const epic = await make("Результат", "epic"), mile1 = await make("Первая веха", "milestone"), mile2 = await make("Вторая веха", "milestone");
  task = await tasksApi.addLink(task.task_id, { expected_revision: task.revision, target_task_id: epic.task_id, kind: "epic" });
  task = await tasksApi.addLink(task.task_id, { expected_revision: task.revision, target_task_id: mile1.task_id, kind: "milestone" });
  task = await tasksApi.addLink(task.task_id, { expected_revision: task.revision, target_task_id: mile2.task_id, kind: "milestone" });
  const before = await tasksApi.get(task.task_id);
  await expect(tasksApi.update(task.task_id, { expected_revision: before.revision, task_type: "epic", priority: "urgent" })).rejects.toMatchObject({ status: 422, code: "task_type_conflict" });
  expect(await tasksApi.get(task.task_id)).toEqual(before);expect(before.links?.filter(link => link.kind === "milestone")).toHaveLength(2);
  const repeated = await tasksApi.update(task.task_id, { expected_revision: before.revision, priority: "normal" });expect(repeated.revision).toBe(before.revision);
});
