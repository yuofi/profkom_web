/** The code of a page is gone from the server: a new version was deployed after this tab
 *  opened (nginx answers 404 for an old hashed asset). Browsers word it differently. */
export const isChunkLoadError = (error: unknown) =>
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i
    .test(error instanceof Error ? `${error.name} ${error.message}` : String(error ?? ""));

const RELOADED_AT = "profkom-stale-chunk-reload";
/** One automatic reload loads the new version. A second failure soon after it means the
 *  asset is really missing: the error is shown then, so a tab never reloads in a loop. The
 *  page's own leave warning (beforeunload) still protects unsaved input. */
export function reloadOnceForStaleChunk(reload: () => void = () => window.location.reload(), now = Date.now()) {
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0); } catch { return false; }
  if (now - last < 60_000) return false;
  try { sessionStorage.setItem(RELOADED_AT, String(now)); } catch { return false; }
  reload();
  return true;
}
