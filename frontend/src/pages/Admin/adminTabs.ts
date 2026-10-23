import type { Session } from "../../utils/api/contract";
import { can } from "../../utils/session";

/** The cabinet tabs and the right that shows each (АВ-34); the registrations open first. */
export const adminTabs = [
  { tab: "registrations", label: "Заявки на регистрацию", capability: "review_registrations" },
  { tab: "leadership", label: "Председатель и замы", capability: "view_leadership" },
  { tab: "accounts", label: "Архив аккаунтов", capability: "restore_account" },
  { tab: "materials", label: "Общие материалы", capability: "manage_material_editors" },
  { tab: "pgas", label: "Администраторы ПГАС", capability: "grant_pgas_admin" },
  { tab: "passwords", label: "Сброс пароля", capability: "reset_password" },
  { tab: "guides", label: "Гайды", capability: "review_registrations" },
] as const;
export type AdminTab = (typeof adminTabs)[number]["tab"];

export const visibleAdminTabs = (session: Session | null) =>
  adminTabs.filter((t) => can(session, t.capability));
