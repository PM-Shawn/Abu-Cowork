/**
 * F1 main-process heartbeat E2E proof — boots a real Electron window with the
 * PRODUCTION preload + registerTauriHost (exactly like f1aE2E.cjs), then from
 * the RENDERER drives the exact `mcp_spawn`/`mcp_write`/`plugin:event|listen`
 * calls sidecarManager.ts makes, exercising the real electron/mcpBridge.cjs
 * heartbeat monitor added for F1 (see src/core/sidecar/sidecarManager.ts's
 * module JSDoc "F1"). Verifies three things end-to-end that vitest (mocked
 * invoke/listen) cannot:
 *
 *   1. A REAL sidecar child spawned with `heartbeat: true` gets pinged by
 *      main and never has a stray `__mcphb-*` line leak through to
 *      `mcp-msg-{id}` (the interception guard actually works over a real pipe).
 *   2. A healthy child produces no `mcp-hung-{id}` event across a full
 *      heartbeat cycle, and ordinary JSON-RPC traffic (echo) still flows.
 *   3. A child that's alive but silently drops pings (simulating a hung
 *      event loop) DOES trigger exactly one `mcp-hung-{id}` after 3
 *      consecutive misses — while still answering unrelated requests
 *      normally, proving the ping is selectively dropped, not the whole pipe.
 *
 * Run: npx electron electron/spike/f1HeartbeatE2E.cjs   (self-exits, prints JSON)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { registerTauriHost } = require('../tauriHost.cjs');
const { SIDECAR_PATH, resolveSidecarLaunch } = require('../appEnv.cjs');

app.on('window-all-closed', () => app.quit());

// A tiny "hung" child: answers any JSON-RPC line EXCEPT it silently drops
// anything whose method is 'ping' (never responds) — simulating a
// deadlocked-but-alive process for scenario 3, without touching real
// sidecar code.
const HUNG_CHILD_SRC = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'ping') return; // deliberately never ack
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.params }) + '\\n');
});
`;

app.whenReady().then(async () => {
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
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const hungChildPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f1-hb-')), 'hung-child.cjs');
  fs.writeFileSync(hungChildPath, HUNG_CHILD_SRC);

  const sidecarEnv = resolveSidecarLaunch(app).env;

  // Drive the SAME invoke()/transformCallback() plumbing sidecarManager.ts /
  // @tauri-apps/api/event's listen() use, from the renderer context.
  const result = await win.webContents.executeJavaScript(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const transformCallback = window.__TAURI_INTERNALS__.transformCallback;

    function collect(event) {
      const lines = [];
      const handler = transformCallback((e) => lines.push(e.payload), false);
      return invoke('plugin:event|listen', { event, handler }).then(() => lines);
    }
    function once(event) {
      return new Promise((resolve) => {
        const handler = transformCallback((e) => resolve(e.payload), true);
        invoke('plugin:event|listen', { event, handler });
      });
    }

    const report = {};

    // ── Scenario 1+2: real sidecar, healthy — no leak, no false hang ──
    const sc1Msgs = await collect('mcp-msg-hb1');
    const sc1HungPromise = once('mcp-hung-hb1'); // resolves ONLY if a hang event actually fires
    await invoke('mcp_spawn', {
      id: 'hb1',
      command: 'node',
      args: [${JSON.stringify(SIDECAR_PATH)}],
      env: ${JSON.stringify(sidecarEnv)},
      heartbeat: true,
    });

    // Ordinary JSON-RPC traffic still flows.
    let echoResult = null;
    {
      const p = new Promise((resolve) => {
        const check = setInterval(() => {
          const hit = sc1Msgs.find((l) => l.includes('"echo-probe"'));
          if (hit) { clearInterval(check); resolve(hit); }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(null); }, 4000);
      });
      await invoke('mcp_write', { id: 'hb1', message: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { tag: 'echo-probe' } }) });
      echoResult = await p;
    }
    report.echoOk = !!echoResult;

    // Wait past one full heartbeat cycle (10s interval + 5s timeout + margin)
    // without a hang firing, then confirm no leaked heartbeat frames.
    const hangRace = await Promise.race([
      sc1HungPromise.then(() => 'hung'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 16000)),
    ]);
    report.sc1HungFired = hangRace === 'hung';
    report.sc1LeakedHeartbeatLines = sc1Msgs.filter((l) => l.includes('__mcphb-')).length;

    await invoke('mcp_kill', { id: 'hb1' });

    // ── Scenario 3: alive-but-hung child — real detection after 3 misses ──
    const sc2Msgs = await collect('mcp-msg-hb2');
    const sc2Hung = once('mcp-hung-hb2');
    await invoke('mcp_spawn', {
      id: 'hb2',
      command: 'node',
      args: [${JSON.stringify(hungChildPath)}],
      env: {},
      heartbeat: true,
    });

    // Unrelated traffic still answered even though pings are dropped.
    {
      const p = new Promise((resolve) => {
        const check = setInterval(() => {
          const hit = sc2Msgs.find((l) => l.includes('"echo-probe-2"'));
          if (hit) { clearInterval(check); resolve(hit); }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(null); }, 4000);
      });
      await invoke('mcp_write', { id: 'hb2', message: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: { tag: 'echo-probe-2' } }) });
      report.sc2EchoOk = !!(await p);
    }

    // 3 missed pings: interval(10s)+timeout(5s) each ~= up to 35s worst case;
    // give generous headroom.
    const sc2Result = await Promise.race([
      sc2Hung.then(() => 'hung'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 45000)),
    ]);
    report.sc2HungFired = sc2Result === 'hung';
    report.sc2LeakedHeartbeatLines = sc2Msgs.filter((l) => l.includes('__mcphb-')).length;

    await invoke('mcp_kill', { id: 'hb2' });

    return report;
  })()`);

  fs.rmSync(path.dirname(hungChildPath), { recursive: true, force: true });

  const passed =
    result.echoOk === true &&
    result.sc1HungFired === false &&
    result.sc1LeakedHeartbeatLines === 0 &&
    result.sc2EchoOk === true &&
    result.sc2HungFired === true &&
    result.sc2LeakedHeartbeatLines === 0;

  console.log('[f1-heartbeat-e2e] ' + JSON.stringify({ passed, ...result }));
  app.exit(passed ? 0 : 1);
});
