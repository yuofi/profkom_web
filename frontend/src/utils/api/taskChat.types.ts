import type { UserRef } from "./contract";

export type ChatScope = { kind: "block" | "event"; id: string };
export interface ChatBinding {
  binding_id: string;
  revision: number;
  provider: "vk";
  bot_identity: number;
  peer_id: number;
  title: string;
  state: "linked" | "unavailable";
  confirmed_at: string;
  observed_at: string;
}
export interface ChatSettings {
  scope: ChatScope;
  revision: number;
  binding: ChatBinding | null;
  capabilities: string[];
}
export interface ChatLinkCode { code: string; command: string; expires_at: string; revision: number }
export interface TaskChatContext {
  scope: ChatScope | null;
  binding: ChatBinding | null;
  available: boolean;
  reason: string | null;
  can_manage: boolean;
  bot_online: boolean;
  recipient_mode: "all" | "assignees";
  missing_vk_user_ids: number[];
}
export interface TaskChatAnnouncement {
  announcement_id: string;
  state: "pending" | "sending" | "sent" | "failed" | "partial" | "cancelled";
  revision: number;
  error_code: string | null;
  sent_at: string | null;
  created_at: string;
  created_by: UserRef;
  capabilities: string[];
}
