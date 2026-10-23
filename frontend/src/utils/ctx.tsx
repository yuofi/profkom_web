import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "./api/auth.api";
import { sessionApi } from "./api/session.api";
import { UserContext } from "./me";
import { SessionContext, isActiveSession, accessFingerprint, sessionIdentity } from "./session";
import type { Session } from "./api/contract";
import { forgetOwnChanges } from "../components/Workspace/ownRevisions";
import { handleRevokedSession } from "./authSession";
import { normalizeApiError } from "./api/request";

const notSession = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== "session";

export const UserProvider = ({ children }: { children: React.ReactNode }) => {
  const client = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const previous = client.getQueryData<Session>(["session"]);
      let next: Session;
      try {
        next = await sessionApi.get();
      } catch (error) {
        // 401 after the refresh was tried: the session is over, and its data with it.
        if (normalizeApiError(error).status === 401) {
          forgetOwnChanges(client);
          await handleRevokedSession(client);
        }
        throw error;
      }
      if (previous && sessionIdentity(previous) !== sessionIdentity(next)) {
        // Another account or account state: nothing of the previous one stays.
        forgetOwnChanges(client);
        await client.cancelQueries({ predicate: notSession });
        client.removeQueries({ predicate: notSession });
      } else if (previous && accessFingerprint(previous) !== accessFingerprint(next)) {
        // Other rights of the same account (A-FE-1): data no page shows is dropped, open
        // pages reread theirs and keep their input. A reread refused with 403/404 drops
        // its data (dropRefusedData), so nothing closed stays on screen.
        client.removeQueries({ predicate: (q) => notSession(q) && q.getObserversCount() === 0 });
        void client.invalidateQueries({ predicate: notSession, refetchType: "active" });
      }
      return next;
    },
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
  // A temporary password opens nothing but its change (АВ-52).
  const active = isActiveSession(sessionQuery.data) && !sessionQuery.data?.password_change_required;
  const profile = useQuery({
    queryKey: ["currentUser", sessionQuery.data?.user_id],
    queryFn: authApi.getMe,
    enabled: active,
    retry: false,
  });
  return (
    <SessionContext.Provider
      value={{
        session: sessionQuery.data ?? null,
        loading: sessionQuery.isLoading || (active && profile.isLoading),
        error: sessionQuery.error ?? profile.error,
        refresh: () => {
          void sessionQuery.refetch().then(({ data, error }) => {
            if (!error && isActiveSession(data))
              return client.invalidateQueries({ queryKey: ["currentUser", data?.user_id] });
          });
        },
      }}
    >
      <UserContext.Provider
        key={sessionIdentity(sessionQuery.data)}
        value={active ? (profile.data?.data ?? null) : null}
      >
        {children}
      </UserContext.Provider>
    </SessionContext.Provider>
  );
};
