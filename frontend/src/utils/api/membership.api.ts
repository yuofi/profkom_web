import type {
  Block,
  BlockRequest,
  RegistrationApplication,
  RegistrationFields,
  Revision,
  ParticipantCategory,
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
    },
  ) => request<Block>("patch", `/blocks/${idPath(id)}`, data),
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
  registrations: () => page<RegistrationApplication>("/registrations"),
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
  category: (id: number) =>
    request<ParticipantCategory>("get", `/participants/${id}/category`),
  updateCategory: (
    id: number,
    data: Revision & { category: Category; reason: string },
  ) =>
    request<ParticipantCategory>("patch", `/participants/${id}/category`, data),
};
