import type { TemporaryPassword, UserRef } from "./contract";
import { allPages as page, idPath, request } from "./request";
/** The administration cabinet (АВ-34): rights the chair and deputies hand out. */
export const adminApi = {
  pgasAdmins: () => page<UserRef>("/pgas-admins"),
  setPgasAdmin: (userId: number, pgas_admin: boolean) =>
    request<{ user_id: number; pgas_admin: boolean }>("put", `/users/${idPath(userId)}/pgas-admin`, { pgas_admin }),
  temporaryPassword: (userId: number) =>
    request<TemporaryPassword>("post", `/accounts/${idPath(userId)}/temporary-password`, {}),
};
