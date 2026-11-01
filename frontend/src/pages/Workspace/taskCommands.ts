import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Task } from "../../utils/api/contract";
import { invalidateWorkspace } from "../../utils/api/invalidation";
import { advanceOwn, recordOwnChange } from "../../components/Workspace/ownRevisions";

/** Optimistic projection of one queued command onto the cached task. */
export type TaskPatch = (task: Task) => Task;
interface Pending { patch?: TaskPatch }
interface Queue { tail: Promise<unknown>; pending: Pending[]; confirmed?: Task; size: number }
const queues = new WeakMap<QueryClient, Map<string, Queue>>();

function queueOf(client: QueryClient, taskId: string) {
  let byTask = queues.get(client);
  if (!byTask) queues.set(client, (byTask = new Map()));
  let queue = byTask.get(taskId);
  if (!queue) byTask.set(taskId, (queue = { tail: Promise.resolve(), pending: [], size: 0 }));
  return queue;
}
const project = (task: Task | undefined, pending: Pending[]) => task && pending.reduce((value, entry) => entry.patch?.(value) ?? value, task);
/** A saved task updates its row in cached task lists at once, keeping each row's own fields;
 * the workspace reread after the queue drains still confirms the lists. */
function showInLists(client: QueryClient, saved: Task) {
  const row = (item: Task): Task => ({ ...item, ...Object.fromEntries(Object.keys(item).filter(field => field in saved).map(field => [field, saved[field as keyof Task]])) });
  const replace = (items: Task[]) => items.some(item => item.task_id === saved.task_id) ? items.map(item => item.task_id === saved.task_id ? row(item) : item) : items;
  client.setQueriesData<{ items: Task[] }>({ queryKey: ["tasks", "page"] }, data => data && Array.isArray(data.items) ? { ...data, items: replace(data.items) } : data);
  client.setQueriesData<Task[]>({ queryKey: ["tasks", "planning"] }, data => Array.isArray(data) ? replace(data) : data);
}

/**
 * Own commands of one task run one at a time, in click order, across every control of the
 * card (checklists, status, take/join, classification, links) and its dialogs (title and
 * description, planning, checklist items, parent, files, new link, result). Each sends the
 * revision the user acted on, advanced at its turn only through this tab's acknowledged own
 * changes: a foreign change still answers 409 and is never retried. The answer replaces the
 * cached task; an optional patch shows the result at once and is rolled back if the command
 * fails; the workspace reread starts once the queue drains, without holding any control.
 */
export async function runTaskCommand(client: QueryClient, taskId: string, baseRevision: number, command: (expectedRevision: number) => Promise<Task>, patch?: TaskPatch): Promise<Task> {
  const key = ["tasks", taskId], record = `task:${taskId}`, queue = queueOf(client, taskId), entry: Pending = { patch };
  void client.cancelQueries({ queryKey: key, exact: true });
  if (!queue.size) queue.confirmed = client.getQueryData<Task>(key);
  queue.size++;queue.pending.push(entry);
  if (patch) client.setQueryData<Task>(key, current => current && patch(current));
  const run = queue.tail.then(async () => {
    const expected = advanceOwn(client, record, baseRevision);
    const saved = await command(expected);
    recordOwnChange(client, record, expected, saved.revision);
    return saved;
  });
  queue.tail = run.catch(() => undefined);
  try {
    const saved = await run;
    queue.pending.splice(queue.pending.indexOf(entry), 1);queue.confirmed = saved;
    client.setQueryData(key, project(saved, queue.pending));showInLists(client, saved);
    return saved;
  } catch (failure) {
    queue.pending.splice(queue.pending.indexOf(entry), 1);
    if (queue.confirmed) client.setQueryData(key, project(queue.confirmed, queue.pending));
    throw failure;
  } finally {
    if (!--queue.size) { queues.get(client)?.delete(taskId);void invalidateWorkspace(client); }
  }
}

/** The queued command runner of one task, bound to the revision currently shown. */
export function useTaskCommand(task: Pick<Task, "task_id" | "revision">) {
  const client = useQueryClient();
  return (command: (expectedRevision: number) => Promise<Task>, patch?: TaskPatch) => runTaskCommand(client, task.task_id, task.revision, command, patch);
}

/** The same queue for a versioned dialog of the task (ActionForm, record `task:<id>`): it
 *  starts from the revision the form holds, so a save right after a checkmark waits for it
 *  instead of being refused as stale. A failure, a foreign 409 too, reaches the form, which
 *  keeps the draft. */
export function useTaskFormCommand(taskId: string) {
  const client = useQueryClient();
  return (formRevision: number, command: (expectedRevision: number) => Promise<Task>) => runTaskCommand(client, taskId, formRevision, command);
}

/** Marks one Markdown task marker of the description, as the server will. */
export function markDescription(task: Task, offset: number, checked: boolean): Task {
  const body = task.description.body;
  if (!/[ xX]/.test(body[offset] ?? "")) return task;
  return { ...task, description: { ...task.description, body: body.slice(0, offset) + (checked ? "x" : " ") + body.slice(offset + 1) } };
}
