import type { Broadcast, BroadcastAudience, BroadcastInput, BroadcastSenderChange, UserRef } from "./contract";
import { allPages, idPath, page, request } from "./request";

/** Broadcasts through HereBot (BOT_API.md, «Рассылки», stage 4). With the integration off the
 *  audience and a new broadcast answer 404 bot_api_disabled; the list and the pages still work. */
export const broadcastsApi = {
  audience: () => request<BroadcastAudience>("get", "/broadcasts/audience"),
  /** 409 broadcast_no_recipients without a VK recipient; 409 duplicate_request_key when the key
   *  was already used with another text. */
  create: (input: BroadcastInput) => request<Broadcast>("post", "/broadcasts", input),
  /** Newest first, 20 a page. */
  list: (cursor?: string | null, signal?: AbortSignal) => page<Broadcast>("/broadcasts", cursor ? { cursor } : undefined, signal),
  /** Any active account; `counts` is null without the right to send. */
  get: (id: string) => request<Broadcast>("get", `/broadcasts/${idPath(id)}`),
  /** 409 broadcast_not_sending once nothing waits any more. */
  cancel: (id: string) => request<Broadcast>("post", `/broadcasts/${idPath(id)}/cancel`, {}),
  senders: () => allPages<UserRef>("/broadcasts/senders"),
  setSender: (userId: number, sender: boolean) =>
    request<BroadcastSenderChange>("put", `/broadcasts/senders/${idPath(userId)}`, { sender }),
};

/** Query keys of the broadcasts: one prefix, so a command can reread all of them. */
export const broadcastKeys = {
  all: ["broadcasts"] as const,
  audience: ["broadcasts", "audience"] as const,
  list: ["broadcasts", "list"] as const,
  item: (id: string) => ["broadcasts", "item", id] as const,
  senders: ["broadcasts", "senders"] as const,
};
