/**
 * Shared helper for wiring an external `AbortSignal` into a transport's own
 * cancellation mechanism (a WS request's pending-map entry, an internal
 * `AbortController` backing a `fetch`, ...).
 *
 * Both browser transports (`chromeWsTransport` in tools.ts/wsServer.ts, and
 * `HttpBrowserTransport` in electron/browser-runtime/server.ts) need the same
 * three behaviors — trigger a callback on abort, do it synchronously if the
 * signal is already aborted before we start waiting, and never leak the
 * listener once the operation settles by any other means (success, timeout,
 * disconnect) — so the logic lives here once instead of being duplicated (and
 * drifting) in each transport.
 */

/**
 * Attach `onAbort` to `signal`. If `signal` is already aborted, `onAbort`
 * fires synchronously before this function returns (so the caller can skip
 * ever starting the underlying operation) and the returned cleanup is a
 * no-op. Otherwise `onAbort` fires at most once, and the returned cleanup
 * detaches the listener so it never fires after the operation has already
 * settled some other way.
 *
 * Returns a no-op cleanup (and never calls `onAbort`) when `signal` is
 * `undefined`, so callers can use this unconditionally.
 */
export function linkAbortSignal(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}
