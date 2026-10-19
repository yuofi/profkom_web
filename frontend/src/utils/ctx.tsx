import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "./api/auth.api";
import { sessionApi } from "./api/session.api";
import { UserContext } from "./me";
import { SessionContext, isActiveSession, accessFingerprint } from "./session";
import type { Session } from "./api/contract";

export const UserProvider = ({ children }: { children: React.ReactNode }) => {
  const client = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const previous = client.getQueryData<Session>(["session"]);
      const next = await sessionApi.get();
      if (previous && accessFingerprint(previous) !== accessFingerprint(next)) {
        await client.cancelQueries({
          predicate: (q) => q.queryKey[0] !== "session",
        });
        client.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
      }
      return next;
    },
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
  const active = isActiveSession(sessionQuery.data);
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
        key={accessFingerprint(sessionQuery.data)}
        value={active ? (profile.data?.data ?? null) : null}
      >
        {children}
      </UserContext.Provider>
    </SessionContext.Provider>
  );
};
