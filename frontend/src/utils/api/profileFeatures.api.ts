import type { Criteria, UserRef } from "./contract";
import type { ContactInfoOut, ProfileUpdate } from "./types";
import { idPath, request } from "./request";
export interface FeatureScope { kind: "global" | "block" | "event" | "subevent"; id: string | null; name: string }
export interface FeaturesContext { award_scopes: FeatureScope[]; template_scopes: FeatureScope[]; can_create_personal_template: boolean; award_icons: string[] }
export interface ActivityFact { scope: FeatureScope; role: string; started_at: string | null; ended_at: string | null; observed: boolean; current: boolean }
export interface Achievement { achievement_id: string; title: string; description: string; icon: string; scope: FeatureScope; revision: number; archived: boolean; capabilities: string[] }
export interface AchievementValues { title: string; description: string; icon: string }
export interface AchievementGrant {
  grant_id: string; achievement_id: string; achievement: AchievementValues & { scope: FeatureScope };
  user: UserRef; issued_by: UserRef; issued_at: string; note: string | null; revoked_at: string | null;
  revoked_by: UserRef | null; revoke_reason: string | null; revision: number; capabilities: string[];
  history: { event_id: string; kind: "issued" | "revoked"; actor: UserRef; created_at: string }[];
}
export type NotificationChannel = "email" | "telegram" | "vk";
export type NotificationCategory = "tracker" | "applications" | "pgas";
export type NotificationPreferences = Record<NotificationCategory, Record<NotificationChannel, boolean>>;
export interface PreferenceSettings { revision: number; preferences: NotificationPreferences; delivery_status: "not_connected" }
export type AvatarSelection = { preset_id: string } | { file_id: string };
export interface ProfileEditorData { revision: number; fingerprint: string; contact: ContactInfoOut }
export interface TemplateValues { title: string; description: string; hours: number; evaluation: -1 | 0 | 1 | 1.5; criteria: Criteria }
export interface TemplateSelection { template_id: string; revision: number }
export interface KkrTemplate { template_id: string; visibility: "personal" | "team"; scope: FeatureScope | null; values: TemplateValues; revision: number; archived: boolean }
export interface TemplateCreate { visibility: "personal" | "team"; scope_kind?: FeatureScope["kind"]; scope_id?: string | null; values: TemplateValues }
export const profileFeaturesApi = {
  context: () => request<FeaturesContext>("get", "/profile/me/features-context"),
  activity: (id: number) => request<{ items: ActivityFact[] }>("get", `/profiles/${idPath(id)}/activity`),
  catalogue: (recipient_user_id?: number) => request<{ items: Achievement[] }>("get", "/achievements", undefined, { recipient_user_id }),
  achievements: (id: number) => request<{ items: AchievementGrant[] }>("get", `/profiles/${idPath(id)}/achievements`),
  createAchievement: (values: AchievementValues, scope: FeatureScope) => request<Achievement>("post", "/achievements", { ...values, scope_kind: scope.kind, scope_id: scope.id }),
  updateAchievement: (award: Achievement, values: AchievementValues, archived: boolean) => request<Achievement>("patch", `/achievements/${idPath(award.achievement_id)}`, { ...values, archived, expected_revision: award.revision }),
  grant: (award: Achievement, user_id: number, note: string) => request<AchievementGrant>("post", `/achievements/${idPath(award.achievement_id)}/grant`, { expected_revision: award.revision, user_id, note }),
  revoke: (award: AchievementGrant, reason: string) => request<AchievementGrant>("post", `/achievement-grants/${idPath(award.grant_id)}/revoke`, { expected_revision: award.revision, reason }),
  preferences: () => request<PreferenceSettings>("get", "/profile/me/notification-preferences"),
  savePreferences: (expected_revision: number, preferences: NotificationPreferences) => request<PreferenceSettings>("put", "/profile/me/notification-preferences", { expected_revision, preferences }),
  editor: () => request<ProfileEditorData>("get", "/profile/me/editor"),
  saveEditor: (baseline: Pick<ProfileEditorData, "revision" | "fingerprint">, profile: ProfileUpdate, avatar: AvatarSelection | null) => request<ProfileEditorData>("patch", "/profile/me/editor", { expected_revision: baseline.revision, expected_fingerprint: baseline.fingerprint, profile, avatar }),
  discardAvatar: (id: string) => request<void>("delete", `/profile/me/avatar-drafts/${idPath(id)}`),
  templates: () => request<{ items: KkrTemplate[] }>("get", "/kkr-templates"),
  createTemplate: (data: TemplateCreate) => request<KkrTemplate>("post", "/kkr-templates", data),
  updateTemplate: (template: KkrTemplate, values: TemplateValues, archived: boolean) => request<KkrTemplate>("patch", `/kkr-templates/${idPath(template.template_id)}`, { expected_revision: template.revision, values, archived }),
  prepare: (template: KkrTemplate) => request<{ selection: TemplateSelection; values: TemplateValues }>("post", `/kkr-templates/${idPath(template.template_id)}/prepare`, { expected_revision: template.revision }),
};
