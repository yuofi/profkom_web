import { allPages, request } from "./request";
import type { DiagnosticEvent } from "../diagnostics";
import { api } from "./index";
export interface SupportContext { configured: boolean; revision: number; block_id: string | null; queue_id: string | null; can_configure: boolean; can_manage_staff: boolean; can_triage: boolean; staff_user_ids: number[] }
export interface FeedbackReceipt { report_id: string; state: string; revision: number; kind: "bug" | "feature"; task_id: string | null; task_key: string | null; diagnostics_expires_at: string }
export interface FeedbackInput { kind: "bug" | "feature"; title: string; body: string; contact: string | null; idempotency_key: string; diagnostics: { version: string; route: string; width: number; height: number; events: DiagnosticEvent[]; screen?: { active_tab: string; open_layers: ("dialog" | "popover" | "menu")[]; filters: string[] } } | null; screenshot: string | null }
export interface SupportReport extends FeedbackReceipt { title: string; body: string; contact: string | null; created_at: string }
export interface SupportTask extends FeedbackReceipt { can_triage: boolean; diagnostics_expired: boolean; diagnostics: FeedbackInput["diagnostics"]; has_screenshot: boolean; notes: { note_id: string; body: string; created_at: string }[] }
export const supportApi = {
  context: () => request<SupportContext>("get", "/support/context"),
  configure: (block_id: string, expected_revision: number) => request<SupportContext>("put", "/support/settings", { block_id, expected_revision }),
  staff: (user_ids: number[], expected_revision: number) => request<SupportContext>("put", "/support/staff", { user_ids, expected_revision }),
  submit: (payload: FeedbackInput) => request<FeedbackReceipt>("post", "/feedback", payload),
  reports: () => allPages<SupportReport>("/support/reports"),
  mine: () => allPages<Omit<SupportReport, "contact">>("/feedback/mine"),
  pending: (id: string, payload: { expected_revision: number; title?: string; body?: string; withdraw?: boolean }) => request<FeedbackReceipt>("patch", `/feedback/${encodeURIComponent(id)}`, payload),
  task: (id: string) => request<SupportTask>("get", `/support/tasks/${encodeURIComponent(id)}`),
  note: (id: string, body: string) => request<{ note_id: string }>("post", `/support/tasks/${encodeURIComponent(id)}/notes`, { body }),
  deadline: (id: string, deadline_at: string | null, expected_revision: number) => request<{ revision: number }>("put", `/support/tasks/${encodeURIComponent(id)}/deadline`, { deadline_at, expected_revision }),
  screenshot: async (id: string): Promise<Blob> => (await api.get(`/support/tasks/${encodeURIComponent(id)}/screenshot`, { responseType: "blob" })).data,
};
