import { QueryCache, type Query, type QueryClient } from "@tanstack/react-query";
import { workspaceKeys } from "./queryKeys";
import { canRetainData } from "./request";

/** Mutations can affect dashboard, calendars, summaries and sibling scopes. */
export async function invalidateWorkspace(client: QueryClient): Promise<void> {
  await Promise.all(
    workspaceKeys.map((queryKey) => client.invalidateQueries({ queryKey })),
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
/** Only a transient failure is worth another try; a refusal stays a refusal. */
export const retryTransient = (failures: number, error: unknown) => failures < 1 && canRetainData(error);
