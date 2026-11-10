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
import { idPath, allPages as page, page as onePage, request } from "./request";
/** Optional /block-requests filters; `state` repeats as the server expects (state=a&state=b). */
export interface BlockRequestFilters {
  block_id?: string;
  state?: BlockRequest["state"][];
  mine?: boolean;
  limit?: number;
  cursor?: string;
  /** With limit/cursor: "desc" pages from the newest request. */
  order?: "asc" | "desc";
}
const requestFilters = ({ state = [], ...rest }: BlockRequestFilters) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) params.set(key, String(value));
  for (const value of state) params.append("state", value);
  return params;
};
export const membershipApi = {
  blocks: () => request<Block[]>("get", "/blocks"),
  /** include_deputies: the master also carries its deputies as user references. */
  block: (id: string, params?: { include_deputies?: boolean }) => request<Block>("get", `/blocks/${idPath(id)}`, undefined, params),
  updateBlock: (
    id: string,
    data: Revision & {
      name?: string;
      description?: Block["description"];
      community_url?: string;
      avatar_file_id?: string | null;
    },
  ) => request<Block>("patch", `/blocks/${idPath(id)}`, data),
  assignHr: (id: string, data: Revision & { user_id: number | null }) =>
    request<Block>("put", `/blocks/${idPath(id)}/hr`, data),
  /** The visible requests narrowed by the filters: all of them at once, or with limit/cursor
   *  one keyset page by (created_at, request_id). */
  requests: (filters: BlockRequestFilters = {}) => onePage<BlockRequest>("/block-requests", requestFilters(filters)),
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
