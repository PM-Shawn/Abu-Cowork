/**
 * Electron main-side `@tauri-apps/plugin-http` handlers (UI-side HTTP).
 *
 * The frontend's `tauriFetch.ts` (LLM transport fallback, connection-verify,
 * webTools, mediaTools) routes fetches through plugin:http BECAUSE the renderer's
 * CSP blocks cross-origin requests to arbitrary LLM endpoints — Tauri did the
 * actual fetch in Rust to bypass it. Electron's main-process Node `fetch` bypasses
 * the renderer CSP the same way, so we reproduce the plugin's request/stream
 * protocol here. (The main LLM chat path goes through the sidecar's native fetch,
 * not this — but "验证连接" / web / media tools use this, and it was stubbed →
 * `plugin:http|fetch_send` returned null → "Cannot destructure property 'status'
 * of null" in tauriFetch even though the model actually works.)
 *
 * Protocol (from tauriFetch.ts, matching @tauri-apps/plugin-http):
 *  - fetch { clientConfig: {method,url,headers:[k,v][],data:number[]|null,…} } → rid (number)
 *  - fetch_send { rid } → { status, statusText, url, headers:[k,v][], rid: responseRid }
 *  - fetch_read_body { rid: responseRid } → number[] where the LAST byte is a
 *    signal (1 = end-of-stream, 0 = more data) and the rest is the chunk.
 *  - fetch_cancel { rid } / fetch_cancel_body { rid: responseRid }
 */
'use strict';

const HTTP_MISS = Symbol('http-dispatch-miss');
const HTTP_CMDS = new Set([
  'plugin:http|fetch',
  'plugin:http|fetch_send',
  'plugin:http|fetch_read_body',
  'plugin:http|fetch_cancel',
  'plugin:http|fetch_cancel_body',
]);

let nextRid = 1;
/** rid -> { config, controller } */
const requests = new Map();
/** responseRid -> { reader } */
const bodies = new Map();

async function httpHandle(cmd, a) {
  switch (cmd) {
    case 'plugin:http|fetch': {
      const rid = nextRid++;
      requests.set(rid, { config: a.clientConfig || {}, controller: new AbortController() });
      return rid;
    }

    case 'plugin:http|fetch_send': {
      const req = requests.get(a.rid);
      if (!req) throw new Error(`plugin:http|fetch_send: no request for rid ${a.rid}`);
      const { method = 'GET', url, headers = [], data } = req.config;
      const init = { method, headers, signal: req.controller.signal, redirect: 'follow' };
      // number[] body only for methods that carry one (GET/HEAD with a body throws).
      if (Array.isArray(data) && data.length && method !== 'GET' && method !== 'HEAD') {
        init.body = Buffer.from(data);
      }
      let res;
      try {
        res = await fetch(url, init);
      } finally {
        requests.delete(a.rid);
      }
      const responseRid = nextRid++;
      bodies.set(responseRid, { reader: res.body ? res.body.getReader() : null });
      return {
        status: res.status,
        statusText: res.statusText || '',
        url: res.url || url,
        headers: [...res.headers.entries()],
        rid: responseRid,
      };
    }

    case 'plugin:http|fetch_read_body': {
      const b = bodies.get(a.rid);
      // No body / already drained → end-of-stream signal (last byte 1).
      if (!b || !b.reader) {
        bodies.delete(a.rid);
        return [1];
      }
      const { value, done } = await b.reader.read();
      if (done) {
        bodies.delete(a.rid);
        return [1];
      }
      // chunk bytes + a trailing 0 ("more data") signal byte.
      const out = Array.from(value);
      out.push(0);
      return out;
    }

    case 'plugin:http|fetch_cancel': {
      const req = requests.get(a.rid);
      if (req) {
        try {
          req.controller.abort();
        } catch {
          /* already settled */
        }
        requests.delete(a.rid);
      }
      return null;
    }

    case 'plugin:http|fetch_cancel_body': {
      const b = bodies.get(a.rid);
      if (b) {
        try {
          if (b.reader) void b.reader.cancel();
        } catch {
          /* already closed */
        }
        bodies.delete(a.rid);
      }
      return null;
    }

    default:
      return HTTP_MISS;
  }
}

/**
 * @returns HTTP_MISS synchronously for non-http commands (fast path), else a
 * Promise resolving to the plugin:http result. tauriHost's async handler returns
 * the Promise as-is.
 */
function httpDispatch(cmd, args) {
  if (!HTTP_CMDS.has(cmd)) return HTTP_MISS;
  return httpHandle(cmd, args || {});
}

module.exports = { httpDispatch, HTTP_MISS };
