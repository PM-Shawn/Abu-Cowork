/**
 * F13 "preview server" headless verification — plain Node script (no
 * Electron needed: previewServer.cjs only touches `node:http`/`node:fs`/
 * `node:crypto`, never an Electron API), driving `previewDispatch()` exactly
 * as tauriHost.cjs's ipcMain handler would, then hitting the real bound
 * loopback server with `node:http` client requests.
 *
 * Checks (see task brief):
 *  1. get_preview_server_info -> {port, token}; register_preview_root on a
 *     temp dir with index.html (relative ./app.js ref) + app.js + sub/x.txt.
 *  2. GET index.html -> 200, correct Content-Type, nosniff + CSP present,
 *     and (inspect script found) the picker JS spliced into the body.
 *  3. GET ./app.js and sub/x.txt via their resolved URLs -> 200 + content.
 *  4. Security: wrong token -> 401; `../` traversal (raw + percent-encoded)
 *     -> blocked (400); bad Host header -> 421; POST -> 405.
 *
 * Run: node electron/spike/f13Verify.cjs
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { previewDispatch } = require('../previewServer.cjs');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail ?? '' });
}

function request({ port, method = 'GET', pathAndQuery, host, origin }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host !== undefined) headers.Host = host;
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathAndQuery,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-f13-verify-'));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><body><h1>hi</h1><script src="./app.js"></script></body></html>'
  );
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("app.js loaded");');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), 'nested file content');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=leak-me-not');

  // ── 1. get_preview_server_info + register_preview_root ──
  const info = await previewDispatch(null, 'get_preview_server_info', {});
  check(
    '1a get_preview_server_info shape',
    typeof info.port === 'number' && info.port > 0 && typeof info.token === 'string' && info.token.length === 32,
    JSON.stringify(info)
  );

  const rootId = await previewDispatch(null, 'register_preview_root', { args: { path: dir } });
  check('1b register_preview_root returns string id', typeof rootId === 'string' && rootId.length > 0, rootId);

  const rootId2 = await previewDispatch(null, 'register_preview_root', { args: { path: dir } });
  check('1c register_preview_root idempotent (same dir -> same id)', rootId2 === rootId, `${rootId} vs ${rootId2}`);

  const { port, token } = info;
  const base = `/files/${token}/${rootId}`;

  // ── 2. GET index.html ──
  const idxRes = await request({ port, pathAndQuery: `${base}/index.html` });
  check('2a index.html status 200', idxRes.status === 200, String(idxRes.status));
  check(
    '2b index.html Content-Type text/html; charset=utf-8',
    idxRes.headers['content-type'] === 'text/html; charset=utf-8',
    idxRes.headers['content-type']
  );
  check('2c nosniff header present', idxRes.headers['x-content-type-options'] === 'nosniff', idxRes.headers['x-content-type-options']);
  check(
    '2d CSP sandbox header present',
    typeof idxRes.headers['content-security-policy'] === 'string' &&
      idxRes.headers['content-security-policy'].includes('sandbox'),
    idxRes.headers['content-security-policy']
  );
  const inspectJsPath = path.join(__dirname, '..', '..', 'src-tauri', 'inspect', 'abu-preview-inspect.js');
  const inspectAvailable = fs.existsSync(inspectJsPath);
  if (inspectAvailable) {
    check(
      '2e inspect picker script injected before </body>',
      idxRes.body.includes('__ABU_PREVIEW_INSPECT__') && idxRes.body.indexOf('<script>') < idxRes.body.lastIndexOf('</body>'),
      `inspectAvailable=${inspectAvailable} bodyLen=${idxRes.body.length}`
    );
  } else {
    check('2e inspect script file missing -> injection skipped gracefully (no crash)', idxRes.status === 200, 'inspect js not found on disk');
  }

  // ── 3. GET ./app.js and sub/x.txt ──
  const appJsRes = await request({ port, pathAndQuery: `${base}/app.js` });
  check('3a app.js status 200', appJsRes.status === 200, String(appJsRes.status));
  check('3b app.js content correct', appJsRes.body === 'console.log("app.js loaded");', appJsRes.body);
  check(
    '3c app.js Content-Type text/javascript; charset=utf-8',
    appJsRes.headers['content-type'] === 'text/javascript; charset=utf-8',
    appJsRes.headers['content-type']
  );

  const subRes = await request({ port, pathAndQuery: `${base}/sub/x.txt` });
  check('3d sub/x.txt status 200', subRes.status === 200, String(subRes.status));
  check('3e sub/x.txt content correct', subRes.body === 'nested file content', subRes.body);

  // ── 4. Security asserts ──
  const wrongTokenRes = await request({ port, pathAndQuery: `/files/${'0'.repeat(32)}/${rootId}/index.html` });
  check('4a wrong token -> 401', wrongTokenRes.status === 401, String(wrongTokenRes.status));

  const wrongTokenLenRes = await request({ port, pathAndQuery: `/files/short/${rootId}/index.html` });
  check('4b wrong-length token -> 401 (no crash on length mismatch)', wrongTokenLenRes.status === 401, String(wrongTokenLenRes.status));

  const traversalRaw = await request({ port, pathAndQuery: `${base}/../../../../etc/passwd` });
  check('4c raw ../ traversal blocked (not 200)', traversalRaw.status !== 200, String(traversalRaw.status));

  const traversalEncoded = await request({ port, pathAndQuery: `${base}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd` });
  check('4d percent-encoded ../ traversal blocked (not 200)', traversalEncoded.status !== 200, String(traversalEncoded.status));

  // Node's own URL parser already collapses literal/percent-encoded ".."
  // dot-segments before this server ever sees them (verified separately) —
  // so 4c/4d above are actually blocked at routing, before resolvePath()
  // runs. To prove resolvePath()'s OWN segment-decode defense (the
  // embedded-'/' check documented in previewServer.cjs's module header) is
  // live, use a segment URL normalization does NOT touch: "..%2fapp.js" is
  // not a pure dot-segment to the URL parser (trailing chars after the
  // encoded slash), so it survives verbatim into the routed rel_path and
  // must be caught by resolvePath()'s own per-segment decode + reject.
  const embeddedSlashRes = await request({ port, pathAndQuery: `${base}/sub/..%2fapp.js` });
  check(
    '4l resolvePath() catches decoded-embedded-slash segment (not just URL normalization) -> 400',
    embeddedSlashRes.status === 400,
    String(embeddedSlashRes.status)
  );

  const envRes = await request({ port, pathAndQuery: `${base}/.env` });
  check('4e blocklisted .env -> 403', envRes.status === 403, String(envRes.status));

  const badHostRes = await request({ port, pathAndQuery: `${base}/index.html`, host: 'evil.example.com' });
  check('4f bad Host header -> 421', badHostRes.status === 421, String(badHostRes.status));

  const goodHostRes = await request({ port, pathAndQuery: `${base}/index.html`, host: `127.0.0.1:${port}` });
  check('4g correct Host header -> 200 (guard is not overzealous)', goodHostRes.status === 200, String(goodHostRes.status));

  const badOriginRes = await request({ port, pathAndQuery: `${base}/index.html`, origin: 'http://evil.example.com' });
  check('4h bad Origin header -> 403', badOriginRes.status === 403, String(badOriginRes.status));

  const nullOriginRes = await request({ port, pathAndQuery: `${base}/index.html`, origin: 'null' });
  check('4i null Origin -> allowed (200)', nullOriginRes.status === 200, String(nullOriginRes.status));

  const postRes = await request({ port, method: 'POST', pathAndQuery: `${base}/index.html` });
  check('4j POST -> 405', postRes.status === 405, String(postRes.status));

  const healthzRes = await request({ port, pathAndQuery: '/healthz' });
  check('4k /healthz -> 200 ok', healthzRes.status === 200 && healthzRes.body === 'ok', `${healthzRes.status} ${healthzRes.body}`);

  // ── unregister_preview_root ──
  const unregResult = await previewDispatch(null, 'unregister_preview_root', { args: { rootId } });
  check('5a unregister_preview_root -> true when present', unregResult === true, String(unregResult));
  const afterUnregRes = await request({ port, pathAndQuery: `${base}/index.html` });
  check('5b after unregister -> 404', afterUnregRes.status === 404, String(afterUnregRes.status));
  const unregAgain = await previewDispatch(null, 'unregister_preview_root', { args: { rootId } });
  check('5c unregister again -> false (already gone), no crash', unregAgain === false, String(unregAgain));

  // ── Print results ──
  let allPass = true;
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log(`[f13-verify] ${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  }
  console.log(`[f13-verify] PASSED = ${allPass}`);

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('[f13-verify] uncaught error:', err);
  console.log('[f13-verify] PASSED = false');
  process.exit(1);
});
