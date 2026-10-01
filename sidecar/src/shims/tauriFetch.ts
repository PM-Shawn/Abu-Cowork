/**
 * Sidecar shim for `src/core/llm/tauriFetch.ts`.
 *
 * The real module routes through `@tauri-apps/plugin-http` IPC to bypass
 * WebView CORS — meaningless in a plain Node process, which has no WebView
 * and no CORS restrictions to begin with. Ordinary requests use
 * `globalThis.fetch`, as the real module does outside the desktop webview;
 * this shim also keeps the plugin-http dynamic import path out of the bundle.
 * Requests to a local model server (`{ localServer: true }`) go through an
 * undici Agent whose header / body limits sit past the adapters' own 10-minute
 * first-response wait, matching the Electron
 * main-side host (`electron/httpHost.cjs`). Swapped in at bundle time by
 * `scripts/build-sidecar.mjs`. Same public surface (`getTauriFetch()`).
 */

import { Agent, fetch as undiciFetch } from 'undici';
import type { TauriFetchOptions } from '@/core/llm/tauriFetch';
import { LOCAL_FIRST_RESPONSE_TIMEOUT_MS } from '@/core/llm/heartbeat';

// Node 自带的 fetch（undici）默认 300 秒没收到响应头、或两段内容之间空闲 300 秒就断开，
// 并报成普通的 fetch 失败。本地模型服务在慢机器上处理长输入时，首次回答前的等待会超过
// 这个时长；这段等待与之后的空闲由适配器自己计时（首次回答 10 分钟先触发并中止请求），
// 传输层上限放在它之后 10 秒，只给没有自己计时的情况兜底。
// 用同一个 undici 包的 fetch 与 Agent，避免与 Node 自带的 undici 版本混用。
const LOCAL_SERVER_TRANSPORT_TIMEOUT_MS = LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000;
let localServerAgent: Agent | undefined;

const localServerFetch: typeof globalThis.fetch = (input, init) => {
  localServerAgent ??= new Agent({
    headersTimeout: LOCAL_SERVER_TRANSPORT_TIMEOUT_MS,
    bodyTimeout: LOCAL_SERVER_TRANSPORT_TIMEOUT_MS,
  });
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...init, dispatcher: localServerAgent } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
};

export function getTauriFetch(options: TauriFetchOptions = {}): Promise<typeof globalThis.fetch> {
  return Promise.resolve(options.localServer ? localServerFetch : globalThis.fetch);
}
