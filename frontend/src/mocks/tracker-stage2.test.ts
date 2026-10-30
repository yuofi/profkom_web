// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "./transport";
import { tasksApi } from "../utils/api/tasks.api";
import { taskQueuesApi } from "../utils/api/taskQueues.api";
import { api } from "../utils/api";
import { richText, type TaskType } from "../utils/api/contract";
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(() => { mock?.restore();mock = undefined; });
function start(role: Parameters<typeof installMockTransport>[0] = "chair") { mock = installMockTransport(role, { delay: 0 });return mock.state; }
async function create(title: string, type: TaskType = "task", queueId = mock!.state.queues[0].queue_id) {
  return tasksApi.create({ queue_id: queueId, season_id: mock!.state.seasons[0].season_id, title, description: richText("Синтетическая задача"), deadline_at: "2026-10-29T12:00:00Z", assignees: [], task_type: type, priority: "normal", starts_at: null, checklist: [] });
}
it("keeps defaults, metadata/checklist revisions and public diff separate from private inputs", async () => {
  const state = start(), before = structuredClone({ inputs: state.inputs, assessments: state.assessments }), initial = await tasksApi.get(state.tasks[0].task_id);
  expect(initial).toMatchObject({ task_type: "task", priority: "normal", starts_at: null, checklist: [], is_favorite: false });expect(initial.capabilities).toContain("edit_task_metadata");expect(initial.capabilities).toContain("manage_task_links");expect(initial.capabilities).toContain("edit_task_checklist");
  const saved = await tasksApi.update(initial.task_id, { expected_revision: initial.revision, priority: "urgent", starts_at: "2026-10-24T12:00:00Z", checklist: [{ text: "Проверить материал", checked: false }] });expect(saved.revision).toBe(initial.revision + 1);expect(saved.checklist).toHaveLength(1);
  const item = saved.checklist![0], toggled = await tasksApi.update(saved.task_id, { expected_revision: saved.revision, checklist: [{ ...item, checked: true }] });expect(toggled.checklist![0]).toEqual({ ...item, checked: true });expect({ inputs: state.inputs, assessments: state.assessments }).toEqual(before);expect((await tasksApi.history(saved.task_id)).items.flatMap(event => event.changes ?? []).some(change => change.field === "checklist")).toBe(true);
});
it("stores favorites per actor without public history, timestamps or revisions", async () => {
  const state = start(), initial = await tasksApi.get(state.tasks[0].task_id), saved = await tasksApi.setFavorite(initial.task_id, true);expect(saved.is_favorite).toBe(true);expect(saved.revision).toBe(initial.revision);expect(saved.updated_at).toBe(initial.updated_at);expect((await tasksApi.history(initial.task_id)).items).toEqual([]);
  const actor = state.session.user_id;state.session.user_id = 98765;expect((await tasksApi.get(initial.task_id)).is_favorite).toBe(false);state.session.user_id = actor;expect((await tasksApi.get(initial.task_id)).is_favorite).toBe(true);expect((await tasksApi.setFavorite(initial.task_id, false)).is_favorite).toBe(false);
});
it("creates canonical membership links with inverses and idempotent replay, then removes from either end", async () => {
  start();const member = await create("Участник эпика"), epic = await create("Общий результат", "epic");const saved = await tasksApi.addLink(member.task_id, { expected_revision: member.revision, target_task_id: epic.task_id, kind: "epic" }), group = await tasksApi.get(epic.task_id);
  expect(saved.links?.[0]).toMatchObject({ kind: "epic", task: { task_id: epic.task_id, task_type: "epic" } });expect(group.links?.[0]).toMatchObject({ kind: "epic_member", task: { task_id: member.task_id } });expect(saved.revision).toBe(member.revision + 1);expect(group.revision).toBe(epic.revision + 1);
  const replay = await tasksApi.addLink(member.task_id, { expected_revision: saved.revision, target_task_id: epic.task_id, kind: "epic" });expect(replay.revision).toBe(saved.revision);expect((await tasksApi.history(member.task_id)).items).toHaveLength(2); // one creation, one link
  await tasksApi.removeLink(epic.task_id, group.links![0].link_id, { expected_revision: group.revision });expect((await tasksApi.get(member.task_id)).links).toEqual([]);expect((await tasksApi.get(epic.task_id)).links).toEqual([]);
});
it("rejects second epics and incompatible types while allowing multiple milestones", async () => {
  start();let member = await create("Исполнение");const epic = await create("Эпик", "epic"), another = await create("Другой эпик", "epic"), first = await create("Веха1", "milestone"), second = await create("Веха2", "milestone");member = await tasksApi.addLink(member.task_id, { expected_revision: member.revision, target_task_id: epic.task_id, kind: "epic" });
  await expect(tasksApi.addLink(member.task_id, { expected_revision: member.revision, target_task_id: another.task_id, kind: "epic" })).rejects.toMatchObject({ status: 409, code: "task_epic_conflict" });expect((await tasksApi.get(another.task_id)).revision).toBe(another.revision);
  member = await tasksApi.addLink(member.task_id, { expected_revision: member.revision, target_task_id: first.task_id, kind: "milestone" });member = await tasksApi.addLink(member.task_id, { expected_revision: member.revision, target_task_id: second.task_id, kind: "milestone" });expect(member.links?.filter(link => link.kind === "milestone")).toHaveLength(2);
  await expect(tasksApi.update(epic.task_id, { expected_revision: (await tasksApi.get(epic.task_id)).revision, task_type: "task" })).rejects.toMatchObject({ status: 422 });await expect(tasksApi.update(member.task_id, { expected_revision: member.revision, task_type: "milestone", starts_at: null })).rejects.toMatchObject({ status: 422 });
});
it("rejects dependency cycles, stale commands and foreign checklist IDs without a partial change", async () => {
  start();const a = await create("Первая"), b = await create("Вторая"), first = await tasksApi.addLink(a.task_id, { expected_revision: a.revision, target_task_id: b.task_id, kind: "blocks" });
  await expect(tasksApi.addLink(a.task_id, { expected_revision: a.revision, target_task_id: b.task_id, kind: "related" })).rejects.toMatchObject({ status: 409 });await expect(tasksApi.addLink(b.task_id, { expected_revision: (await tasksApi.get(b.task_id)).revision, target_task_id: a.task_id, kind: "blocks" })).rejects.toMatchObject({ status: 422 });
  await expect(tasksApi.update(a.task_id, { expected_revision: first.revision, checklist: [{ item_id: "foreign", text: "Не подменять", checked: true }] })).rejects.toMatchObject({ status: 422 });expect((await tasksApi.get(a.task_id)).revision).toBe(first.revision);expect((await tasksApi.get(a.task_id)).links).toHaveLength(1);
});
it("filters public metadata and overlapping planned periods and honors a full 100-item page", async () => {
  start();for (let i = 0; i < 22; i++) await create(`Новая задача${i}`);
  let planned = await create("Длинный план");planned = await tasksApi.update(planned.task_id, { expected_revision: planned.revision, priority: "high", starts_at: "2026-10-01T09:00:00Z" });await tasksApi.setFavorite(planned.task_id, true);
  expect((await tasksApi.listPage({ limit: 100 })).items.length).toBeGreaterThan(20);const filtered = await tasksApi.listPage({ favorite: true, priority: "high", task_type: "task", date_from: "2026-10-10T00:00:00Z", date_to: "2026-10-11T23:00:00Z", limit: 100 });expect(filtered.items.map(task => task.task_id)).toEqual([planned.task_id]);expect((await tasksApi.listPage({ date_from: "2026-11-01T00:00:00Z" })).items).toEqual([]);
});
it("masks revoked target references in live relationships, children and link history", async () => {
  const state = start("leader"), scope=(await taskQueuesApi.catalog()).create_scopes![0], publicQueue = await taskQueuesApi.create({scope:{kind:scope.kind,id:scope.id}, key: "PUBLICSTAGE", name: "Доступная", is_private: false }), hiddenQueue = await taskQueuesApi.create({scope:{kind:scope.kind,id:scope.id}, key: "PRIVATESTAGE", name: "Закрываемая", is_private: false });
  const a = await create("Доступная задача", "task", publicQueue.queue_id), b = await create("Скрываемое имя", "task", hiddenQueue.queue_id);await tasksApi.addLink(a.task_id, { expected_revision: a.revision, target_task_id: b.task_id, kind: "related" });
  const queue = state.queues.find(item => item.queue_id === hiddenQueue.queue_id)!;queue.is_private = true;queue.owner = state.people.find(person => person.user_id !== state.session.user_id)!;
  expect((await tasksApi.get(a.task_id)).links).toEqual([]);expect(JSON.stringify(await tasksApi.history(a.task_id))).not.toContain(b.title);await expect(tasksApi.get(b.task_id)).rejects.toMatchObject({ status: 404 });
});
it("rejects removed goals and invalid milestone start without changing the saved task", async () => {
  start();const source = await create("Проверка строгих полей");await expect(api.patch('/tasks/'+source.task_id, { expected_revision: source.revision, goals: ["Не поддерживается"] })).rejects.toMatchObject({ response: { status: 422 } });await expect(tasksApi.update(source.task_id, { expected_revision: source.revision, task_type: "milestone", starts_at: "2026-10-20T12:00:00Z" })).rejects.toMatchObject({ status: 422 });expect((await tasksApi.get(source.task_id)).revision).toBe(source.revision);
});

it("uses an exclusive end for planned-period filtering at the midnight boundary", async () => {
  const state = start(), last = await create("Последняя миллисекунда"), next = await create("Следующая полночь");
  Object.assign(state.tasks.find(item => item.task_id === last.task_id)!, { starts_at: "2026-11-08T20:59:59.999Z", deadline_at: "2026-11-08T20:59:59.999Z" });
  Object.assign(state.tasks.find(item => item.task_id === next.task_id)!, { starts_at: "2026-11-08T21:00:00.000Z", deadline_at: "2026-11-08T22:00:00.000Z" });
  const result = await tasksApi.listPage({ date_from: "2026-11-08T00:00:00.000Z", date_to: "2026-11-08T21:00:00.000Z", limit: 100 });expect(result.items.map(item => item.task_id)).toEqual([last.task_id]);
});
