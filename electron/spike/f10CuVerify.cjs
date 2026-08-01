/**
 * F10 Computer Use proof — spawns the release native-helper (plain `node`, run
 * from a real terminal so the unsigned dev binary inherits Terminal's
 * Accessibility/Screen-Recording TCC grants — same rationale as
 * f10HelperLoop.cjs / f10AxVerify.cjs / f10TccProbe) and drives the Computer
 * Use RPC family end to end over stdio NDJSON:
 *
 *   check_macos_permissions → mouse_move (query, no-op) → mouse_click (at the
 *   queried CURRENT cursor position — non-disruptive) → keyboard_type ("")
 *   → capture_screen → capture_screen_excluding
 *
 * This proves the `include!` re-hosting of src-tauri's Tauri-free
 * computer_use_impl.rs into electron/native-helper/src/cu.rs actually works at
 * runtime: enigo input-synth fires, xcap/CoreGraphics capture returns a real
 * base64 PNG in the exact ScreenshotResult shape the frontend
 * (computerTools.ts) expects, and the macOS TCC FFI (CGPreflightScreenCapture-
 * Access / AXIsProcessTrusted) returns real booleans.
 *
 * CAUTION: mouse_click performs one real click at wherever the cursor
 * currently sits (queried via mouse_move first, so it does not jump the
 * cursor elsewhere) — see the CU report's "Risks" section. keyboard_type is
 * called with an empty string (0 keystrokes) so it cannot type into whatever
 * window has focus.
 *
 * Run: node electron/spike/f10CuVerify.cjs
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'native-helper', 'target', 'release', 'native-helper');

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
        console.log('[f10-cu] non-JSON line from helper:', line);
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
    console.log('[f10-cu] spawn ERROR', String(e));
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
    try {
      // ── check_macos_permissions — assert both booleans are actual booleans ──
      const perms = await rpc('check_macos_permissions', {});
      console.log('[f10-cu] check_macos_permissions →', JSON.stringify(perms.result || perms.error));
      const permsOk =
        !!perms.result &&
        typeof perms.result.screen_recording === 'boolean' &&
        typeof perms.result.accessibility === 'boolean';

      // ── mouse_move (no params) — query current cursor position, no-op move ──
      const query = await rpc('mouse_move', {});
      console.log('[f10-cu] mouse_move(query) →', JSON.stringify(query.result || query.error));
      const [cx, cy] = (query.result && query.result.was_at) || [0, 0];
      const queryOk = Array.isArray(query.result && query.result.was_at);

      // ── mouse_click at the CURRENT cursor position — non-disruptive ──
      const click = await rpc('mouse_click', { x: cx, y: cy, button: 'left' });
      console.log('[f10-cu] mouse_click(%d, %d) →', cx, cy, JSON.stringify(click.result || click.error));
      const clickOk = typeof click.result === 'string' && click.result.length > 0;

      // ── keyboard_type("") — 0 keystrokes, cannot type into the focused app ──
      const type_ = await rpc('keyboard_type', { text: '' });
      console.log('[f10-cu] keyboard_type("") →', JSON.stringify(type_.result || type_.error));
      const typeOk = typeof type_.result === 'string' && type_.result.length > 0;

      // ── capture_screen — assert width/height/base64 present ──
      const cap = await rpc('capture_screen', {});
      const capMeta = cap.result
        ? { width: cap.result.width, height: cap.result.height, scale_factor: cap.result.scale_factor, base64_len: (cap.result.base64 || '').length }
        : cap.error;
      console.log('[f10-cu] capture_screen →', JSON.stringify(capMeta));
      const captureOk =
        !!cap.result &&
        typeof cap.result.width === 'number' &&
        cap.result.width > 0 &&
        typeof cap.result.height === 'number' &&
        cap.result.height > 0 &&
        typeof cap.result.base64 === 'string' &&
        cap.result.base64.length > 0;

      // ── capture_screen_excluding {exclude_window_id: 0} — assert an image comes back ──
      const capEx = await rpc('capture_screen_excluding', { exclude_window_id: 0 });
      const capExMeta = capEx.result
        ? { width: capEx.result.width, height: capEx.result.height, base64_len: (capEx.result.base64 || '').length }
        : capEx.error;
      console.log('[f10-cu] capture_screen_excluding(exclude_window_id=0) →', JSON.stringify(capExMeta));
      const captureExOk =
        !!capEx.result &&
        typeof capEx.result.width === 'number' &&
        capEx.result.width > 0 &&
        typeof capEx.result.base64 === 'string' &&
        capEx.result.base64.length > 0;

      passed = permsOk && queryOk && clickOk && typeOk && captureOk && captureExOk;
      console.log(
        '[f10-cu] permsOk=%s queryOk=%s clickOk=%s typeOk=%s captureOk=%s captureExOk=%s',
        permsOk,
        queryOk,
        clickOk,
        typeOk,
        captureOk,
        captureExOk
      );
    } catch (e) {
      console.log('[f10-cu] ERROR', String(e));
    } finally {
      if (stderr.trim()) console.log('[f10-cu] helper stderr:', stderr.trim());
      console.log('[f10-cu] PASSED=' + passed);
      child.stdin.end();
      child.kill();
      process.exit(passed ? 0 : 1);
    }
  })();
}

main();
