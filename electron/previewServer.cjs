/**
 * Electron main-side loopback HTTP preview server (Phase 2 slice F13), porting
 * src-tauri/src/preview_server.rs's `axum` server to a plain Node `http`
 * server. Backs `get_preview_server_info` / `register_preview_root` /
 * `unregister_preview_root` — the three custom commands
 * src/utils/previewUrl.ts invokes to build `http://127.0.0.1:{port}/files/
 * {token}/{rootId}/{name}` URLs for sandboxed-iframe HTML previews.
 *
 * ## Why a REAL http server, not `protocol.handle`
 * The frontend hardcodes the `http://` scheme in `buildPreviewUrl()` — it is
 * NOT parameterized by runtime. A custom Electron protocol (`abu-preview://`
 * etc.) would change that scheme and break every already-shipped preview URL
 * shape the frontend assumes, plus reintroduce the exact WKWebView-class
 * problem `preview_server.rs`'s doc comment describes (non-`http(s)` schemes
 * don't compose reliably with sandboxed iframe sub-resource loads across all
 * embedding surfaces). So: bind loopback TCP, same as Tauri did.
 *
 * ## Security model (ported from preview_server.rs — see its module doc)
 * - Bound to `127.0.0.1` only, kernel-assigned port (`listen(0, '127.0.0.1')`).
 * - Per-launch random token in the URL path, verified with
 *   `crypto.timingSafeEqual` (constant-time; length mismatch is allowed to
 *   short-circuit because the URL is plaintext anyway — mirrors Rust's
 *   `verify_token` comment).
 * - `Host` header must be `127.0.0.1:PORT` or `localhost:PORT` (anti-DNS-
 *   rebinding) — checked BEFORE the method guard, matching the Rust router's
 *   actual layer order (`.layer(method_guard).layer(host_guard)` — axum's
 *   last-added layer is outermost, so host_guard runs first).
 * - `Origin`, if present, must be `null` or `http://{127.0.0.1|localhost}:PORT`.
 * - GET/HEAD only, else 405.
 * - Path canonicalization (per-segment decode, reject `.`/`..`/backslash/NUL,
 *   join under root, `realpath` + prefix check) — defeats `../` and symlink
 *   escapes. One deliberate ADDITION beyond the Rust: a decoded segment that
 *   itself contains `/` (e.g. a `%2F`-encoded segment) is also rejected. This
 *   is strictly narrower than Rust (never blocks a real file — `/` cannot
 *   appear in a filename on any target OS) and avoids Node `path.join`
 *   silently reinterpreting an embedded separator as extra path components.
 * - Same hard-coded blocklist (dirs: .ssh/.aws/.gnupg/.kube/.docker; file
 *   prefixes: .env/id_rsa/id_dsa/id_ed25519/id_ecdsa; extensions: pem/key/
 *   p12/pfx) checked against the path SEGMENT ONLY under the resolved root.
 * - Response headers: Content-Type (small hand-rolled ext→mime table — no new
 *   npm dep), charset=utf-8 appended for text/* without one, `Cache-Control:
 *   no-store`, `X-Content-Type-Options: nosniff`, and the same permissive-but-
 *   sandboxed CSP Rust sends (`sandbox allow-scripts allow-same-origin
 *   allow-forms allow-popups`).
 *
 * ## Deliberate DEVIATION from the task brief: no `X-Frame-Options`
 * The brief asked for `X-Frame-Options: SAMEORIGIN` alongside nosniff. The
 * actual Rust source does NOT set it, and its comment explains why: the
 * legitimate embedder (the app's own window) is a DIFFERENT origin from this
 * loopback server (Tauri: `tauri://localhost`/`https://tauri.localhost`;
 * Electron: `file://...`), so `SAMEORIGIN` would block the very iframe this
 * server exists to serve — not just cross-site framing. Electron's host
 * window loads via `win.loadFile(...)` (`file://`), which is if anything a
 * MORE different origin than Tauri's custom scheme, so the same reasoning
 * applies at least as strongly here. Faithfully porting preview_server.rs
 * means reproducing its actual (working) behavior, not the brief's
 * paraphrase of it — see CLAUDE.md's "read code, not memory" rule. The CSP
 * `sandbox` directive plus loopback+token+Host/Origin checks are the real
 * defenses against cross-site framing, exactly as the Rust comment states.
 *
 * ## HTML picker-script injection
 * `.html`/`.htm` responses under MAX_HTML_INJECT_BYTES get the preview
 * element-picker script (`src-tauri/inspect/abu-preview-inspect.js` — shared
 * verbatim with the Tauri build, read once at module load) spliced in right
 * before the last `</body>` (falls back to `</html>`, then end-of-file),
 * with any `</script` inside the JS neutralized to `<\/script` first so an
 * incidental occurrence (e.g. in the script's own doc comments) can't
 * prematurely close the injected `<script>` tag. If the inspect file is
 * missing, injection is skipped (logged once) rather than failing responses.
 *
 * Module state (http server, per-launch token, root registry + LRU) lives at
 * module scope and is started lazily on first `get_preview_server_info` /
 * `register_preview_root` call, for the app process lifetime — mirrors the
 * Rust `OnceLock<PreviewServerHandle>` + idempotent `start()`.
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/** Sentinel returned when `cmd` isn't a preview-server command. */
const PREVIEW_MISS = Symbol('preview-dispatch-miss');

/** Mirrors preview_server.rs's MAX_ROOTS. */
const MAX_ROOTS = 16;

/** Mirrors preview_server.rs's MAX_HTML_INJECT_BYTES (16 MiB). */
const MAX_HTML_INJECT_BYTES = 16 * 1024 * 1024;

// ─── Blocklist (mirrors preview_server.rs's BLOCKED_* consts) ─────────────
const BLOCKED_PATH_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker'];
const BLOCKED_FILE_PREFIXES = ['.env', 'id_rsa', 'id_dsa', 'id_ed25519', 'id_ecdsa'];
const BLOCKED_FILE_EXTS = new Set(['pem', 'key', 'p12', 'pfx']);

// ─── Content-Type table (hand-rolled — no new npm dep, per task brief) ────
const EXT_MIME = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  txt: 'text/plain',
  map: 'application/json',
};

const DEFAULT_MIME = 'application/octet-stream';

// ─── Inspect JS (HTML picker injection) — read once at module load ────────
const INSPECT_JS_PATH = path.join(__dirname, '..', 'src-tauri', 'inspect', 'abu-preview-inspect.js');
let inspectJs = null;
try {
  inspectJs = fs.readFileSync(INSPECT_JS_PATH, 'utf8');
} catch (err) {
  // Not fatal — previews still work, just without the element-picker overlay.
  console.warn(
    `[previewServer] inspect script not found at ${INSPECT_JS_PATH}, HTML picker injection disabled:`,
    err instanceof Error ? err.message : String(err)
  );
}

// ─── Module state ──────────────────────────────────────────────────────────
/** @type {{ server: import('node:http').Server, port: number, token: string } | null} */
let serverState = null;
/** @type {Promise<{ server: import('node:http').Server, port: number, token: string }> | null} */
let startPromise = null;

/** `rootId` -> canonical filesystem path. */
const roots = new Map();
/** LRU order, front = most recently accessed. */
const accessOrder = [];

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Start the loopback server lazily (idempotent — later calls return the same
 * handle without rebinding). Mirrors preview_server.rs's `start()`.
 * @returns {Promise<{ server: import('node:http').Server, port: number, token: string }>}
 */
function startServer() {
  if (serverState) return Promise.resolve(serverState);
  if (startPromise) return startPromise;

  startPromise = new Promise((resolve, reject) => {
    const server = http.createServer(requestListener);
    server.on('error', (err) => {
      startPromise = null;
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const token = generateToken();
      serverState = { server, port, token };
      console.log(`[previewServer] listening on 127.0.0.1:${port}`);
      resolve(serverState);
    });
  });
  return startPromise;
}

/** 32 url-safe hex characters (128 random bits) — same entropy as Rust's UUIDv4-simple token. */
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── Root registry (mirrors preview_server.rs's PreviewServerHandle impl) ──

/**
 * Deterministic, URL-safe id derived from the canonical path. Same canonical
 * dir always yields the same id (idempotent registration) — collision-
 * resistance beyond "unique within this process's root registry" isn't
 * needed since the path itself, not the id, is the authority. 16 hex chars
 * (64 bits) mirrors the bit-width of Rust's `DefaultHasher`-based id.
 */
function rootIdFromPath(canonPath) {
  return crypto.createHash('sha256').update(canonPath, 'utf8').digest('hex').slice(0, 16);
}

function bumpLru(id) {
  const idx = accessOrder.indexOf(id);
  if (idx !== -1) accessOrder.splice(idx, 1);
  accessOrder.unshift(id);
}

/**
 * Register `rawPath`'s canonical form as a preview root, LRU-evicting the
 * oldest once more than MAX_ROOTS are registered. Throws if `rawPath` doesn't
 * exist (mirrors Rust's `std::fs::canonicalize` failure -> `Result::Err`).
 * @param {string} rawPath
 * @returns {string} rootId
 */
function registerRoot(rawPath) {
  const canon = fs.realpathSync(rawPath);
  const id = rootIdFromPath(canon);

  if (roots.has(id)) {
    bumpLru(id);
    return id;
  }

  roots.set(id, canon);
  accessOrder.unshift(id);
  while (roots.size > MAX_ROOTS) {
    const victim = accessOrder.pop();
    if (victim === undefined) break;
    roots.delete(victim);
  }
  return id;
}

/** @param {string} id @returns {string | null} */
function lookupRoot(id) {
  const p = roots.get(id);
  if (p === undefined) return null;
  bumpLru(id);
  return p;
}

/** @param {string} id @returns {boolean} whether it was present */
function unregisterRoot(id) {
  const idx = accessOrder.indexOf(id);
  if (idx !== -1) accessOrder.splice(idx, 1);
  return roots.delete(id);
}

// ─── Token verification ────────────────────────────────────────────────────

/** Constant-time compare; length mismatch is OK to leak (URL is plaintext anyway). */
function verifyToken(expected, actual) {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ─── Path resolution + blocklist (mirrors resolve_path / is_blocked) ──────

class PathError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

/**
 * Decode each `/`-separated segment, join under `root`, then realpath +
 * verify the result stays inside `root` (defeats `../` and symlink-out-of-
 * root escapes). Throws PathError on any violation — ALL variants are
 * treated identically by the caller (400), matching serve_file's
 * `Err(_) => StatusCode::BAD_REQUEST` (this also means a plain "file doesn't
 * exist" 404-shaped miss surfaces as 400 here, same as the Rust: canonicalize
 * fails before the later metadata-based 404 check ever runs — a faithfully
 * ported quirk, not a bug).
 * @param {string} root
 * @param {string} relPath raw (still percent-encoded) `/`-joined path
 */
function resolvePath(root, relPath) {
  const rawSegments = relPath.split('/');
  const decodedSegments = [];
  for (const rawSeg of rawSegments) {
    if (rawSeg.length === 0) throw new PathError('BadSegment');
    let seg;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      throw new PathError('BadSegment');
    }
    if (seg === '.' || seg === '..') throw new PathError('BadSegment');
    // No backslash (blocks Windows-style traversal even on Unix) or NUL. The
    // embedded-'/' check is an addition beyond the Rust source — see module
    // doc header; it can never reject a legitimate filename.
    if (seg.includes('\\') || seg.includes('\0') || seg.includes('/')) {
      throw new PathError('BadSegment');
    }
    decodedSegments.push(seg);
  }

  const joined = path.join(root, ...decodedSegments);

  let canonTarget;
  let canonRoot;
  try {
    canonTarget = fs.realpathSync(joined);
    canonRoot = fs.realpathSync(root);
  } catch {
    throw new PathError('NotFound');
  }
  if (canonTarget !== canonRoot && !canonTarget.startsWith(canonRoot + path.sep)) {
    throw new PathError('Escape');
  }
  return canonTarget;
}

/**
 * Blocklist check on the CANONICAL path, restricted to the portion under
 * `root` (an ancestor directory named `.ssh` above the root is irrelevant —
 * mirrors is_blocked's comment).
 */
function isBlocked(target, root) {
  const rel = path.relative(root, target);
  const segments = rel.split(path.sep).filter((s) => s.length > 0);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (BLOCKED_PATH_SEGMENTS.some((b) => lower === b)) return true;
    if (BLOCKED_FILE_PREFIXES.some((b) => lower.startsWith(b))) return true;
  }
  const ext = path.extname(target).slice(1).toLowerCase();
  if (BLOCKED_FILE_EXTS.has(ext)) return true;
  return false;
}

// ─── HTML picker-script injection (mirrors inject_picker_script et al.) ───

/** Neutralize `</script` (case-insensitive) so injected JS can't early-close its wrapper `<script>` tag. */
function escapeScriptClose(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

/**
 * Case-insensitive byte-window scan for the LAST occurrence of an ASCII
 * `needle` in `haystack`, without allocating per-window substrings (safe and
 * fast even at the MAX_HTML_INJECT_BYTES cap). Mirrors preview_server.rs's
 * `find_ci` (also last-occurrence, also ASCII-only so it never risks
 * splitting a multi-byte/surrogate-pair character).
 */
function findLastCi(haystack, needle) {
  const hLen = haystack.length;
  const nLen = needle.length;
  const needleLower = needle.toLowerCase();
  let found = -1;
  outer: for (let i = 0; i + nLen <= hLen; i++) {
    for (let j = 0; j < nLen; j++) {
      let hc = haystack.charCodeAt(i + j);
      if (hc >= 65 && hc <= 90) hc += 32; // ASCII upper -> lower
      if (hc !== needleLower.charCodeAt(j)) continue outer;
    }
    found = i;
  }
  return found;
}

/** Splice the escaped inspect JS into `html`, before the last `</body>`/`</html>`, else append. */
function injectPickerScript(html, inspectJsSource) {
  const safeJs = escapeScriptClose(inspectJsSource);
  const scriptTag = `<script>${safeJs}</script>`;

  let insertAt = findLastCi(html, '</body>');
  if (insertAt === -1) insertAt = findLastCi(html, '</html>');

  if (insertAt === -1) return html + scriptTag;
  return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
}

// ─── HTTP request handling ─────────────────────────────────────────────────

function sendPlain(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

const RESPONSE_SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // See module doc header: deliberately no X-Frame-Options — the legitimate
  // embedder is cross-origin from this loopback server by design.
  'Content-Security-Policy': 'sandbox allow-scripts allow-same-origin allow-forms allow-popups',
};

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function requestListener(req, res) {
  const port = serverState.port;

  // 1. Host guard (anti-DNS-rebinding) — runs BEFORE the method guard, per
  // the actual axum layer order (see module doc header).
  const host = req.headers.host;
  if (host !== undefined && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    sendPlain(res, 421, 'bad host');
    return;
  }

  // 2. Origin guard, if present.
  const origin = req.headers.origin;
  if (
    origin !== undefined &&
    origin !== 'null' &&
    origin !== `http://127.0.0.1:${port}` &&
    origin !== `http://localhost:${port}`
  ) {
    sendPlain(res, 403, 'bad origin');
    return;
  }

  // 3. Method guard — GET/HEAD only.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendPlain(res, 405, 'method not allowed');
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${port}`);
  } catch {
    sendPlain(res, 400, 'bad request');
    return;
  }

  if (url.pathname === '/healthz') {
    sendPlain(res, 200, 'ok');
    return;
  }

  // `*rel_path` wildcard equivalent: everything after `/files/:token/:rootId/`.
  const match = /^\/files\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) {
    sendPlain(res, 404, 'not found');
    return;
  }
  const [, token, rootId, relPathRaw] = match;

  // 4. Token check — constant-time.
  if (!serverState || !verifyToken(serverState.token, token)) {
    sendPlain(res, 401, 'unauthorized');
    return;
  }

  // 5. Root lookup (+ LRU bump).
  const rootPath = lookupRoot(rootId);
  if (rootPath === null) {
    sendPlain(res, 404, 'not found');
    return;
  }

  // 6. Decode + canonicalize under root.
  let target;
  try {
    target = resolvePath(rootPath, relPathRaw);
  } catch {
    sendPlain(res, 400, 'bad request');
    return;
  }

  // 7. Blocklist on the canonical path.
  if (isBlocked(target, rootPath)) {
    sendPlain(res, 403, 'forbidden');
    return;
  }

  // 8. Stat — refuse directories, preview is file-only.
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    sendPlain(res, 404, 'not found');
    return;
  }
  if (!stat.isFile()) {
    sendPlain(res, 404, 'not found');
    return;
  }

  // 9. Content-Type.
  const ext = path.extname(target).slice(1).toLowerCase();
  let mime = EXT_MIME[ext] || DEFAULT_MIME;
  if (mime.startsWith('text/') && !mime.includes('charset')) {
    mime += '; charset=utf-8';
  }

  const extIsHtml = ext === 'html' || ext === 'htm';
  const shouldInject = extIsHtml && inspectJs !== null && stat.size <= MAX_HTML_INJECT_BYTES;

  if (shouldInject) {
    let bytes;
    try {
      bytes = fs.readFileSync(target);
    } catch {
      sendPlain(res, 404, 'not found');
      return;
    }
    const injected = injectPickerScript(bytes.toString('utf8'), inspectJs);
    const body = Buffer.from(injected, 'utf8');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length,
      ...RESPONSE_SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
    return;
  }

  // Streaming path for every other file type (and oversized HTML).
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    ...RESPONSE_SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(target);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* best-effort */
    }
  });
  stream.pipe(res);
}

// ─── Command dispatch ──────────────────────────────────────────────────────

/**
 * @param {import('electron').App} app unused — kept for signature parity
 *   with fsHost.cjs/desktopHost.cjs's dispatch(app, cmd, payload) convention.
 * @param {string} cmd
 * @param {{ args?: Record<string, unknown> }} payload
 */
async function previewDispatch(app, cmd, payload) {
  void app;
  const a = (payload && payload.args) || {};

  switch (cmd) {
    case 'get_preview_server_info': {
      const state = await startServer();
      return { port: state.port, token: state.token };
    }
    case 'register_preview_root': {
      await startServer();
      const rawPath = String(a.path ?? '');
      try {
        return registerRoot(rawPath);
      } catch (err) {
        throw new Error(
          `register_preview_root failed for ${rawPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    case 'unregister_preview_root': {
      // Tauri's default command-arg case convention is camelCase on the JS
      // side for a snake_case Rust param (`root_id` -> `rootId`); accept both
      // since the frontend doesn't call this command today (task brief) and
      // there's no live call site to confirm which one a future caller uses.
      const rootId = String(a.rootId ?? a.root_id ?? '');
      return unregisterRoot(rootId);
    }
    default:
      return PREVIEW_MISS;
  }
}

module.exports = {
  previewDispatch,
  PREVIEW_MISS,
  // Exported for the headless verify harness (electron/spike/f13Verify.cjs).
  startServer,
  registerRoot,
  unregisterRoot,
};
