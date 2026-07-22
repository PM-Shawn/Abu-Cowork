/**
 * F6 "pty family" headless verification — boots a real (hidden) Electron
 * window with the PRODUCTION preload + registerTauriHost, then from the
 * RENDERER drives pty_spawn/pty_write/pty_resize/pty_kill via
 * `window.__TAURI_INTERNALS__.invoke` (the exact path TerminalTab.tsx uses),
 * registering REAL `pty://data/{id}` / `pty://exit/{id}` listeners the same
 * way `@tauri-apps/api/event`'s `listen()` does under the hood
 * (`transformCallback` + `plugin:event|listen`) — modeled on
 * electron/spike/f2Verify.cjs (invokeIn helper) + the event-round-trip block
 * in electron/spike/bootVerify.cjs (transformCallback pattern).
 *
 * Checks:
 *  1. pty_spawn a real shell (tmp cwd, 80x24) resolves without throwing.
 *  2. pty_write('echo abu-f6-marker\n') -> a pty://data/{id} event delivers a
 *     number[] payload (per TerminalTab.tsx:70 `listen<number[]>` +
 *     `new Uint8Array(event.payload)`) whose decoded bytes contain the marker.
 *  3. pty_resize doesn't throw.
 *  4. pty_kill -> a pty://exit/{id} event fires (payload not asserted beyond
 *     "the event fired" — TerminalTab.tsx never reads the payload value).
 *
 * Run: npx electron electron/spike/f6Verify.cjs   (self-exits, prints JSON)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { registerTauriHost } = require('../tauriHost.cjs');

app.on('window-all-closed', () => app.quit());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {{name: string, pass: boolean, detail?: unknown}[]} */
const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
}

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

  const invokeIn = async (cmd, args) =>
    win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`
    );

  /**
   * Register a real `listen(event, cb)`-shaped subscription in the page world
   * (transformCallback + plugin:event|listen, exactly what
   * @tauri-apps/api/event's listen() does), stashing every delivered payload
   * onto a page-global array so this main-side script can poll it.
   */
  async function listenIn(event, stashKey) {
    await win.webContents.executeJavaScript(`
      (async () => {
        globalThis[${JSON.stringify(stashKey)}] = [];
        const id = window.__TAURI_INTERNALS__.transformCallback((e) => {
          globalThis[${JSON.stringify(stashKey)}].push(e.payload);
        });
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
          event: ${JSON.stringify(event)},
          target: { kind: 'Any' },
          handler: id,
        });
        return true;
      })()
    `);
  }

  const readStash = async (stashKey) => win.webContents.executeJavaScript(`globalThis[${JSON.stringify(stashKey)}]`);

  const tabId = `f6-verify-${Date.now()}`;
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-f6-verify-'));

  // ── register listeners BEFORE spawn (matches TerminalTab.tsx's real
  // ordering: listen() is awaited, then pty_spawn is invoked) ──
  await listenIn(`pty://data/${tabId}`, 'abuF6Data');
  await listenIn(`pty://exit/${tabId}`, 'abuF6Exit');

  // ── 1. pty_spawn ──
  try {
    await invokeIn('pty_spawn', { id: tabId, cols: 80, rows: 24, cwd: tmpCwd });
    record('pty_spawn', true);
  } catch (err) {
    record('pty_spawn', false, String(err));
  }

  // ── 2. pty_write + pty://data delivery, number[] shape, marker present ──
  const marker = `abu-f6-marker-${Date.now()}`;
  try {
    await invokeIn('pty_write', { id: tabId, data: `echo ${marker}\n` });

    let combined = Buffer.alloc(0);
    let sawNumberArrayChunk = false;
    let containsMarker = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !containsMarker) {
      await wait(150);
      const chunks = await readStash('abuF6Data');
      for (const chunk of chunks) {
        if (Array.isArray(chunk) && chunk.every((n) => typeof n === 'number')) {
          sawNumberArrayChunk = true;
        }
      }
      const allBytes = chunks.flat();
      combined = Buffer.from(allBytes);
      containsMarker = combined.toString('utf8').includes(marker);
    }
    record('pty_write_and_data_event', sawNumberArrayChunk && containsMarker, {
      sawNumberArrayChunk,
      containsMarker,
      sample: combined.toString('utf8').slice(0, 300),
    });
  } catch (err) {
    record('pty_write_and_data_event', false, String(err));
  }

  // ── 3. pty_resize (no throw) ──
  try {
    await invokeIn('pty_resize', { id: tabId, cols: 100, rows: 30 });
    record('pty_resize', true);
  } catch (err) {
    record('pty_resize', false, String(err));
  }

  // ── 4. pty_kill -> pty://exit fires ──
  try {
    await invokeIn('pty_kill', { id: tabId });
    let exitFired = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !exitFired) {
      await wait(150);
      const exits = await readStash('abuF6Exit');
      exitFired = Array.isArray(exits) && exits.length > 0;
    }
    record('pty_kill_and_exit_event', exitFired, await readStash('abuF6Exit'));
  } catch (err) {
    record('pty_kill_and_exit_event', false, String(err));
  }

  fs.rmSync(tmpCwd, { recursive: true, force: true });

  const passed = checks.every((c) => c.pass);
  for (const c of checks) {
    console.log(`[f6-verify] ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail !== undefined ? ' ' + JSON.stringify(c.detail) : ''}`);
  }
  console.log(`[f6-verify] PASSED=${passed}`);
  app.exit(passed ? 0 : 1);
});
