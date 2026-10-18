import type { QueryClient } from '@tanstack/react-query';
import { workspaceKeys } from './queryKeys';

/** Mutations can affect dashboard, calendars, summaries and sibling scopes. */
export async function invalidateWorkspace(client: QueryClient): Promise<void> {
  await Promise.all(workspaceKeys.map(queryKey => client.invalidateQueries({ queryKey })));
}
/** An access change must remove already-cached private data, not only mark it stale. */
export async function clearPrivateCache(client: QueryClient): Promise<void> {
  await client.cancelQueries();
  client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' });
  await client.invalidateQueries({ queryKey: ['session'] });
}
