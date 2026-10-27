import { useQuery, useQueryClient } from '@tanstack/react-query';
import { directoryApi } from '../api/directory.api';
import { invalidateWorkspace } from '../api/invalidation';
import { canRetainData } from '../api/request';
import type { EntityOption } from '../../components/Workspace/EntityPicker';
export function useWorkspaceActions() {
  const client = useQueryClient();
  const refresh = () => invalidateWorkspace(client);
  const perform = async <T,>(action: () => Promise<T>): Promise<T> => { const result = await action(); await refresh(); return result; };
  return { perform, refresh };
}
export function usePeopleOptions({ includeNonMembers = false }: { includeNonMembers?: boolean } = {}) {
  const query = useQuery({ queryKey: ['contacts'], queryFn: directoryApi.contacts });
  const current = !query.error || canRetainData(query.error) ? query.data : undefined;
  const options: EntityOption[] = current?.filter(p => includeNonMembers || p.in_profcom).map(p => {
    const label = `${p.surname} ${p.name}`;
    return { value: String(p.user_id), label, user: { user_id: p.user_id, display_name: label, avatar_url: p.photo_url ?? null } };
  }) ?? [];
  return { ...query, options };
}
