import type { UserRef } from "./contract";

export interface BlockDeletionRequest {
  request_id: string;
  state: "pending" | "scheduled" | "cancelled" | "executed";
  revision: number;
  created_at: string;
  scheduled_at: string | null;
  delete_after: string | null;
  finished_at: string | null;
  cancel_reason: string | null;
  approvals: { actor: UserRef; at: string }[];
  capabilities: string[];
}
