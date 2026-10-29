import type { UserRef } from "./contract";
import { allPages, idPath, request } from "./request";
export type HistoryTargetKind = "task" | "assignment" | "merit" | "season" | "block" | "event" | "subevent" | "leadership";
export interface HistoryChange { field: string; label: string; before: unknown; after: unknown; before_users?: UserRef[]; after_users?: UserRef[] }
export interface HistoryEntry {
  id: string; source_kind: "activity" | "audit"; source_id: string; target: { kind: HistoryTargetKind; id: string };
  changed_by: UserRef; created_at: string; description: string; changes: HistoryChange[]; reason: string | null;
  hidden: boolean; hidden_by: UserRef | null; hidden_at: string | null; revision: number; can_hide: boolean;
}
export const historyApi = {
  list: (target_kind: HistoryTargetKind, target_id: string) => allPages<HistoryEntry>("/history", { target_kind, target_id }),
  hide: (entry: HistoryEntry) => request<{ status: "hidden" }>("post", `/history/${idPath(entry.source_kind)}/${idPath(entry.source_id)}/hide`, { expected_revision: entry.revision }),
};
