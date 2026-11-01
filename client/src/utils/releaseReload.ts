// A tab opened before a deploy can ask for a page chunk the server has since removed.
// Only a full page load recovers from that, and it also picks up the current release.
// Vite reports every failed chunk through this event, hover preloads included, so the
// failure is only noted here: reloading at that moment would interrupt a working page.
const LAST_RELOAD_KEY = 'defcon.chunkReloadAt';
const RELOAD_INTERVAL_MS = 60_000;

let chunkFailed = false;

export function watchChunkFailures(): void {
  window.addEventListener('vite:preloadError', () => {
    chunkFailed = true;
  });
}

/**
 * Reloads if a chunk has failed in this page load. Returns false when the caller has to
 * show the failure instead: no chunk failed, the browser is offline, there is no storage
 * to remember the attempt in, or this tab just reloaded and the chunk is still missing.
 */
export function reloadAfterChunkFailure(): boolean {
  if (!chunkFailed || !navigator.onLine) return false;
  try {
    const sinceLast = Date.now() - Number(window.sessionStorage.getItem(LAST_RELOAD_KEY) ?? 0);
    if (sinceLast >= 0 && sinceLast < RELOAD_INTERVAL_MS) return false;
    window.sessionStorage.setItem(LAST_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
