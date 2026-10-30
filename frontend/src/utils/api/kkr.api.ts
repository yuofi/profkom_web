import type { TemplateSelection } from './profileFeatures.api';
import type { Criteria, Decision, UserRef } from './contract';
import { idPath, request } from './request';
export type CoefficientKind = 'block' | 'subevent' | 'event' | 'chair' | 'chair_merit' | 'head_merit';
export interface Coefficient { source_kind: CoefficientKind; source_id: string; title: string; parent_title: string | null; value: number; revision: number; capabilities: string[] }
export interface AccountingStatistic extends Coefficient { task_count: number | null; people_count: number | null; tasks_per_person: number | null; mean_kkr: number | null; mean_person_hours: number | null }
export interface AccountingRow { assignment_id: string; assignee: UserRef; hours: number | null; evaluation: -1 | 0 | 1 | 1.5 | null; excluded: boolean; effective_completed_at: string | null; revision: number; is_current: boolean }
export interface AccountingBatch { task_id: string; public_revision: number; revision: number; criteria: Criteria; closed_at: string | null; season_closed: boolean; assigned_at: string; deadline_at: string | null; assignments: AccountingRow[]; capabilities: string[] }
export interface AccountingSave { expected_public_revision: number; expected_revision: number; criteria: Criteria; reason?: string; template_selection?: TemplateSelection; assignments: { assignment_id: string; expected_revision: number; hours: number | null; evaluation: -1 | 0 | 1 | 1.5 | null; excluded: boolean }[] }
export interface KkrHistory { seasons: { season_id: string; title: string; state: string }[]; rows: { participant_id: string; user: UserRef; group_number: string | null; cells: { season_id: string; rank: number | null; total_score: number | null; decisions: Decision[]; preliminary: boolean }[] }[] }
export interface KkrControl { control_id: string; task_id: string; title: string; source_kind: string; source_id: string; status: string; responsibles: UserRef[]; missing_count: number; missing_tasks: { task_id: string; title: string; task_key: string | null; missing_assignees: UserRef[] }[] }
export const kkrApi = {
  batch: (id: string) => request<AccountingBatch>('get', `/tasks/${idPath(id)}/accounting-batch`),
  saveBatch: (id: string, data: AccountingSave) => request<AccountingBatch>('put', `/tasks/${idPath(id)}/accounting-batch`, data),
  statistics: (id: string) => request<{ items: AccountingStatistic[]; preliminary: boolean }>('get', `/seasons/${idPath(id)}/statistics`),
  coefficients: (id: string) => request<{ items: Coefficient[] }>('get', `/seasons/${idPath(id)}/coefficients`),
  coefficient: (id: string, data: { source_kind: CoefficientKind; source_id: string; value: number; expected_revision: number; reason?: string; expected_summary_version?: number }) => request<Coefficient>('put', `/seasons/${idPath(id)}/coefficients`, data),
  history: (params: { count: number; search?: string; block_id?: string; course?: string }) => request<KkrHistory>('get', '/kkr/history', undefined, params),
  controls: (id: string) => request<{ items: KkrControl[]; capabilities: string[] }>('get', `/seasons/${idPath(id)}/kkr-control`),
  remind: (id: string) => request<{ comments_created: number }>('post', `/seasons/${idPath(id)}/kkr-control/remind`, {}),
};
