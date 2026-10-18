import { useQuery, useQueryClient } from '@tanstack/react-query';
import { directoryApi } from '../api/directory.api';
import { invalidateWorkspace } from '../api/invalidation';
export function useWorkspaceActions() {
  const client = useQueryClient();
  const refresh = () => invalidateWorkspace(client);
  const perform = async <T,>(action: () => Promise<T>): Promise<T> => { const result = await action(); await refresh(); return result; };
  return { perform, refresh };
}
export function usePeopleOptions() {
  const query = useQuery({ queryKey: ['contacts'], queryFn: directoryApi.contacts });
  return { ...query, options: query.data?.filter(p => p.in_profcom).map(p => ({ value: String(p.user_id), label: `${p.surname} ${p.name}` })) ?? [] };
}
