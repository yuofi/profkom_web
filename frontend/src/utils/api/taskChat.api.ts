import type { Revision, ScopeRef } from "./contract";
import { request } from "./request";
import type { ChatScope, ChatSettings, ChatLinkCode, TaskChatContext, TaskChatAnnouncement } from "./taskChat.types";
export type { ChatScope, ChatBinding, ChatSettings, ChatLinkCode, TaskChatContext, TaskChatAnnouncement } from "./taskChat.types";

const chatPath = (scope: ChatScope) => `/scopes/${scope.kind}/${encodeURIComponent(scope.id)}/chat`;
export const taskChatApi = {
  settings: (scope: ChatScope) => request<ChatSettings>("get", chatPath(scope)),
  linkCode: (scope: ChatScope, data: Revision) => request<ChatLinkCode>("post", `${chatPath(scope)}/link-code`, data),
  unlink: (scope: ChatScope, data: Revision) => request<ChatSettings>("delete", chatPath(scope), data),
  context: (queueId: string | undefined, scope: ScopeRef | undefined, assigneeUserIds: number[]) => request<TaskChatContext>("get", "/tasks/chat-context", undefined, {
    ...(queueId ? { queue_id: queueId } : scope ? { scope_kind: scope.kind, scope_id: scope.id } : {}),
    ...(assigneeUserIds.length ? { assignee_user_ids: assigneeUserIds.join(",") } : {}),
  }),
  retry: (taskId: string, data: Revision) => request<TaskChatAnnouncement>("post", `/tasks/${encodeURIComponent(taskId)}/chat-announcement/retry`, data),
};
