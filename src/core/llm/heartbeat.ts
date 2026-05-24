/**
 * Heartbeat — shared idle timeout for LLM streaming connections.
 *
 * Detects when a streaming connection stops sending data (network hang,
 * server stall) without closing the connection. Both Claude and OpenAI
 * adapters use this to trigger a timeout error after 90s of silence.
 *
 * Usage:
 *   const hb = createHeartbeat(90_000, () => emit('error', ...));
 *   hb.reset();           // Start / reset timer
 *   for await (chunk) {
 *     hb.reset();         // Reset on each data chunk
 *   }
 *   hb.clear();           // Clean up on stream end
 */

/**
 * Default idle/connect timeout (ms) for LLM streaming connections. 90s is the
 * CC-validated threshold — long enough for slow reasoning models to produce a
 * first token, short enough to detect a real network hang. Shared by both LLM
 * adapters for the connect/header phase and the inter-chunk idle timeout.
 */
export const DEFAULT_STREAM_HANG_TIMEOUT_MS = 90_000;

/**
 * Create a heartbeat timer that calls `onTimeout` if not reset within `timeoutMs`.
 */
export function createHeartbeat(
  timeoutMs: number,
  onTimeout: () => void,
): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function reset(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTimeout, timeoutMs);
  }

  function clear(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { reset, clear };
}

/**
 * Merge AbortSignals into one that aborts when ANY input aborts.
 *
 * Prefers the native `AbortSignal.any` (clean, no listener leak), but falls
 * back to manual forwarding on engines that lack it — notably WKWebView on
 * macOS < 14.4 (Safari < 17.4), where `AbortSignal.any` is `undefined`. Without
 * the fallback, calling it would throw `TypeError` on the first line of every
 * chat() and break ALL conversations on those systems. Only `addEventListener`
 * (a 20-year-old API) is used in the fallback, so it runs everywhere.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
