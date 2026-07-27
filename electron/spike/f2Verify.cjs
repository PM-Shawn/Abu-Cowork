/**
 * F2 "desktop misc" headless verification — boots a real (hidden) Electron
 * window with the PRODUCTION preload + registerTauriHost, then from the
 * RENDERER calls the auto-verifiable desktopHost.cjs commands via
 * window.__TAURI_INTERNALS__.invoke (the exact path the frontend uses), and
 * asserts on the results. Modeled on electron/spike/f1aE2E.cjs.
 *
 * Covers (headless, no GUI/user action required):
 *  - get_local_ip            → IP-shaped string or null
 *  - set_prevent_sleep       → toggles on/off without throwing
 *  - plugin:clipboard-manager|write_text + |read_text → round-trip
 *  - check_fullscreen        → returns {is_fullscreen: boolean, app_name}
 *  - move_to_trash           → a temp file actually leaves its original path
 *  - read_clipboard_file_paths (best-effort, macOS only — see desktopHost.cjs)
 *
 * NOT covered here (attended/GUI — dialogs, opener, notification, process
 * relaunch, deep-link): see the orchestrator report for why.
 *
 * Run: npx electron electron/spike/f2Verify.cjs   (self-exits, prints JSON)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { registerTauriHost } = require('../tauriHost.cjs');
const { registerPrivilegedWindow } = require('../securityBoundary.cjs');

app.on('window-all-closed', () => app.quit());

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
  const page = path.join(__dirname, '..', 'renderer', 'index.html');
  registerPrivilegedWindow(win, page, { label: 'verify-f2' });
  await win.loadFile(page);

  const invokeIn = async (cmd, args) =>
    win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`
    );

  // ── get_local_ip ──────────────────────────────────────────────────────
  try {
    const ip = await invokeIn('get_local_ip');
    const ipShaped = ip === null || /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
    record('get_local_ip', ipShaped, ip);
  } catch (err) {
    record('get_local_ip', false, String(err));
  }

  // ── set_prevent_sleep (toggle on then off, no throw) ──────────────────
  try {
    await invokeIn('set_prevent_sleep', { enabled: true });
    await invokeIn('set_prevent_sleep', { enabled: true }); // idempotent re-enable
    await invokeIn('set_prevent_sleep', { enabled: false });
    await invokeIn('set_prevent_sleep', { enabled: false }); // idempotent re-disable
    record('set_prevent_sleep', true);
  } catch (err) {
    record('set_prevent_sleep', false, String(err));
  }

  // ── clipboard text round-trip ──────────────────────────────────────────
  try {
    const marker = `f2-verify-${Date.now()}`;
    await invokeIn('plugin:clipboard-manager|write_text', { text: marker });
    const readBack = await invokeIn('plugin:clipboard-manager|read_text');
    record('clipboard_text_roundtrip', readBack === marker, readBack);
  } catch (err) {
    record('clipboard_text_roundtrip', false, String(err));
  }

  // ── check_fullscreen shape ─────────────────────────────────────────────
  try {
    const info = await invokeIn('check_fullscreen');
    const shaped =
      info && typeof info === 'object' && typeof info.is_fullscreen === 'boolean' && 'app_name' in info;
    record('check_fullscreen', shaped, info);
  } catch (err) {
    record('check_fullscreen', false, String(err));
  }

  // ── move_to_trash ───────────────────────────────────────────────────────
  try {
    const dir = fs.mkdtempSync(path.join(os.homedir(), '.f2-verify-'));
    const target = path.join(dir, 'trash-me.txt');
    fs.writeFileSync(target, 'bye');
    await invokeIn('move_to_trash', { path: target });
    const gone = !fs.existsSync(target);
    record('move_to_trash', gone, { target, gone });
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    record('move_to_trash', false, String(err));
  }

  // ── read_clipboard_file_paths (best-effort; macOS only, single-file) ───
  try {
    if (process.platform === 'darwin') {
      const dir = fs.mkdtempSync(path.join(os.homedir(), '.f2-verify-clip-'));
      const target = path.join(dir, 'clip-file.txt');
      fs.writeFileSync(target, 'clip');
      // Put a real file reference on the pasteboard the way Finder's Cmd+C
      // does, via AppleScript — this is the only headless way to populate
      // NSPasteboardTypeFileURL without an actual Finder click.
      execFileSync('osascript', ['-e', `set the clipboard to (POSIX file "${target}")`]);
      const paths = await invokeIn('read_clipboard_file_paths');
      const ok = Array.isArray(paths) && paths.length === 1 && paths[0] === target;
      record('read_clipboard_file_paths', ok, paths);
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      const paths = await invokeIn('read_clipboard_file_paths');
      record('read_clipboard_file_paths', Array.isArray(paths) && paths.length === 0, paths);
    }
  } catch (err) {
    record('read_clipboard_file_paths', false, String(err));
  }

  const passed = checks.every((c) => c.pass);
  for (const c of checks) {
    console.log(`[f2-verify] ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail !== undefined ? ' ' + JSON.stringify(c.detail) : ''}`);
  }
  console.log(`[f2-verify] PASSED = ${passed}`);
  app.exit(passed ? 0 : 1);
});
