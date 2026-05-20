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

let _loadPromise: Promise<typeof globalThis.fetch> | null = null;

// Headers that the browser may inject into a Request object for cross-origin
// requests. We strip them when talking to local AI providers so Ollama's
// CORS middleware doesn't reject the request with 403 Forbidden.
const STRIP_LOCAL_HEADERS = new Set(['origin', 'referer', 'host']);

const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?[/]/i;

/**
 * A fetch implementation that talks directly to tauri-plugin-http's IPC
 * commands, skipping the plugin's internal `new Request()` constructor.
 * This prevents WebView2 (Windows) from injecting `Origin` into the
 * forwarded headers, which causes Ollama CORS 403 errors.
 */
async function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
  const rid = await invoke<number>('plugin:http|fetch', {
    clientConfig: { method, url, headers, data, maxRedirections: undefined, connectTimeout: undefined },
  });

  const abort = () => invoke('plugin:http|fetch_cancel', { rid });
  if (signal?.aborted) { void abort(); throw new Error('Request cancelled'); }
  signal?.addEventListener('abort', () => void abort());

  // Step 2: send the request and receive response metadata
  const { status, statusText, url: responseUrl, headers: responseHeaders, rid: responseRid } =
    await invoke<{ status: number; statusText: string; url: string; headers: [string, string][]; rid: number }>(
      'plugin:http|fetch_send',
      { rid },
    );

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

/**
 * Get a fetch function that bypasses CORS in Tauri.
 * Must be called (awaited) before use.
 * Uses a Promise-based singleton to avoid concurrent import races.
 */
export function getTauriFetch(): Promise<typeof globalThis.fetch> {
  if (!_loadPromise) {
    _loadPromise = (async () => {
      try {
        const mod = await import('@tauri-apps/plugin-http');
        return wrapWithLocalFetch(mod.fetch);
      } catch {
        // Not in Tauri environment, fall back to global fetch
        return globalThis.fetch;
      }
    })();
  }
  return _loadPromise;
}
