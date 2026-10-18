import type { Task, TaskCreate, Assignment, Revision, RichText, TaskInputs, AssessmentInputs, Comment, UnresolvedAssignment } from './contract';
import { idPath, page, request } from './request';
export const tasksApi = {
  list: (params?: object) => page<Task>('/tasks', params),
  get: (id: string) => request<Task>('get', `/tasks/${idPath(id)}`),
  create: (data: TaskCreate) => request<Task>('post', '/tasks', data),
  update: (id: string, data: Revision & { title?: string; description?: RichText }) => request<Task>('patch', `/tasks/${idPath(id)}`, data),
  command: (id: string, command: 'start' | 'request-help' | 'resume' | 'submit' | 'accept' | 'request-revision' | 'not-complete' | 'cancel', data: Revision & { message?: RichText; text?: RichText; links?: string[]; file_ids?: string[]; evaluation?: number; review_note?: string; reason?: string }) => request<Assignment>('post', `/assignments/${idPath(id)}/${command}`, data),
  unresolved: (params?: object) => page<UnresolvedAssignment>('/assignments/unresolved', params),
  reassign: (id: string, data: Revision & { new_assignee_user_id: number; hours: number; previous_outcome: 'cancelled' | 'not_completed'; evaluation?: 0 | -1; reason: string }) => request<{ previous_assignment: Assignment; assignment: Assignment }>('post', `/assignments/${idPath(id)}/reassign`, data),
  inputs: (id: string) => request<TaskInputs>('get', `/tasks/${idPath(id)}/assessment-inputs`),
  updateInputs: (id: string, data: Revision & Partial<Omit<TaskInputs, 'task_id' | 'capabilities' | 'revision'>> & { reason: string }) => request<TaskInputs>('patch', `/tasks/${idPath(id)}/assessment-inputs`, data),
  assessment: (id: string) => request<AssessmentInputs>('get', `/assignments/${idPath(id)}/assessment-inputs`),
  updateAssessment: (id: string, data: Revision & Partial<Pick<AssessmentInputs, 'hours' | 'evaluation' | 'effective_completed_at'>> & { reason: string }) => request<AssessmentInputs>('patch', `/assignments/${idPath(id)}/assessment-inputs`, data),
  bulkHours: (items: { assignment_id: string; expected_revision: number }[], hours: number, reason: string) => request<{ items: AssessmentInputs[] }>('post', '/assessment-inputs/bulk-hours', { items, hours, reason }),
  comments: (id: string) => page<Comment>(`/tasks/${idPath(id)}/comments`),
  comment: (id: string, content: RichText) => request<Comment>('post', `/tasks/${idPath(id)}/comments`, { content }),
  editComment: (id: string, content: RichText) => request<Comment>('patch', `/comments/${idPath(id)}`, { content }),
};
