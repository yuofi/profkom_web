import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
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
type NoticeCache = Page<Notification> | InfiniteData<Page<Notification>> | { count: number };
/** Read and read-all of the bell and of /notifications: they change only the notices, so
 *  only those (the bell page, the /notifications pages and the unread count) are updated
 *  at once and reread; a failure restores them (PF-02, GL-16). */
export function useNotificationCommands() {
  const client = useQueryClient();
  const key = ['notifications'] as const;
  const mark = async (command: () => Promise<void>, matches: (notice: Notification) => boolean, all = false) => {
    await client.cancelQueries({ queryKey: key });
    const previous = client.getQueriesData<NoticeCache>({ queryKey: key }), at = new Date().toISOString();
    const marked = new Set<string>();
    const page = (current: Page<Notification>) => ({ ...current, items: current.items.map(notice => {
      if (notice.read_at || !matches(notice)) return notice;
      marked.add(notice.id);return { ...notice, read_at: at };
    }) });
    for (const [queryKey, data] of previous) {
      if (data && 'items' in data) client.setQueryData(queryKey, page(data));
      else if (data && 'pages' in data) client.setQueryData(queryKey, { ...data, pages: data.pages.map(page) });
    }
    for (const [queryKey, data] of previous) {
      if (data && 'count' in data) client.setQueryData(queryKey, { count: all ? 0 : Math.max(0, data.count - marked.size) });
    }
    try { await command(); }
    catch (error) { for (const [queryKey, data] of previous) client.setQueryData(queryKey, data); throw error; }
    finally {
      void client.invalidateQueries({ queryKey: key });
      // The home projection carries an unread count too; it rereads when it is shown next.
      void client.invalidateQueries({ queryKey: ['dashboard'], refetchType: 'none' });
    }
  };
  return {
    read: (id: string) => mark(() => workspaceApi.read(id), notice => notice.id === id),
    readAll: () => mark(workspaceApi.readAll, () => true, true),
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
