import type { FormerContact, ArchivedAccount, AvatarPreset } from "./contract";
import type { ContactInfoOut } from "./types";
import { idPath, allPages as page, request } from "./request";
export const directoryApi = {
  contacts: () => request<ContactInfoOut[]>("get", "/contacts"),
  former: () => page<FormerContact>("/contacts/archive"),
  saveFormer: (data: Omit<FormerContact, "contact_id">, id?: string) =>
    request<FormerContact>(
      id ? "patch" : "post",
      `/contacts/archive${id ? `/${idPath(id)}` : ""}`,
      data,
    ),
  emails: () => request<{ emails: string[] }>("get", "/contacts/emails"),
  avatars: () => request<{ items: AvatarPreset[] }>("get", "/avatars"),
  avatar: (data: { preset_id: string } | { file_id: string }) =>
    request<ContactInfoOut>("put", "/profile/me/avatar", data),
  archived: () => page<ArchivedAccount>("/accounts/archive"),
  archive: (id: number, reason: string) =>
    request<void>("post", `/accounts/${id}/archive`, { reason }),
  restore: (
    id: number,
    master_conflicts: { block_id: string; keep_user_id: number }[],
  ) => request<void>("post", `/accounts/${id}/restore`, { master_conflicts }),
};
