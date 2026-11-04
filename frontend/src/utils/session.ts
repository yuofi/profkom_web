import { createContext, useContext } from "react";
import type { Session } from "./api/contract";
export interface SessionState {
  session: Session | null;
  loading: boolean;
  error: unknown;
  /** The own profile record failed to load (the session itself is fine). */
  profileError?: unknown;
  refresh: () => void;
}
export const SessionContext = createContext<SessionState>({
  session: null,
  loading: true,
  error: null,
  refresh: () => {},
});
export const useSession = () => useContext(SessionContext);
export const can = (
  object: { capabilities?: string[] } | null | undefined,
  capability: string,
) => object?.capabilities?.includes(capability) ?? false;
export const isActiveSession = (session: Session | null | undefined) =>
  session?.account_state === "active" &&
  session.registration_status === "approved";
/** An active session the server opens for work: no temporary password to change (АВ-52)
 *  and no VK link overdue (BOT_API.md, «Привязка VK»). Only such a session reads its data. */
export const isWorkingSession = (session: Session | null | undefined) =>
  isActiveSession(session) &&
  !session?.password_change_required &&
  !session?.bot_link?.blocked;
/** Who is signed in: only a change of this starts the workspace over (A-FE-1). */
export const sessionIdentity = (session: Session | null | undefined) =>
  JSON.stringify(
    session
      ? [session.user_id, session.account_state, session.registration_status]
      : null,
  );
/** What the account may reach. A change rereads the open data; a revision of an
 *  assignment (new deputies, for example) is not a change of access. */
export const accessFingerprint = (session: Session | null | undefined) =>
  JSON.stringify(
    session
      ? [
          sessionIdentity(session),
          session.access_revision,
          [...session.capabilities].sort(),
          session.assignments?.map((a) => [
            a.role_assignment_id,
            a.capabilities,
          ]),
        ]
      : null,
  );
