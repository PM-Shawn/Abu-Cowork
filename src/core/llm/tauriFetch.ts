/**
 * Tauri HTTP fetch wrapper.
 *
 * Uses @tauri-apps/plugin-http which sends requests from the Rust side,
 * bypassing WebView CORS restrictions. Falls back to global fetch in
 * non-Tauri environments (e.g. vite dev server in browser).
 *
 * For requests to local AI providers (localhost / 127.0.0.1), we bypass
 * the plugin's internal `new Request(url, init)` step. On Windows,
 * Chromium/WebView2 adds `Origin: https://tauri.localhost` to the
 * Request object for cross-origin POST requests, which tauri-plugin-http
 * then forwards verbatim to reqwest — causing Ollama's CORS middleware
 * to return 403 Forbidden. By calling the plugin's IPC commands directly
 * with headers we construct ourselves, we avoid the browser injection.
 */

import { invoke } from '@tauri-apps/api/core';
import { LOCAL_FIRST_RESPONSE_TIMEOUT_MS } from './heartbeat';

let _loadPromise: Promise<{ fetch: typeof globalThis.fetch; localServerFetch: typeof globalThis.fetch }> | null = null;

// Headers that the browser may inject into a Request object for cross-origin
// requests. We strip them when talking to local AI providers so Ollama's
// CORS middleware doesn't reject the request with 403 Forbidden.
const STRIP_LOCAL_HEADERS = new Set(['origin', 'referer', 'host']);

const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?[/]/i;

// Hard ceiling for the connect + response-header phase. tauri-plugin-http's
// clientConfig.connectTimeout is undefined (no built-in timeout), so a server
// that accepts the TCP connection but never returns headers would otherwise
// hang forever. This path serves localhost / 127.0.0.1 addresses and requests
// to local model servers (any address), which do not send headers until they
// have processed the whole input. The LLM adapters' own local first-response timer (10
// minutes) fires first and aborts the request through its signal; this
// ceiling sits slightly above it as a last resort for callers without one.
const HEADER_TIMEOUT_MS = LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000;

/**
 * A fetch implementation that talks directly to tauri-plugin-http's IPC
 * commands, skipping the plugin's internal `new Request()` constructor.
 * This prevents WebView2 (Windows) from injecting `Origin` into the
 * forwarded headers, which causes Ollama CORS 403 errors.
 */
async function localFetch(input: RequestInfo | URL, init?: RequestInit, localServer = false): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;

  const method = init?.method ?? 'GET';
  const signal = init?.signal;

  if (signal?.aborted) throw new Error('Request cancelled');

  // Build headers from init directly — never touch new Request() to avoid
  // browser Origin injection. Strip CORS headers that local servers reject.
  const rawEntries: [string, string][] = init?.headers
    ? init.headers instanceof Headers
      ? Array.from(init.headers.entries())
      : Array.isArray(init.headers)
        ? (init.headers as [string, string][])
        : Object.entries(init.headers as Record<string, string>)
    : [];

  const headers: [string, string][] = rawEntries
    .map(([k, v]) => [k.toLowerCase(), String(v)] as [string, string])
    .filter(([k]) => !STRIP_LOCAL_HEADERS.has(k));

  // Encode body to a number array the way the plugin does
  let data: number[] | null = null;
  if (init?.body != null) {
    let bytes: Uint8Array;
    if (typeof init.body === 'string') {
      bytes = new TextEncoder().encode(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      bytes = new Uint8Array(init.body);
    } else if (init.body instanceof Uint8Array) {
      bytes = init.body;
    } else {
      bytes = new TextEncoder().encode(String(init.body));
    }
    data = Array.from(bytes);
  }

  // Step 1: create the request resource on Rust side
  // localServer 让 Electron 主进程（electron/httpHost.cjs）把响应头与正文的传输上限放到适配器 10 分钟之后
  const rid = await invoke<number>('plugin:http|fetch', {
    clientConfig: {
      method, url, headers, data, maxRedirections: undefined, connectTimeout: undefined,
      ...(localServer ? { localServer: true } : {}),
    },
  });

  const abort = () => invoke('plugin:http|fetch_cancel', { rid });
  if (signal?.aborted) { void abort(); throw new Error('Request cancelled'); }
  signal?.addEventListener('abort', () => void abort());

  // Step 2: send the request and receive response metadata.
  // Race against HEADER_TIMEOUT_MS so a server that never returns headers can't
  // hang the request indefinitely (connectTimeout is undefined on the Rust side).
  // On timeout we cancel the request resource so reqwest drops the connection.
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  const sendPromise = invoke<{ status: number; statusText: string; url: string; headers: [string, string][]; rid: number }>(
    'plugin:http|fetch_send',
    { rid },
  );
  const { status, statusText, url: responseUrl, headers: responseHeaders, rid: responseRid } =
    await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => {
        headerTimer = setTimeout(() => {
          void abort();
          reject(new Error(`Request timed out after ${HEADER_TIMEOUT_MS / 1000}s waiting for response headers`));
        }, HEADER_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(headerTimer));

  const dropBody = () => invoke('plugin:http|fetch_cancel_body', { rid: responseRid });

  // Step 3: pull body chunks from Rust via the ReadableStream protocol
  const readChunk = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    let chunk: number[];
    try {
      chunk = await invoke<number[]>('plugin:http|fetch_read_body', { rid: responseRid });
    } catch (e) {
      controller.error(e);
      void dropBody();
      return;
    }
    const u8 = new Uint8Array(chunk);
    // Last byte is a signal: 1 = end of stream, 0 = more data
    const lastByte = u8[u8.byteLength - 1];
    const actualData = u8.slice(0, u8.byteLength - 1);
    if (lastByte === 1) {
      controller.close();
      return;
    }
    controller.enqueue(actualData);
  };

  // 101/103/204/205/304 have null body per fetch spec
  const body = [101, 103, 204, 205, 304].includes(status)
    ? null
    : new ReadableStream<Uint8Array>({
        start: (controller) => {
          signal?.addEventListener('abort', () => {
            controller.error('Request cancelled');
            void dropBody();
          });
        },
        pull: (controller) => readChunk(controller),
        cancel: () => void dropBody(),
      });

  const res = new Response(body, { status, statusText });
  Object.defineProperty(res, 'url', { value: responseUrl });
  Object.defineProperty(res, 'headers', { value: new Headers(responseHeaders) });
  return res;
}

/**
 * Returns a fetch function that routes local-provider requests through
 * `localFetch` (no Origin injection) and all others through the plugin's
 * standard fetch.
 */
function wrapWithLocalFetch(pluginFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (LOCAL_URL_RE.test(url)) {
      return localFetch(input, init);
    }
    return pluginFetch(input, init);
  };
}

/** 本地模型服务的请求：发给 localFetch 并带上 localServer 标记，地址不限于本机 */
const localServerFetch: typeof globalThis.fetch = (input, init) => localFetch(input, init, true);

export interface TauriFetchOptions {
  /**
   * 请求发给本地模型服务（Ollama、LM Studio、地址在本机的自定义服务商）。首次回答前的
   * 等待与之后的空闲由适配器自己计时；桌面端发请求的 Node fetch（undici）默认 300 秒
   * 没收到响应头或正文空闲 300 秒就断开，带上这一项后这两个上限放到适配器 10 分钟之后
   * 10 秒（LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000），只作兜底。
   */
  localServer?: boolean;
}

/**
 * Get a fetch function that bypasses CORS in Tauri.
 * Must be called (awaited) before use.
 * Uses a Promise-based singleton to avoid concurrent import races.
 */
export function getTauriFetch(options: TauriFetchOptions = {}): Promise<typeof globalThis.fetch> {
  if (!_loadPromise) {
    _loadPromise = (async () => {
      // Non-Tauri runtime (web mode / E2E): skip the plugin import entirely and
      // return native fetch so the browser can make LLM requests directly.
      // Real desktop builds always have __TAURI_INTERNALS__ injected by the webview;
      // plain browser and E2E tests do not, so this check is sufficient.
      if (
        typeof window === 'undefined' ||
        !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      ) {
        return { fetch: globalThis.fetch, localServerFetch: globalThis.fetch };
      }
      try {
        const mod = await import('@tauri-apps/plugin-http');
        return { fetch: wrapWithLocalFetch(mod.fetch), localServerFetch };
      } catch {
        // Not in Tauri environment, fall back to global fetch
        return { fetch: globalThis.fetch, localServerFetch: globalThis.fetch };
      }
    })();
  }
  return _loadPromise.then((loaded) => (options.localServer ? loaded.localServerFetch : loaded.fetch));
}
