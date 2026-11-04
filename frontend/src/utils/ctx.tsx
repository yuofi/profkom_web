import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "./api/auth.api";
import { sessionApi } from "./api/session.api";
import { UserContext } from "./me";
import { SessionContext, isActiveSession, isWorkingSession, accessFingerprint, sessionIdentity } from "./session";
import type { Session } from "./api/contract";
import { forgetOwnChanges } from "../components/Workspace/ownRevisions";
import { handleRevokedSession } from "./authSession";
import { normalizeApiError } from "./api/request";
import { onAccessChange, rememberSignedIn } from "./api";
import { retryTransient } from "./api/invalidation";

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
        // A closed filter can retain a disabled observer. Those inactive
        // catalogues must be evicted too, before they can be opened again.
        client.removeQueries({ predicate: (q) => notSession(q) && !q.isActive() });
        void client.invalidateQueries({ predicate: notSession, refetchType: "active" });
      }
      rememberSignedIn(true);
      return next;
    },
    // One failed poll (a restart, a 502) is tried again; the page stays meanwhile (GL-02).
    retry: retryTransient,
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
  // A refused refresh or a 403/404 of any request rereads the session at once instead of
  // waiting for the next poll; the checks above then route, evict and remount (GL-06).
  useEffect(() => onAccessChange(() => {
    void client.invalidateQueries({ queryKey: ["session"] }, { cancelRefetch: false });
  }), [client]);
  // A temporary password or an overdue VK link opens nothing but its own step (АВ-52, BOT_API.md).
  const active = isWorkingSession(sessionQuery.data);
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
        // Authorization depends on the confirmed session. Its private profile is
        // independent page data, so it must not serialize every workspace read.
        loading: sessionQuery.isLoading,
        error: sessionQuery.error,
        // Only the own profile pages wait for it; its failure must not close the others.
        profileError: profile.error,
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
