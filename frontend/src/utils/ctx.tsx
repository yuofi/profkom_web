import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from './api/auth.api';
import { sessionApi } from './api/session.api';
import { UserContext } from './me';
import { SessionContext, isActiveSession, accessFingerprint } from './session';

export const UserProvider = ({ children }: { children: React.ReactNode }) => {
  const client = useQueryClient();
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: sessionApi.get, retry: false, refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const active = isActiveSession(sessionQuery.data);
  const profile = useQuery({ queryKey: ['currentUser', sessionQuery.data?.user_id], queryFn: authApi.getMe, enabled: active, retry: false });
  const fingerprint = accessFingerprint(sessionQuery.data);
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previous.current !== undefined && previous.current !== fingerprint) {
      void client.cancelQueries({ predicate: q => q.queryKey[0] !== 'session' && !(q.queryKey[0] === 'currentUser' && q.queryKey[1] === sessionQuery.data?.user_id) });
      client.removeQueries({ predicate: q => q.queryKey[0] !== 'session' && !(q.queryKey[0] === 'currentUser' && q.queryKey[1] === sessionQuery.data?.user_id) });
    }
    previous.current = fingerprint;
  }, [client, fingerprint, sessionQuery.data?.user_id]);
  return <SessionContext.Provider value={{ session: sessionQuery.data ?? null, loading: sessionQuery.isLoading || (active && profile.isLoading), error: sessionQuery.error ?? profile.error, refresh: () => { void sessionQuery.refetch(); void profile.refetch(); } }}>
    <UserContext.Provider value={active ? profile.data?.data ?? null : null}>{children}</UserContext.Provider>
  </SessionContext.Provider>;
};
