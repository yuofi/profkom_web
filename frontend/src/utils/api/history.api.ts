import type { HistoryEntry, HistoryTargetKind } from "./contract";
import { allPages, idPath, request } from "./request";
export type { HistoryChange, HistoryEntry, HistoryTargetKind } from "./contract";
export const historyApi = {
  list: (target_kind: HistoryTargetKind, target_id: string) => allPages<HistoryEntry>("/history", { target_kind, target_id }),
  hide: (entry: HistoryEntry) => request<{ status: "hidden" }>("post", `/history/${idPath(entry.source_kind)}/${idPath(entry.source_id)}/hide`, { expected_revision: entry.revision }),
};
