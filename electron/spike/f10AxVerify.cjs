/**
 * F10 AX-family proof — spawns the release native-helper (plain `node`, run
 * from a real terminal so the unsigned dev binary inherits Terminal's
 * Accessibility TCC grant — same rationale as f10HelperLoop.cjs / f10TccProbe)
 * and drives the AX RPC family end to end over stdio NDJSON:
 *
 *   activate_app → ax_snapshot → ax_press (session-lookup only) → ax_close_session
 *
 * This proves the include!/#[path] re-hosting in electron/native-helper/src/ax.rs
 * actually works at runtime (SESSION_CACHE lives in the helper process, element
 * refs stay valid across RPC calls, serde_json round-trips AxSnapshotResult).
 *
 * Run: node electron/spike/f10AxVerify.cjs [appName]
 *   appName defaults to "Finder" (always running); pass e.g. "Terminal" /
 *   "iTerm2" to target the terminal app that is launching this script instead.
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'native-helper', 'target', 'release', 'native-helper');
const TARGET_APP = process.argv[2] || 'Finder';

function main() {
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
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        console.log('[f10-ax] non-JSON line from helper:', line);
        continue;
      }
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
  child.on('error', (e) => {
    console.log('[f10-ax] spawn ERROR', String(e));
    process.exit(1);
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC '${method}' timed out after 15s`));
      }, 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });

  (async () => {
    let passed = false;
    let sessionId = null;
    try {
      const activate = await rpc('activate_app', { name: TARGET_APP });
      console.log('[f10-ax] activate_app →', JSON.stringify(activate.result || activate.error));

      const snap = await rpc('ax_snapshot', { app: TARGET_APP });
      if (snap.error) throw new Error(`ax_snapshot errored: ${snap.error}`);
      const { session_id, app, total_visited, truncated, elements } = snap.result || {};
      console.log(
        '[f10-ax] ax_snapshot → session_id=%s app=%s total_visited=%s truncated=%s element_count=%s',
        session_id,
        app,
        total_visited,
        truncated,
        Array.isArray(elements) ? elements.length : 'n/a'
      );
      if (Array.isArray(elements) && elements.length > 0) {
        console.log(
          '[f10-ax] sample elements:',
          JSON.stringify(elements.slice(0, 5).map((e) => ({ id: e.id, role: e.role, label: e.label, actions: e.actions })))
        );
      }

      const snapshotOk = typeof session_id === 'string' && session_id.length > 0 && Array.isArray(elements) && elements.length > 0;
      sessionId = session_id;

      let pressOk = false;
      if (sessionId) {
        const press = await rpc('ax_press', { session_id: sessionId, element_id: 0 });
        console.log('[f10-ax] ax_press(element_id=0) →', JSON.stringify(press.result || press.error));
        // We only assert the session was found and dispatched — NOT that the
        // press succeeded (element 0 may legitimately not support AXPress,
        // e.g. a container row), just that we didn't hit the wiring bug this
        // harness exists to catch: "Session '...' not found".
        const sessionNotFound = typeof press.error === 'string' && press.error.includes('not found');
        pressOk = !sessionNotFound;
      }

      let closeOk = false;
      if (sessionId) {
        const close = await rpc('ax_close_session', { session_id: sessionId });
        console.log('[f10-ax] ax_close_session →', JSON.stringify(close.result || close.error));
        closeOk = !!close.result;
      }

      passed = snapshotOk && pressOk && closeOk;
      console.log('[f10-ax] target_app=%s snapshotOk=%s pressOk=%s closeOk=%s', TARGET_APP, snapshotOk, pressOk, closeOk);
    } catch (e) {
      console.log('[f10-ax] ERROR', String(e));
    } finally {
      if (stderr.trim()) console.log('[f10-ax] helper stderr:', stderr.trim());
      console.log('[f10-ax] PASSED=' + passed);
      child.stdin.end();
      child.kill();
      process.exit(passed ? 0 : 1);
    }
  })();
}

main();
