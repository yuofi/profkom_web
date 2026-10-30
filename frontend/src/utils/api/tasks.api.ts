import type {
  Task,
  TaskListPageResponse,
  TaskStatusChange,
  TaskHistoryEvent,
  Page,
  TaskCreate,
  Assignment,
  Revision,
  RichText,
  TaskInputs,
  AssessmentInputs,
  Comment,
  UnresolvedAssignment,
  TaskPublicPatch,
  TaskLinkKind,
} from "./contract";
import { idPath, allPages as page, request } from "./request";
/** Body of each assignment command, exactly as the server accepts it: extra keys are 422. */
export interface AssignmentCommands {
  start: Revision;
  resume: Revision;
  "request-help": Revision & { message?: RichText };
  submit: Revision & { text: RichText; links?: string[]; file_ids?: string[] };
  accept: Revision & { evaluation: 1 | 1.5; review_note?: string };
  "request-revision": Revision & { review_note: string };
  "not-complete": Revision & { evaluation: 0 | -1; reason: string };
  cancel: Revision & { reason: string };
}
export const tasksApi = {
  list: (params?: object) => page<Task>("/tasks", params),
  listPage: (params?: object, signal?: AbortSignal) => request<TaskListPageResponse>("get", "/tasks", undefined, params, signal),
  changeStatus: (id: string, data: TaskStatusChange) => request<Task>("post", `/tasks/${idPath(id)}/status`, data),
  submitResult: (id: string, data: Revision & { text: RichText; links?: string[]; file_ids?: string[] }) => request<Task>("post", `/tasks/${idPath(id)}/submit-result`, data),
  take: (id: string, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/take`, data),
  join: (id: string, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/join`, data),
  watch: (id: string, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/watch`, data),
  unwatch: (id: string, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/unwatch`, data),
  removeAssignee: (id: string, userId: number, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/assignees/${idPath(userId)}/remove`, data),
  assign: (id: string, userId: number, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/assignees/${idPath(userId)}/add`, data),
  removeWatcher: (id: string, userId: number, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/watchers/${idPath(userId)}/remove`, data),
  descriptionChecklist: (id: string, data: Revision & {body: string}) => request<Task>("post", `/tasks/${idPath(id)}/description-checklist`, data),
  history: (id: string) => request<Page<TaskHistoryEvent>>("get", `/tasks/${idPath(id)}/history`),
  get: (id: string) => request<Task>("get", `/tasks/${idPath(id)}`),
  create: (data: TaskCreate) => request<Task>("post", "/tasks", data),
  update: (
    id: string,
    data: Revision & TaskPublicPatch,
  ) => request<Task>("patch", `/tasks/${idPath(id)}`, data),
  setFavorite: (id: string, favorite: boolean) => request<Task>("post", `/tasks/${idPath(id)}/favorite`, { favorite }),
  toggleChecklist: (id: string, itemId: string, data: Revision & { checked: boolean }) => request<Task>("post", `/tasks/${idPath(id)}/checklist/${idPath(itemId)}/toggle`, data),
  addLink: (id: string, data: Revision & { target_task_id: string; kind: TaskLinkKind }) => request<Task>("post", `/tasks/${idPath(id)}/links`, data),
  removeLink: (id: string, linkId: string, data: Revision) => request<Task>("delete", `/tasks/${idPath(id)}/links/${idPath(linkId)}`, data),
  command: <C extends keyof AssignmentCommands>(
    id: string,
    command: C,
    data: AssignmentCommands[C],
  ) =>
    request<Assignment>("post", `/assignments/${idPath(id)}/${command}`, data),
  unresolved: (params?: object) =>
    page<UnresolvedAssignment>("/assignments/unresolved", params),
  reassign: (
    id: string,
    data: Revision & {
      new_assignee_user_id: number;
      hours: number;
      previous_outcome: "cancelled" | "not_completed";
      evaluation?: 0 | -1;
      reason: string;
    },
  ) =>
    request<{ previous_assignment: Assignment; assignment: Assignment }>(
      "post",
      `/assignments/${idPath(id)}/reassign`,
      data,
    ),
  inputs: (id: string) =>
    request<TaskInputs>("get", `/tasks/${idPath(id)}/assessment-inputs`),
  updateInputs: (
    id: string,
    data: Revision &
      Partial<Omit<TaskInputs, "task_id" | "capabilities" | "revision">> & {
        reason: string;
      },
  ) =>
    request<TaskInputs>(
      "patch",
      `/tasks/${idPath(id)}/assessment-inputs`,
      data,
    ),
  assessment: (id: string) =>
    request<AssessmentInputs>(
      "get",
      `/assignments/${idPath(id)}/assessment-inputs`,
    ),
  updateAssessment: (
    id: string,
    data: Revision &
      Partial<
        Pick<
          AssessmentInputs,
          "hours" | "evaluation" | "effective_completed_at"
        >
      > & { reason: string; template_selection?: { template_id: string; revision: number } },
  ) =>
    request<AssessmentInputs>(
      "patch",
      `/assignments/${idPath(id)}/assessment-inputs`,
      data,
    ),
  bulkHours: (
    items: { assignment_id: string; expected_revision: number }[],
    hours: number,
    reason: string,
  ) =>
    request<{ items: AssessmentInputs[] }>(
      "post",
      "/assessment-inputs/bulk-hours",
      { items, hours, reason },
    ),
  comments: (id: string) => page<Comment>(`/tasks/${idPath(id)}/comments`),
  comment: (id: string, content: RichText, mentioned_user_ids: number[] = []) =>
    request<Comment>("post", `/tasks/${idPath(id)}/comments`, { content, mentioned_user_ids }),
  editComment: (id: string, content: RichText, mentioned_user_ids: number[] = []) =>
    request<Comment>("patch", `/comments/${idPath(id)}`, { content, mentioned_user_ids }),
};
