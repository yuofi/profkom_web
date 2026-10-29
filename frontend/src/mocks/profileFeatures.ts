/** Synthetic profile feature fixtures. No provider delivery or KKR computation. */
import type { Fixtures } from "./fixtures";
import { mockNow } from "./fixtures";
import type { Achievement, AchievementGrant, FeaturesContext, KkrTemplate, NotificationPreferences, TemplateValues } from "../utils/api/profileFeatures.api";
import type { TaskHistoryEvent } from "../utils/api/contract";
type Reply = [number, unknown];
const copy = <T,>(value: T): T => structuredClone(value);
const fail = (status: number, code: string): Reply => [status, { detail: { code, message: code } }];
export function profileFeatureMock(state: Fixtures, taskHistory?: () => Map<string, TaskHistoryEvent[]>) {
  let revision = 1, preferenceRevision = 1, counter = 0;
  const preferences: NotificationPreferences = { tracker: { email: false, telegram: false, vk: false }, applications: { email: false, telegram: false, vk: false }, pgas: { email: false, telegram: false, vk: false } };
  const awards: Achievement[] = [], grants: AchievementGrant[] = [], templates: KkrTemplate[] = [];
  const global = state.chair || state.role === "chair-deputy" || state.role === "hr";
  const scopes: FeaturesContext["award_scopes"] = [
    ...(global ? [{ kind: "global" as const, id: null, name: "Профком" }] : []),
    ...state.blocks.filter(row => global || row.master?.user.user_id === state.session.user_id).map(row => ({ kind: "block" as const, id: row.block_id, name: row.name })),
    ...state.events.filter(row => global || row.leaders.some(leader => leader.user.user_id === state.session.user_id)).map(row => ({ kind: "event" as const, id: row.event_id, name: row.title })),
  ];
  const context: FeaturesContext = { award_scopes: scopes, template_scopes: scopes, can_create_personal_template: scopes.length > 0 || state.manager, award_icons: ["workspace_premium", "celebration", "school", "badge", "fact_check", "groups"] };
  const editor = () => ({ revision, fingerprint: String(revision).padStart(64, "0"), contact: copy(state.profile) });
  const ownAward = (row: Achievement) => global || scopes.some(scope => scope.kind === row.scope.kind && scope.id === row.scope.id);
  const hiddenHistory = new Map<string, string>();
  return (path: string, method: string, data: Record<string, unknown>, search?: URLSearchParams): Reply | undefined => {
    const parts = path.split("/").filter(Boolean);
    if (path === "/history") {
      const id = search?.get("target_id") ?? "", kind = search?.get("target_kind");
      return [200, { items: kind === "task" ? (taskHistory?.().get(id) ?? []).map(event => ({ id: `activity:${event.event_id}`, source_kind: "activity", source_id: event.event_id, target: { kind: "task", id }, changed_by: event.actor ?? state.user, created_at: event.created_at, description: event.description, changes: hiddenHistory.has(event.event_id) ? [] : event.changes ?? [], reason: null, hidden: hiddenHistory.has(event.event_id), hidden_by: hiddenHistory.has(event.event_id) ? state.user : null, hidden_at: hiddenHistory.get(event.event_id) ?? null, revision: hiddenHistory.has(event.event_id) ? 2 : 1, can_hide: !hiddenHistory.has(event.event_id) && (global || event.actor?.user_id === state.session.user_id) })) : [], next_cursor: null }];
    }
    if (parts[0] === "history" && parts[3] === "hide") {
      if (hiddenHistory.has(parts[2]) || data.expected_revision !== 1) return fail(409, "revision_conflict");
      hiddenHistory.set(parts[2], mockNow);return [200, { status: "hidden" }];
    }
    if (path === "/profile/me/features-context") return [200, copy(context)];
    if (path === "/profile/me/editor") {
      if (method === "patch") {
        if (data.expected_revision !== revision || data.expected_fingerprint !== editor().fingerprint) return fail(409, "revision_conflict");
        const avatar = data.avatar as { preset_id?: string; file_id?: string } | null;
        Object.assign(state.profile, data.profile);
        if (avatar) state.profile.photo_url = avatar.preset_id ? `/avatars/${avatar.preset_id}.svg` : `/api/files/${avatar.file_id}/content`;
        revision++;
      }
      return [200, editor()];
    }
    if (path.startsWith("/profile/me/avatar-drafts/")) return [204, null];
    if (path === "/profile/me/notification-preferences") {
      if (method === "put") { if (data.expected_revision !== preferenceRevision) return fail(409, "revision_conflict");Object.assign(preferences, copy(data.preferences));preferenceRevision++; }
      return [200, { revision: preferenceRevision, preferences: copy(preferences), delivery_status: "not_connected" }];
    }
    if (parts[0] === "profiles" && parts[2] === "activity") {
      const person = Number(parts[1]);
      return [200, { items: state.blocks.flatMap(block => [
        ...(block.master?.user.user_id === person ? [{ scope: { kind: "block", id: block.block_id, name: block.name }, role: "master", started_at: null, ended_at: null, observed: false, current: true }] : []),
        ...(block.members.some(member => member.user.user_id === person) ? [{ scope: { kind: "block", id: block.block_id, name: block.name }, role: "member", started_at: null, ended_at: null, observed: false, current: true }] : []),
      ]) }];
    }
    if (parts[0] === "profiles" && parts[2] === "achievements") return [200, { items: copy(grants.filter(grant => grant.user.user_id === Number(parts[1]))) }];
    if (path === "/achievements") {
      if (method === "get") return [200, { items: copy(awards) }];
      const scope = scopes.find(scope => scope.kind === data.scope_kind && scope.id === (data.scope_id ?? null));
      if (!scope) return fail(403, "forbidden");
      const row: Achievement = { achievement_id: `fixture-award-${++counter}`, title: String(data.title), description: String(data.description ?? ""), icon: String(data.icon), scope, revision: 1, archived: false, capabilities: ["manage_achievement", "grant_achievement"] };
      awards.push(row);return [200, copy(row)];
    }
    if (parts[0] === "achievements" && parts[1]) {
      const award = awards.find(award => award.achievement_id === parts[1]);if (!award) return fail(404, "not_found");if (!ownAward(award)) return fail(403, "forbidden");if (data.expected_revision !== award.revision) return fail(409, "revision_conflict");
      if (parts[2] === "grant") {
        const person = state.people.find(person => person.user_id === data.user_id);if (!person) return fail(422, "invalid_input");
        const grant: AchievementGrant = { grant_id: `fixture-grant-${++counter}`, achievement_id: award.achievement_id, achievement: copy(award), user: person, issued_by: state.user, issued_at: mockNow, note: String(data.note ?? ""), revoked_at: null, revoked_by: null, revoke_reason: null, revision: 1, capabilities: ["revoke_achievement"], history: [{ event_id: `fixture-award-event-${counter}`, kind: "issued", actor: state.user, created_at: mockNow }] };
        grants.unshift(grant);return [200, copy(grant)];
      }
      Object.assign(award, data, { revision: award.revision + 1 });return [200, copy(award)];
    }
    if (parts[0] === "achievement-grants") {
      const grant = grants.find(grant => grant.grant_id === parts[1]);if (!grant) return fail(404, "not_found");if (data.expected_revision !== grant.revision) return fail(409, "revision_conflict");
      grant.revoked_at = mockNow;grant.revoked_by = state.user;grant.revoke_reason = String(data.reason);grant.revision++;grant.capabilities = [];grant.history.push({ event_id: `fixture-award-event-${++counter}`, kind: "revoked", actor: state.user, created_at: mockNow });return [200, copy(grant)];
    }
    if (path === "/kkr-templates") {
      if (method === "get") return [200, { items: copy(templates) }];
      if (!context.can_create_personal_template) return fail(403, "forbidden");
      const row: KkrTemplate = { template_id: `fixture-template-${++counter}`, visibility: data.visibility as KkrTemplate["visibility"], values: copy(data.values as TemplateValues), scope: scopes.find(scope => scope.kind === data.scope_kind && scope.id === data.scope_id) ?? null, revision: 1, archived: false };
      templates.push(row);return [200, copy(row)];
    }
    if (parts[0] === "kkr-templates") {
      const row = templates.find(row => row.template_id === parts[1]);if (!row) return fail(404, "not_found");if (data.expected_revision !== row.revision) return fail(409, "revision_conflict");
      if (parts[2] === "prepare") return row.archived ? fail(409, "template_archived") : [200, { selection: { template_id: row.template_id, revision: row.revision }, values: copy(row.values) }];
      row.values = copy(data.values as TemplateValues);row.archived = data.archived === true;row.revision++;return [200, copy(row)];
    }
    return undefined;
  };
}
