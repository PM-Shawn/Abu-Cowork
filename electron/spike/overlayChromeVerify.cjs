/**
 * L5 W2/W4 — the on-screen Computer Use chrome against real windows:
 *
 *  1. show_screen_border brings up the overlay + stop button and the Host's
 *     heartbeat reaches the overlay page (beats > 0, not stale).
 *  2. Activating the input lease turns the cursor marker on at the real
 *     pointer; a click pulses a ripple; releasing the lease hides the marker
 *     after its short linger.
 *  3. A resolved target window is followed (single display here: same
 *     bounds, no throw).
 *  4. When the Host stops beating (simulated hang), the page goes stale
 *     within ~3.5 s and both windows have closed themselves within ~9 s.
 *
 * Shows Abu's own chrome for about 15 s. Synthesizes no input. Prints
 * aggregates only. Run: npx electron electron/spike/overlayChromeVerify.cjs
 * Exit code 0 = PASS, 1 = FAIL, 2 = could not run.
 */
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const { registerTauriHost } = require('../tauriHost.cjs');
const { guiDispatch, noteComputerUseNativeCommand, __test } = require('../guiHost.cjs');

app.on('window-all-closed', () => { /* explicit exit below */ });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
}
function overlayWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && /overlay\.html/.test(win.webContents.getURL())) ?? null;
}
async function pageState() {
  const win = overlayWindow();
  if (!win) return null;
  try {
    return await win.webContents.executeJavaScript('window.__cuChromeState()');
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  let exitCode = 2;
  try {
    registerTauriHost(app);
    await guiDispatch(app, 'show_screen_border', { stopLabel: 'Stop', unresponsiveLabel: 'Unresponsive (test)' });
    await sleep(2200);

    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length;
    record('overlay and stop button exist', windows === 2, { windows });
    const live = await pageState();
    record('heartbeat reaches the overlay page', Boolean(live) && live.beats >= 1 && live.stale === false, live);
    record('heartbeat timer is running in the Host', __test.chromeState().heartbeatRunning);

    // Cursor: lease active → marker on at the real pointer.
    noteComputerUseNativeCommand('input_lease_activate', {}, { ok: true });
    await sleep(250);
    const active = await pageState();
    record('marker is shown at a pointer position while the lease is active',
      Boolean(active?.cursor?.visible) && Number.isFinite(active.cursor.x) && Number.isFinite(active.cursor.y),
      active?.cursor);
    noteComputerUseNativeCommand('mouse_click', { x: 400, y: 300 }, 'clicked');
    await sleep(150);
    const clicked = await pageState();
    record('a click pulses a ripple', (clicked?.ripples ?? 0) >= 1, { ripples: clicked?.ripples });
    noteComputerUseNativeCommand('keyboard_type', { text: 'never shown' }, 'typed');
    noteComputerUseNativeCommand('input_lease_observe', {}, { ok: true });
    await sleep(900);
    const released = await pageState();
    record('marker hides after the lease is released', released?.cursor?.visible === false, released?.cursor);
    record('cursor push stopped in the Host', __test.chromeState().cursorRunning === false);

    // Display follow: single display here, so only "no throw + same bounds".
    const before = overlayWindow()?.getBounds();
    noteComputerUseNativeCommand('activate_window', { windowId: 'hwnd:0x1' }, { window_id: 'hwnd:0x1', bounds: [100, 100, 600, 400] });
    const after = overlayWindow()?.getBounds();
    const display = screen.getPrimaryDisplay().bounds;
    record('following a target window keeps the chrome on the full display', JSON.stringify(after) === JSON.stringify(display) && JSON.stringify(before) === JSON.stringify(display), { before, after, display });

    // Watchdog: the Host goes silent.
    __test.stopChromeHeartbeat();
    await sleep(3600);
    const stale = await pageState();
    record('overlay goes stale ~3 s after the last heartbeat', stale?.stale === true, { stale: stale?.stale, beats: stale?.beats });
    await sleep(5600);
    const remaining = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length;
    record('both chrome windows closed themselves ~8 s after the last heartbeat', remaining === 0, { remaining });

    exitCode = checks.every((check) => check.pass) ? 0 : 1;
  } catch (error) {
    record('spike ran to completion', false, error instanceof Error ? error.message : String(error));
  } finally {
    try { await guiDispatch(app, 'hide_screen_border', {}); } catch { /* best effort */ }
    console.log(JSON.stringify({ verdict: exitCode === 0 ? 'PASS' : 'FAIL', checks }, null, 2));
    app.exit(exitCode);
  }
});
