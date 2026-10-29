import type {
  Block,
  BlockRequest,
  RegistrationApplication,
  RegistrationFields,
  Revision,
  ParticipantCategory,
  ParticipantCategoryBatch,
  Category,
} from "./contract";
import { idPath, allPages as page, request } from "./request";
export const membershipApi = {
  blocks: () => request<Block[]>("get", "/blocks"),
  block: (id: string) => request<Block>("get", `/blocks/${idPath(id)}`),
  updateBlock: (
    id: string,
    data: Revision & {
      description?: Block["description"];
      community_url?: string;
      avatar_file_id?: string | null;
    },
  ) => request<Block>("patch", `/blocks/${idPath(id)}`, data),
  assignHr: (id: string, data: Revision & { user_id: number | null }) =>
    request<Block>("put", `/blocks/${idPath(id)}/hr`, data),
  requests: () => page<BlockRequest>("/block-requests"),
  join: (block_id: string) =>
    request<BlockRequest>("post", "/block-requests", { block_id }),
  requestCommand: (
    id: string,
    command: "hr-approve" | "block-approve" | "reject" | "withdraw",
    data: Revision & { reason?: string },
  ) =>
    request<BlockRequest>(
      "post",
      `/block-requests/${idPath(id)}/${command}`,
      data,
    ),
  leave: (id: string) =>
    request<void>("post", `/blocks/${idPath(id)}/leave`, {}),
  remove: (id: string, user: number) =>
    request<void>("delete", `/blocks/${idPath(id)}/members/${user}`),
  registration: () =>
    request<RegistrationApplication>("get", "/registrations/me"),
  registrations: (status?: RegistrationApplication["status"]) =>
    page<RegistrationApplication>("/registrations", status ? { status } : undefined),
  updateRegistration: (data: Revision & { fields: RegistrationFields }) =>
    request<RegistrationApplication>("patch", "/registrations/me", data),
  resubmit: (data: Revision) =>
    request<RegistrationApplication>(
      "post",
      "/registrations/me/resubmit",
      data,
    ),
  registrationCommand: (
    id: number,
    command: "approve" | "reject" | "reset-attempts",
    data: Revision & { reason?: string },
  ) =>
    request<RegistrationApplication>(
      "post",
      `/registrations/${id}/${command}`,
      data,
    ),
  categories: async (userIds: number[]): Promise<ParticipantCategory[]> => {
    const ids = [...new Set(userIds)].sort((a, b) => a - b);
    const items: ParticipantCategory[] = [];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const result = await request<ParticipantCategoryBatch>("get", "/participants/categories", undefined,
        { user_ids: ids.slice(offset, offset + 200).join(",") });
      items.push(...result.items);
    }
    return items;
  },
  category: (id: number) =>
    request<ParticipantCategory>("get", `/participants/${id}/category`),
  updateCategory: (
    id: number,
    data: Revision & { category: Category; reason: string },
  ) =>
    request<ParticipantCategory>("patch", `/participants/${id}/category`, data),
};
