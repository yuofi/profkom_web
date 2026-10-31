import { QueryCache, hashKey, type Query, type QueryClient } from "@tanstack/react-query";
import { workspaceKeys } from "./queryKeys";
import { canRetainData } from "./request";

/** Mutations can affect dashboard, calendars, summaries and sibling scopes. `current` names
 *  queries (by hash) that the command's own answer has just filled: they are not reread,
 *  unless an older read of them is still in flight and would overwrite that answer. */
export async function invalidateWorkspace(client: QueryClient, current: ReadonlySet<string> = new Set()): Promise<void> {
  const predicate = (query: Query) => !current.has(query.queryHash) || query.state.fetchStatus !== "idle";
  await Promise.all(
    workspaceKeys.map((queryKey) => client.invalidateQueries({ queryKey, predicate })),
  );
}
/** The own chair transfer and deputies change access: cached private data is removed, not
 *  only marked stale. Other access changes: ctx.tsx; an ended session: handleRevokedSession. */
export async function clearPrivateCache(client: QueryClient): Promise<void> {
  await client.cancelQueries();
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== "session",
  });
  await client.invalidateQueries({ queryKey: ["session"] });
}
/** A reread refused for good (403, 404) drops the data it was to refresh, so a page that
 *  lost access shows the refusal and nothing it may no longer read (A-FE-1). */
export function dropRefusedData(error: unknown, query: Query<unknown, unknown, unknown, readonly unknown[]>) {
  if (!canRetainData(error) && query.state.data !== undefined)
    query.setState({ data: undefined, dataUpdatedAt: 0 });
}
export const workspaceQueryCache = () => new QueryCache({ onError: dropRefusedData });
/** Directories every active member reads and that change rarely: a page or a hover card
 *  mounting again reuses them for a while instead of reading them again (PF-09). Own
 *  commands still invalidate them and an access revision still evicts/rereads them. Any
 *  other (private) query keeps staleTime 0, so a remount still notices a refusal. */
const REFERENCE_KEYS = new Set([["seasons"], ["events"], ["workspaceBlocks"], ["contacts"], ["kkrTemplates"], ["merits", "contexts"]].map((key) => hashKey(key)));
export const referenceStaleTime = (query: Query) => (REFERENCE_KEYS.has(query.queryHash) ? 120_000 : 0);
/** Only a transient failure is worth another try; a refusal stays a refusal. */
export const retryTransient = (failures: number, error: unknown) => failures < 1 && canRetainData(error);
