/**
 * Heartbeat — shared idle timeout for LLM streaming connections.
 *
 * Detects when a streaming connection stops sending data (network hang,
 * server stall) without closing the connection. Both Claude and OpenAI
 * adapters use this to trigger a timeout error after the silence window.
 *
 * Usage:
 *   const hb = createHeartbeat(DEFAULT_STREAM_HANG_TIMEOUT_MS, () => emit('error', ...));
 *   hb.reset();           // Start / reset timer
 *   for await (chunk) {
 *     hb.reset();         // Reset on each data chunk
 *   }
 *   hb.clear();           // Clean up on stream end
 */

import { LLMError } from './adapter';

/**
 * Idle/connect timeout (ms) for LLM streaming connections. Raised from 90s to
 * 180s: slow reasoning models can legitimately think for minutes before (or
 * between) tokens, and the old 90s ceiling falsely killed those requests and
 * triggered wasteful retries. Deliberately kept as ONE value shared by both the
 * connect/header phase and the inter-chunk idle phase — a shorter connect
 * ceiling would falsely kill local servers that load a model before sending
 * headers and header-buffering proxies, which are exactly the slow cases we
 * want to keep alive. Codex allows 300s here; 3min is enough for the office
 * use case.
 */
export const DEFAULT_STREAM_HANG_TIMEOUT_MS = 180_000;

/**
 * 本地服务（Ollama、LM Studio、地址在本机的自定义服务商）首次回答前的等待上限。
 * 它们处理长输入时在处理完之前不回响应头，也不发第一段输出；慢机器上这一段可能
 * 远超 180 秒，重试又会让服务从头处理一遍。从发出请求到收到第一段输出算一个整体，
 * 到时按 local_server_timeout 结束，不重试。开始输出之后两段之间的空闲仍按
 * DEFAULT_STREAM_HANG_TIMEOUT_MS。云端服务商不用它。
 */
export const LOCAL_FIRST_RESPONSE_TIMEOUT_MS = 600_000;

/** 本地服务在等待上限内没有开始回答：不可重试，主循环与子代理都直接结束。 */
export function localFirstResponseTimeoutError(): LLMError {
  return new LLMError(
    `本地服务 ${LOCAL_FIRST_RESPONSE_TIMEOUT_MS / 1000} 秒内没有开始回答`,
    'local_server_timeout',
    { retryable: false },
  );
}

/**
 * 首次回答前的计时：到时中止 streamAbort 并记下已超时，调用方在 catch 里据此区分
 * 「等超时了」与其他中止。`clear()` 在收到第一段输出（云端为响应头）时调用。
 */
export function armFirstResponseTimer(
  streamAbort: AbortController,
  timeoutMs: number,
): { timedOut: () => boolean; clear: () => void } {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    streamAbort.abort();
  }, timeoutMs);
  return {
    timedOut: () => timedOut,
    clear: () => clearTimeout(timer),
  };
}

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
