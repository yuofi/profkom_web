import type { Page, Revision, ScopeRef, TaskQueue, TaskQueueAccessRequest, TaskQueueCatalog } from "./contract";
import { allPages, idPath, request } from "./request";
export const taskQueuesApi = {
  catalog: async (): Promise<TaskQueueCatalog> => {
    const first = await request<TaskQueueCatalog>("get", "/task-queues");
    const items = [...first.items];
    const seen = new Set<string>();
    let cursor = first.next_cursor;
    while (cursor) {
      if (seen.has(cursor) || seen.size >= 100) throw new Error("Не удалось загрузить каталог очередей");
      seen.add(cursor);
      const next = await request<TaskQueueCatalog>("get", "/task-queues", undefined, { cursor });
      items.push(...next.items);cursor = next.next_cursor;
    }
    return { ...first, items, next_cursor: null };
  },
  get: (id: string) => request<TaskQueue>("get", `/task-queues/${idPath(id)}`),
  create: (data: { name: string; key: string; scope?: ScopeRef | null; owner_user_id?: number; is_private: boolean }) => request<TaskQueue>("post", "/task-queues", { ...data, scope: data.scope ? { kind: data.scope.kind, id: data.scope.id } : null }),
  update: (id: string, data: Revision & { name?: string; owner_user_id?: number; is_private?: boolean }) => request<TaskQueue>("patch", `/task-queues/${idPath(id)}`, data),
  requestAccess: (id: string, message: string) => request<TaskQueue>("post", `/task-queues/${idPath(id)}/access-requests`, { message }),
  requests: (id: string): Promise<Page<TaskQueueAccessRequest>> => allPages(`/task-queues/${idPath(id)}/access-requests`),
  decide: (id: string, requestId: string, decision: "approve" | "reject", expected_revision: number) => request<TaskQueueAccessRequest>("post", `/task-queues/${idPath(id)}/access-requests/${idPath(requestId)}/${decision}`, { expected_revision }),
  revoke: (id: string, userId: number, expected_revision: number) => request<TaskQueueAccessRequest>("post", `/task-queues/${idPath(id)}/members/${idPath(userId)}/revoke`, { expected_revision }),
};
