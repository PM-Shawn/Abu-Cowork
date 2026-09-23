/**
 * L5 W2/W3/W4 — the on-screen Computer Use chrome against real windows:
 *
 *  1. show_screen_border brings up the overlay border + the status strip and
 *     the Host's heartbeat reaches both pages.
 *  2. Activating the input lease turns the cursor marker on at the real
 *     pointer; a click pulses a ripple; releasing the lease hides the marker.
 *  3. A resolved target window is followed (single display here: full-display
 *     bounds, no throw).
 *  4. The strip renders the status the renderer pushes (app · phase：action ·
 *     step), switches to its paused form on computer_use_chrome_paused,
 *     survives hide_screen_border while paused, its 【继续】 emits
 *     computer-use-resume, and computer_use_chrome_dismiss removes it.
 *  5. When the Host stops beating (simulated hang), the pages go stale within
 *     ~3.5 s and have closed themselves within ~9 s.
 *
 * Shows Abu's own chrome for about 20 s. Synthesizes no input. Prints
 * aggregates only. Run: npx electron electron/spike/overlayChromeVerify.cjs
 * Exit code 0 = PASS, 1 = FAIL, 2 = could not run.
 */
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const { registerTauriHost, emitEvent } = require('../tauriHost.cjs');
const { guiDispatch, noteComputerUseNativeCommand, __test } = require('../guiHost.cjs');

app.on('window-all-closed', () => { /* explicit exit below */ });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
}
function liveWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}
function windowFor(page) {
  return liveWindows().find((win) => new RegExp(`${page}\\.html`).test(win.webContents.getURL())) ?? null;
}
async function pageState(page, getter) {
  const win = windowFor(page);
  if (!win) return null;
  try {
    return await win.webContents.executeJavaScript(getter);
  } catch {
    return null;
  }
}
const overlayState = () => pageState('overlay', 'window.__cuChromeState()');
const stripState = () => pageState('overlay-strip', 'window.__cuStripState()');
const LABELS = {
  stopLabel: 'Stop',
  unresponsiveLabel: 'Unresponsive (test)',
  pausedLabel: 'Paused (test)',
  resumeLabel: 'Continue',
  endLabel: 'End',
};

app.whenReady().then(async () => {
  let exitCode = 2;
  try {
    registerTauriHost(app);
    await guiDispatch(app, 'show_screen_border', LABELS);
    await sleep(2200);

    // ── 1. Windows + heartbeat ──
    record('overlay border and status strip exist', liveWindows().length === 2 && Boolean(windowFor('overlay-strip')), { windows: liveWindows().length });
    const live = await overlayState();
    record('heartbeat reaches the overlay page', Boolean(live) && live.beats >= 1 && live.stale === false, live && { beats: live.beats, stale: live.stale });
    const stripLive = await stripState();
    record('heartbeat reaches the strip page', Boolean(stripLive) && stripLive.beats >= 1 && stripLive.mode === 'running', stripLive && { beats: stripLive.beats, mode: stripLive.mode });
    record('strip is not focusable', windowFor('overlay-strip')?.isFocusable() === false);

    // ── 2. Cursor ──
    noteComputerUseNativeCommand('input_lease_activate', {}, { ok: true });
    await sleep(250);
    const active = await overlayState();
    record('marker is shown at a pointer position while the lease is active',
      Boolean(active?.cursor?.visible) && Number.isFinite(active.cursor.x) && Number.isFinite(active.cursor.y));
    noteComputerUseNativeCommand('mouse_click', { x: 400, y: 300 }, 'clicked');
    await sleep(150);
    const clicked = await overlayState();
    record('a click pulses a ripple', (clicked?.ripples ?? 0) >= 1, { ripples: clicked?.ripples });
    noteComputerUseNativeCommand('input_lease_observe', {}, { ok: true });
    await sleep(900);
    const released = await overlayState();
    record('marker hides after the lease is released', released?.cursor?.visible === false);
    record('cursor push stopped in the Host', __test.chromeState().cursorRunning === false);

    // ── 3. Display follow ──
    noteComputerUseNativeCommand('activate_window', { windowId: 'hwnd:0x1' }, { window_id: 'hwnd:0x1', bounds: [100, 100, 600, 400] });
    const display = screen.getPrimaryDisplay().bounds;
    record('following a target window keeps the border on the full display',
      JSON.stringify(windowFor('overlay')?.getBounds()) === JSON.stringify(display));
    const stripBounds = windowFor('overlay-strip')?.getBounds();
    record('strip sits at the bottom centre of that display',
      Boolean(stripBounds) && stripBounds.y + stripBounds.height <= display.y + display.height
        && Math.abs((stripBounds.x + stripBounds.width / 2) - (display.x + display.width / 2)) <= 2,
      stripBounds);

    // ── 4. Strip content, pause, resume, dismiss ──
    emitEvent('computer-use-status', {
      step: 3, maxSteps: 30, action: 'Click "Save"', stepLabel: 'Step 3/30', targetApp: 'Notepad',
      phase: 'acting', phaseLabel: 'Acting', sessionStartTime: Date.now() - 42_000, mode: 'running',
    });
    await sleep(300);
    const shown = await stripState();
    record('strip renders app · phase：action and the step label',
      shown?.text === 'Notepad · Acting：Click "Save"' && shown?.steps === 'Step 3/30' && shown?.mode === 'running',
      shown && { text: shown.text, steps: shown.steps, mode: shown.mode });
    emitEvent('computer-use-status', { step: 3, action: 'Send message', stepLabel: 'Step 3/30', targetApp: 'Slack', phase: 'awaiting-approval', phaseLabel: 'Waiting for you', mode: 'approval' });
    await sleep(300);
    record('strip enters approval mode while a consent dialog is up', (await stripState())?.mode === 'approval');

    await guiDispatch(app, 'computer_use_chrome_paused', {});
    await sleep(400);
    const paused = await stripState();
    record('pause removes the border, keeps the strip in paused form with 【继续】',
      windowFor('overlay') === null && Boolean(windowFor('overlay-strip')) && paused?.mode === 'paused' && paused?.resumeVisible === true && paused?.text === LABELS.pausedLabel,
      paused && { mode: paused.mode, resumeVisible: paused.resumeVisible, text: paused.text });
    await guiDispatch(app, 'hide_screen_border', {});
    await sleep(200);
    record('hide_screen_border (run ending) leaves a paused strip in place', Boolean(windowFor('overlay-strip')) && __test.chromeState().heartbeatRunning === true);
    await pageState('overlay-strip', "document.getElementById('resumeBtn').click(); true");
    await sleep(400);
    const afterResume = await stripState();
    record('【继续】 emits computer-use-resume through the boundary',
      Array.isArray(afterResume?.emits) && afterResume.emits.some((e) => e.event === 'computer-use-resume' && e.ok),
      afterResume?.emits);
    await guiDispatch(app, 'computer_use_chrome_dismiss', {});
    await sleep(300);
    record('dismiss removes the strip and stops the heartbeat', liveWindows().length === 0 && __test.chromeState().heartbeatRunning === false, { windows: liveWindows().length });

    // ── 5. Watchdog ──
    await guiDispatch(app, 'show_screen_border', LABELS);
    await sleep(1800);
    __test.stopChromeHeartbeat();
    await sleep(3600);
    const stale = await overlayState();
    const stripStale = await stripState();
    record('both pages go stale ~3 s after the last heartbeat', stale?.stale === true && stripStale?.mode === 'stale', { overlay: stale?.stale, strip: stripStale?.mode });
    await sleep(5600);
    record('both chrome windows closed themselves ~8 s after the last heartbeat', liveWindows().length === 0, { remaining: liveWindows().length });

    exitCode = checks.every((check) => check.pass) ? 0 : 1;
  } catch (error) {
    record('spike ran to completion', false, error instanceof Error ? error.message : String(error));
  } finally {
    try { await guiDispatch(app, 'computer_use_chrome_dismiss', {}); } catch { /* best effort */ }
    console.log(JSON.stringify({ verdict: exitCode === 0 ? 'PASS' : 'FAIL', checks }, null, 2));
    app.exit(exitCode);
  }
});
