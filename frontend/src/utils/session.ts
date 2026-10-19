import { createContext, useContext } from "react";
import type { Session } from "./api/contract";
export interface SessionState {
  session: Session | null;
  loading: boolean;
  error: unknown;
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
export const accessFingerprint = (session: Session | null | undefined) =>
  JSON.stringify(
    session
      ? [
          session.user_id,
          session.account_state,
          session.registration_status,
          session.access_revision,
          [...session.capabilities].sort(),
          session.assignments?.map((a) => [
            a.role_assignment_id,
            a.revision,
            a.capabilities,
          ]),
        ]
      : null,
  );
