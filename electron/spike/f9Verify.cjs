/**
 * F9 "trigger server" headless verification — boots a real (hidden) Electron
 * window with the PRODUCTION preload + registerTauriHost, drives
 * `start_trigger_server` / `get_trigger_server_port` from the RENDERER via
 * `window.__TAURI_INTERNALS__.invoke` (the exact path the frontend uses —
 * triggerEngine.ts / pluginHeartbeatUtils.ts), hits the real bound loopback
 * HTTP server with `node:http` client requests from the MAIN side, and
 * asserts the renderer's REAL `@tauri-apps/api/event.js` `listen()` callback
 * receives the emitted event with the exact payload shape triggerEngine.ts
 * expects. Modeled on electron/spike/f2Verify.cjs (invoke-from-renderer
 * pattern) and electron/spike/f4Verify.cjs (real @tauri-apps/api import via a
 * CSP-free scratch HTML page, since the production renderer/index.html's
 * `default-src 'none'` CSP blocks dynamic import()).
 *
 * Checks (see task brief):
 *  1. start_trigger_server returns a port number; idempotent 2nd call returns
 *     the same port (deliberate deviation from the Rust's throw-on-2nd-call —
 *     see triggerServer.cjs's module doc header).
 *  2. get_trigger_server_port returns the same number.
 *  3. GET /health -> 200 {status:"ok"}.
 *  4. POST /trigger/{id} -> 200 {success:true}, AND the renderer's real
 *     listen('trigger-http-event', ...) callback fires with
 *     `event.payload = { triggerId, payload }`.
 *  5. POST /trigger/<invalid chars> -> 400.
 *  6. POST /im/{platform}/webhook -> 200, real listen('im-inbound-event', ...)
 *     fires with `{ platform, payload }`.
 *  7. Feishu/Slack URL-verification challenges are echoed, not forwarded.
 *  8. POST /{platform} short alias -> 200.
 *  9. Unknown path -> 404.
 *
 * Run: npx electron electron/spike/f9Verify.cjs
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { registerTauriHost } = require('../tauriHost.cjs');

app.on('window-all-closed', () => app.quit());

/** @type {{name: string, pass: boolean, detail?: unknown}[]} */
const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raw node:http request against the bound trigger server. */
function httpRequest({ port, method = 'GET', pathAndQuery, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathAndQuery,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

async function main() {
  registerTauriHost(app);
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // NOT electron/renderer/index.html — its CSP (`default-src 'none'`) blocks
  // dynamic import() (needed to exercise the REAL @tauri-apps/api event.js
  // `listen()`, not a hand-rolled stand-in). A same-directory `file://` page
  // with no CSP does not have this problem (same technique as f4Verify.cjs).
  const scratchHtml = path.join(__dirname, '__f9verify-scratch.html');
  fs.writeFileSync(scratchHtml, '<!doctype html><title>f9-verify</title>');
  await win.loadFile(scratchHtml);

  const invokeIn = async (cmd, args) =>
    win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`
    );

  const eventUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'node_modules', '@tauri-apps', 'api', 'event.js')
  ).href;

  // ── Set up: import the REAL event.js, register real listen() callbacks
  // for both events BEFORE starting the server, so no delivery race. ──
  try {
    await win.webContents.executeJavaScript(`(async () => {
      window.__f9TriggerEvents = [];
      window.__f9ImEvents = [];
      const mod = await import(${JSON.stringify(eventUrl)});
      window.__f9UnlistenTrigger = await mod.listen('trigger-http-event', (e) => window.__f9TriggerEvents.push(e.payload));
      window.__f9UnlistenIm = await mod.listen('im-inbound-event', (e) => window.__f9ImEvents.push(e.payload));
      return true;
    })()`);
    record('setup: real listen() registered for both events', true);
  } catch (err) {
    record('setup: real listen() registered for both events', false, String(err));
  }

  // ── 1. start_trigger_server ──
  let port;
  try {
    // port:0 -> OS-assigned, avoids clashing with a real dev-mode instance
    // that may already be bound to DEFAULT_PORT (18080).
    port = await invokeIn('start_trigger_server', { port: 0, bindAddr: '127.0.0.1' });
    record('1a start_trigger_server returns a port number', typeof port === 'number' && port > 0, port);
  } catch (err) {
    record('1a start_trigger_server returns a port number', false, String(err));
  }

  try {
    const port2 = await invokeIn('start_trigger_server', { port: 0, bindAddr: '127.0.0.1' });
    record('1b start_trigger_server idempotent (2nd call -> same port)', port2 === port, port2);
  } catch (err) {
    record('1b start_trigger_server idempotent (2nd call -> same port)', false, String(err));
  }

  // ── 2. get_trigger_server_port ──
  try {
    const gotPort = await invokeIn('get_trigger_server_port');
    record('2 get_trigger_server_port matches start_trigger_server', gotPort === port, gotPort);
  } catch (err) {
    record('2 get_trigger_server_port matches start_trigger_server', false, String(err));
  }

  // ── 3. GET /health ──
  try {
    const res = await httpRequest({ port, pathAndQuery: '/health' });
    const body = safeJsonParse(res.body);
    record('3 GET /health -> 200 {status:ok}', res.status === 200 && body && body.status === 'ok', res);
  } catch (err) {
    record('3 GET /health -> 200 {status:ok}', false, String(err));
  }

  // ── 4. POST /trigger/{id} -> 200 + real event delivery ──
  try {
    const res = await httpRequest({
      port,
      method: 'POST',
      pathAndQuery: '/trigger/abc123',
      body: { hello: 'world' },
    });
    const body = safeJsonParse(res.body);
    record('4a POST /trigger/abc123 -> 200 {success:true}', res.status === 200 && body && body.success === true, res);
  } catch (err) {
    record('4a POST /trigger/abc123 -> 200 {success:true}', false, String(err));
  }

  await wait(300); // event bridge round-trip: main -> ipcRenderer -> preload -> real listen() callback

  try {
    const events = await win.webContents.executeJavaScript('window.__f9TriggerEvents');
    const ok =
      Array.isArray(events) &&
      events.length === 1 &&
      events[0].triggerId === 'abc123' &&
      events[0].payload &&
      events[0].payload.hello === 'world';
    record(
      '4b trigger-http-event delivered to real listen() with {triggerId, payload}',
      ok,
      JSON.stringify(events)
    );
  } catch (err) {
    record('4b trigger-http-event delivered to real listen() with {triggerId, payload}', false, String(err));
  }

  // ── 5. Invalid trigger id -> 400 ──
  try {
    const res = await httpRequest({ port, method: 'POST', pathAndQuery: '/trigger/bad!id', body: {} });
    record('5 POST /trigger/<invalid chars> -> 400', res.status === 400, res);
  } catch (err) {
    record('5 POST /trigger/<invalid chars> -> 400', false, String(err));
  }

  // ── 6. POST /im/{platform}/webhook -> 200 + real event delivery ──
  try {
    const res = await httpRequest({
      port,
      method: 'POST',
      pathAndQuery: '/im/dchat/webhook',
      body: { msg: 'hi' },
    });
    const body = safeJsonParse(res.body);
    record('6a POST /im/dchat/webhook -> 200 {success:true}', res.status === 200 && body && body.success === true, res);
  } catch (err) {
    record('6a POST /im/dchat/webhook -> 200 {success:true}', false, String(err));
  }

  await wait(300);

  try {
    const events = await win.webContents.executeJavaScript('window.__f9ImEvents');
    const ok =
      Array.isArray(events) &&
      events.some((e) => e.platform === 'dchat' && e.payload && e.payload.msg === 'hi');
    record('6b im-inbound-event delivered to real listen() with {platform, payload}', ok, JSON.stringify(events));
  } catch (err) {
    record('6b im-inbound-event delivered to real listen() with {platform, payload}', false, String(err));
  }

  // ── 7. Feishu / Slack URL-verification challenges are echoed, not forwarded ──
  try {
    const res = await httpRequest({
      port,
      method: 'POST',
      pathAndQuery: '/im/feishu/webhook',
      body: { challenge: 'feishu-chal-123' },
    });
    const body = safeJsonParse(res.body);
    record('7a Feishu challenge echoed verbatim', res.status === 200 && body && body.challenge === 'feishu-chal-123', res);
  } catch (err) {
    record('7a Feishu challenge echoed verbatim', false, String(err));
  }

  try {
    const res = await httpRequest({
      port,
      method: 'POST',
      pathAndQuery: '/im/slack/webhook',
      body: { type: 'url_verification', challenge: 'slack-chal-456' },
    });
    const body = safeJsonParse(res.body);
    record('7b Slack challenge echoed verbatim', res.status === 200 && body && body.challenge === 'slack-chal-456', res);
  } catch (err) {
    record('7b Slack challenge echoed verbatim', false, String(err));
  }

  try {
    const events = await win.webContents.executeJavaScript('window.__f9ImEvents');
    const noChallengeLeaked = !events.some((e) => e.platform === 'feishu' || e.platform === 'slack');
    record('7c challenge requests never forwarded as im-inbound-event', noChallengeLeaked, JSON.stringify(events));
  } catch (err) {
    record('7c challenge requests never forwarded as im-inbound-event', false, String(err));
  }

  // ── 8. POST /{platform} short alias -> 200 ──
  try {
    const res = await httpRequest({ port, method: 'POST', pathAndQuery: '/wecom', body: { a: 1 } });
    record('8 POST short alias /wecom -> 200', res.status === 200, res);
  } catch (err) {
    record('8 POST short alias /wecom -> 200', false, String(err));
  }

  // ── 9. Unknown path -> 404 ──
  try {
    const res = await httpRequest({ port, pathAndQuery: '/nope' });
    record('9 GET /nope -> 404', res.status === 404, res);
  } catch (err) {
    record('9 GET /nope -> 404', false, String(err));
  }

  const passed = checks.every((c) => c.pass);
  for (const c of checks) {
    console.log(`[f9-verify] ${c.pass ? 'PASS' : 'FAIL'} - ${c.name}${c.detail !== undefined ? ' (' + JSON.stringify(c.detail) + ')' : ''}`);
  }
  console.log(`[f9-verify] PASSED=${passed}`);

  fs.rmSync(scratchHtml, { force: true });
  app.exit(passed ? 0 : 1);
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('[f9-verify] uncaught error:', err);
    console.log('[f9-verify] PASSED=false');
    app.exit(1);
  });
});
