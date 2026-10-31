import type { Session } from "../../utils/api/contract";
import { can } from "../../utils/session";

export const MERIT_CREATE_CAPS = ["create_volunteer_merit", "create_head_merit", "create_chair_merit"];

/** Whether the session may create a merit anywhere: globally or in one of its scopes. */
export const createsMerits = (session: Session | null) =>
  MERIT_CREATE_CAPS.some((cap) => can(session, cap) || !!session?.assignments?.some((a) => can(a, cap)));

/** Whether the session reads saved merits: the summary readers, the scoped `view_merits` (closed seasons too)
 * and the session-level `view_merits` of a block or subevent HR curator, who holds no role assignment there. */
export const readsMerits = (session: Session | null) =>
  can(session, "view_summary") || can(session, "view_merits") || !!session?.assignments?.some((a) => can(a, "view_merits"));
