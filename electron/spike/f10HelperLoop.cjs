/**
 * F10 minimal-loop proof — Electron main spawns the native-helper and drives it
 * over NDJSON JSON-RPC (line-framed stdio, the same shape mcpBridge uses),
 * exactly how production would launch it. Sends ping → capture_screen →
 * mouse_move(no-op) and reports the results, proving the full chain:
 *   Electron main → spawn(native-helper) → stdio RPC → enigo/xcap → result back.
 *
 * Run: npx electron electron/spike/f10HelperLoop.cjs
 */
'use strict';
const { app } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'native-helper', 'target', 'release', 'native-helper');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) {
        pending.delete(msg.id);
        r(msg);
      }
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });

  try {
    const ping = await rpc('ping', {});
    const cap = await rpc('capture_screen', { out: '/tmp/nh-electron-cap.png' });
    const move = await rpc('mouse_move', {}); // no-op to current position
    console.log('[f10-loop] ping →', JSON.stringify(ping.result || ping.error));
    console.log('[f10-loop] capture →', JSON.stringify(cap.result || cap.error));
    console.log('[f10-loop] mouse_move →', JSON.stringify(move.result || move.error));
    const passed = !!(ping.result && cap.result && cap.result.width > 0 && move.result);
    console.log('[f10-loop] PASSED =', passed, stderr ? '| stderr=' + stderr.trim() : '');
    child.stdin.end();
    child.kill();
    app.exit(passed ? 0 : 1);
  } catch (e) {
    console.log('[f10-loop] ERROR', String(e), '| stderr=' + stderr.trim());
    child.kill();
    app.exit(1);
  }
});
