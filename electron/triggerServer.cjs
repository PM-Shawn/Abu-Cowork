/**
 * Electron main-side loopback HTTP trigger server (Phase 2 slice F9), porting
 * src-tauri/src/trigger_server.rs's raw-TcpListener server to a plain Node
 * `http` server. Backs `start_trigger_server` / `get_trigger_server_port` —
 * the two custom commands the frontend's trigger engine
 * (src/core/trigger/triggerEngine.ts, ~line 71/78) and the IM plugin
 * heartbeat helper (src/core/im/pluginHeartbeatUtils.ts, ~line 12) invoke.
 *
 * ## Endpoints (verified line-for-line against trigger_server.rs's `match`)
 * - `GET  /health`                 -> `{"status":"ok"}`
 * - `POST /trigger/{id}`           -> fires a trigger; emits `trigger-http-event`
 *   with `{ triggerId, payload }` (the exact shape triggerEngine.ts's
 *   `listen<{ triggerId: string; payload: TriggerEventPayload }>(...)` expects
 *   at `event.payload`).
 * - `POST /im/{platform}/webhook`  -> IM inbound webhook; emits
 *   `im-inbound-event` with `{ platform, payload }`. Feishu/Slack URL-
 *   verification challenges are echoed back directly (never forwarded to the
 *   renderer), matching the Rust source.
 * - `POST /{platform}` (short alias, single path segment, no `/im/.../webhook`
 *   wrapper) -> same as the /im/ route above, best-effort (never surfaces an
 *   emit failure to the HTTP caller — mirrors Rust's `let _ = app.emit(...)`).
 *
 * Request-target handling deliberately mirrors the Rust parser's naivety: the
 * Rust side never parses a URL, it just takes the raw `request-target` text
 * off the request line as `path` — so a query string (if any) rides along
 * inside that string rather than being stripped. `req.url` is used as-is here
 * for the same reason (no `new URL()` / query-stripping).
 *
 * ## Bind address
 * Same contract as trigger_server.rs's `start_server(app, port, bind_addr)`:
 * `bindAddr` defaults to `'127.0.0.1'` (loopback-only) but the frontend
 * (triggerEngine.ts `start()`) may pass `'0.0.0.0'` when an IM plugin needs
 * heartbeat/LAN-callback reachability — that choice is the frontend's, this
 * module just binds whatever it's told, exactly like the Rust `TcpListener`.
 *
 * ## Deliberate DEVIATION from the Rust source: idempotent start
 * `trigger_server.rs`'s `start_server` returns `Err("Trigger server already
 * running")` on a second call (`OnceLock` guard) — the frontend's `start()`
 * already tolerates that (catches the invoke rejection and falls back to
 * `get_trigger_server_port`). Per this port's task brief, `start_trigger_server`
 * here is idempotent instead: a second call returns the already-bound port
 * rather than throwing. This is a strictly more permissive behavior the
 * frontend's existing catch-and-fallback handles identically either way (same
 * final `serverPort`), so it doesn't change observable frontend behavior.
 *
 * Wired from electron/tauriHost.cjs via triggerDispatch(app, cmd, args) — args
 * is the args object directly (mirrors commandDispatch's convention), placed
 * after commandDispatch and before windowDispatch in the dispatch chain (see
 * the wiring comment there).
 */
'use strict';

const http = require('node:http');

/** Sentinel returned when `cmd` isn't a trigger-server command. */
const TRIGGER_MISS = Symbol('trigger-dispatch-miss');

/** Mirrors trigger_server.rs's read_body cap (1 MiB). */
const MAX_BODY_BYTES = 1_048_576;

// ─── Module state ──────────────────────────────────────────────────────────
/** @type {{ server: import('node:http').Server, port: number, bindAddr: string } | null} */
let serverState = null;
/** @type {Promise<{ server: import('node:http').Server, port: number, bindAddr: string }> | null} */
let startPromise = null;

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Start the trigger HTTP server lazily (idempotent — see module doc header's
 * "Deliberate DEVIATION" note). `port` of 0 lets the OS assign one (mirrors
 * Rust's `TcpListener::bind` + `listener.local_addr().port()` for the
 * `port: 0` case); a non-zero port binds exactly that port, erroring if
 * already in use — same as the Rust `TcpListener::bind` failure path.
 * @param {number} port
 * @param {string} bindAddr
 * @returns {Promise<{ server: import('node:http').Server, port: number, bindAddr: string }>}
 */
function startServer(port, bindAddr) {
  if (serverState) return Promise.resolve(serverState);
  if (startPromise) return startPromise;

  const addr = bindAddr || '127.0.0.1';
  const requestedPort = typeof port === 'number' && Number.isFinite(port) ? port : 0;

  startPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      requestListener(req, res).catch((err) => {
        // Defensive — requestListener already catches its own JSON/emit
        // errors and responds; this only fires on a truly unexpected throw
        // (e.g. a synchronous bug), so fail the connection rather than hang.
        try {
          if (!res.headersSent) {
            sendJson(res, 500, { success: false, message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
          } else {
            res.destroy();
          }
        } catch {
          /* best-effort */
        }
      });
    });
    server.on('error', (err) => {
      startPromise = null;
      reject(err);
    });
    server.listen(requestedPort, addr, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
      serverState = { server, port: actualPort, bindAddr: addr };
      console.log(`[TriggerServer] Listening on ${addr}:${actualPort}`);
      resolve(serverState);
    });
  });
  return startPromise;
}

// ─── HTTP plumbing ─────────────────────────────────────────────────────────

function sendJson(res, status, bodyObj) {
  const body = JSON.stringify(bodyObj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    // Mirrors trigger_server.rs's send_json response headers.
    'Access-Control-Allow-Origin': '*',
    Connection: 'close',
  });
  res.end(body);
}

/**
 * Collect the request body, capped at MAX_BODY_BYTES (bytes beyond the cap
 * are dropped, not buffered — approximates Rust's `content_length.min(1MiB)`
 * + `read_exact` cap without needing to trust a possibly-wrong Content-Length
 * header). Missing/empty body resolves to `"{}"`, matching Rust's read_body
 * default when `content_length == 0`.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) return; // drop excess, keep draining
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(chunks.length === 0 ? '{}' : Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve('{}'));
  });
}

/** Mirrors trigger_server.rs's trigger-id / platform-name char validation. */
function isValidId(id, maxLen) {
  if (id.length === 0 || id.length > maxLen) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** Mirrors trigger_server.rs's `is_short_platform_path`. */
function isShortPlatformPath(pathname) {
  if (pathname.length <= 1 || pathname.length > 33) return false;
  const name = pathname.slice(1);
  if (name.includes('/')) return false;
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * Deliver an event to the renderer via tauriHost's event bridge. Required
 * LAZILY (not at module top-level) to avoid a circular-require deadlock:
 * tauriHost.cjs requires this module (to wire triggerDispatch) at its own
 * top level, so a top-level require here would see tauriHost's module.exports
 * mid-construction (before `emitEvent` is assigned). By call time (an actual
 * HTTP request has arrived), tauriHost.cjs has always finished loading.
 * @param {string} event
 * @param {unknown} payload
 */
function emitToRenderer(event, payload) {
  // eslint-disable-next-line global-require -- see doc comment above.
  require('./tauriHost.cjs').emitEvent(event, payload);
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function requestListener(req, res) {
  const method = req.method || '';
  // Raw request-target, NOT url-parsed — see module doc header.
  const pathname = req.url || '';

  // GET /health
  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // POST /trigger/{id}
  if (method === 'POST' && pathname.startsWith('/trigger/')) {
    const triggerId = pathname.slice('/trigger/'.length);
    if (triggerId.length === 0) {
      sendJson(res, 400, { success: false, message: 'Missing trigger ID' });
      return;
    }
    if (!isValidId(triggerId, 64)) {
      sendJson(res, 400, { success: false, message: 'Invalid trigger ID' });
      return;
    }

    const bodyStr = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(bodyStr);
    } catch {
      sendJson(res, 400, { success: false, message: 'Invalid JSON body' });
      return;
    }

    const eventData = { triggerId, payload };
    try {
      emitToRenderer('trigger-http-event', eventData);
      sendJson(res, 200, { success: true, message: `Trigger ${triggerId} fired` });
    } catch (err) {
      sendJson(res, 500, { success: false, message: `Event emit failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }

  // POST /im/{platform}/webhook
  if (method === 'POST' && pathname.startsWith('/im/') && pathname.endsWith('/webhook')) {
    // Mirrors Rust's `&p[4..p.len()-8]` (strip "/im/" prefix + "/webhook"
    // suffix) then `.trim_matches('/')` (only leading/trailing, NOT internal
    // slashes — an inner-slash platform like "/im/foo/bar/webhook" is left
    // with internal "/" and correctly rejected by isValidId below, same as Rust).
    const inner = pathname.slice(4, pathname.length - 8);
    const platform = inner.replace(/^\/+|\/+$/g, '');

    if (!isValidId(platform, 32)) {
      sendJson(res, 400, { success: false, message: 'Invalid platform name' });
      return;
    }

    const bodyStr = await readBody(req);

    if (platform === 'feishu') {
      try {
        const v = JSON.parse(bodyStr);
        if (v && typeof v.challenge === 'string') {
          sendJson(res, 200, { challenge: v.challenge });
          return;
        }
      } catch {
        /* not JSON / no challenge field -> fall through to normal handling */
      }
    }

    if (platform === 'slack') {
      try {
        const v = JSON.parse(bodyStr);
        if (v && v.type === 'url_verification' && typeof v.challenge === 'string') {
          sendJson(res, 200, { challenge: v.challenge });
          return;
        }
      } catch {
        /* fall through */
      }
    }

    let payload;
    try {
      payload = JSON.parse(bodyStr);
    } catch {
      sendJson(res, 400, { success: false, message: 'Invalid JSON body' });
      return;
    }

    const eventData = { platform, payload };
    try {
      emitToRenderer('im-inbound-event', eventData);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { success: false, message: `Event emit failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }

  // POST /{platform} — short alias, best-effort (Rust: `let _ = app.emit(...)`
  // — an emit failure here is silently swallowed, never surfaced as a 500).
  if (method === 'POST' && isShortPlatformPath(pathname)) {
    const platform = pathname.slice(1);
    const bodyStr = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(bodyStr);
    } catch {
      sendJson(res, 400, { success: false, message: 'Invalid JSON body' });
      return;
    }
    try {
      emitToRenderer('im-inbound-event', { platform, payload });
    } catch {
      /* best-effort, matches Rust's `let _ = app.emit(...)` */
    }
    sendJson(res, 200, {});
    return;
  }

  sendJson(res, 404, { success: false, message: 'Not found' });
}

// ─── Command dispatch ──────────────────────────────────────────────────────

/**
 * @param {import('electron').App} app unused — kept for signature parity with
 *   commandHost.cjs's dispatch(app, cmd, args) convention.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
async function triggerDispatch(app, cmd, args) {
  void app;
  const a = args || {};
  switch (cmd) {
    case 'start_trigger_server': {
      const port = typeof a.port === 'number' ? a.port : 0;
      const bindAddr = typeof a.bindAddr === 'string' ? a.bindAddr : '127.0.0.1';
      const state = await startServer(port, bindAddr);
      return state.port;
    }
    case 'get_trigger_server_port':
      return serverState ? serverState.port : null;
    default:
      return TRIGGER_MISS;
  }
}

module.exports = {
  triggerDispatch,
  TRIGGER_MISS,
  // Exported for the headless verify harness (electron/spike/f9Verify.cjs).
  startServer,
};
