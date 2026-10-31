import { useQuery, useQueryClient } from '@tanstack/react-query';
import { directoryApi } from '../api/directory.api';
import { invalidateWorkspace } from '../api/invalidation';
import { canRetainData } from '../api/request';
import { workspaceApi } from '../api/workspace.api';
import type { Notification, Page } from '../api/contract';
import type { EntityOption } from '../../components/Workspace/EntityPicker';
export function useWorkspaceActions() {
  const client = useQueryClient();
  const refresh = () => invalidateWorkspace(client);
  /** The command's control is free as soon as the server answered: dependent data rereads
   *  in the background, except what the command's own answer already put in the cache
   *  (setQueryData during the action). Revisions come from the answer itself (PF-02). */
  const perform = async <T,>(action: () => Promise<T>): Promise<T> => {
    const filled = new Set<string>();
    const stop = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success' && event.action.manual) filled.add(event.query.queryHash);
    });
    let result: T;
    try { result = await action(); } finally { stop(); }
    void invalidateWorkspace(client, filled);
    return result;
  };
  return { perform, refresh };
}
/** Read and read-all of the bell and of /notifications: they change only the notices, so
 *  only those are updated at once and reread; a failure restores them (PF-02). */
export function useNotificationCommands() {
  const client = useQueryClient();
  const key = ['notifications'] as const;
  const mark = async (command: () => Promise<void>, matches: (notice: Notification) => boolean) => {
    await client.cancelQueries({ queryKey: key });
    const previous = client.getQueryData<Page<Notification>>(key), at = new Date().toISOString();
    if (previous) client.setQueryData<Page<Notification>>(key, { ...previous, items: previous.items.map(notice => !notice.read_at && matches(notice) ? { ...notice, read_at: at } : notice) });
    try { await command(); }
    catch (error) { if (previous) client.setQueryData(key, previous); throw error; }
    finally {
      void client.invalidateQueries({ queryKey: key });
      // The home projection carries an unread count too; it rereads when it is shown next.
      void client.invalidateQueries({ queryKey: ['dashboard'], refetchType: 'none' });
    }
  };
  return {
    read: (id: string) => mark(() => workspaceApi.read(id), notice => notice.id === id),
    readAll: () => mark(workspaceApi.readAll, () => true),
  };
}
export function usePeopleOptions({ includeNonMembers = false, enabled = true }: { includeNonMembers?: boolean; enabled?: boolean } = {}) {
  const query = useQuery({ queryKey: ['contacts'], queryFn: directoryApi.contacts, enabled });
  const current = !query.error || canRetainData(query.error) ? query.data : undefined;
  const options: EntityOption[] = current?.filter(p => includeNonMembers || p.in_profcom).map(p => {
    const label = `${p.surname} ${p.name}`;
    return { value: String(p.user_id), label, user: { user_id: p.user_id, display_name: label, avatar_url: p.photo_url ?? null } };
  }) ?? [];
  return { ...query, options };
}
