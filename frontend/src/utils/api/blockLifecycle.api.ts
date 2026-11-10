import type { Block, Revision, RichText } from "./contract";
import { idPath, request } from "./request";

const path = (id: string) => `/blocks/${idPath(id)}/deletion-request`;
export const blockLifecycleApi = {
  create: (data: { name: string; description?: RichText; community_url?: string | null }) => request<Block>("post", "/blocks", data),
  startDeletion: (id: string, data: Revision) => request<Block>("post", path(id), data),
  approveDeletion: (id: string, data: Revision & { request_id: string }) => request<Block>("post", `${path(id)}/approve`, data),
  cancelDeletion: (id: string, data: Revision & { request_id: string }) => request<Block>("post", `${path(id)}/cancel`, data),
};
