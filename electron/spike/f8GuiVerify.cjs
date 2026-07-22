/**
 * F8 "GUI window/tray families" headless verification — boots a real
 * (hidden) Electron window with the PRODUCTION preload + registerTauriHost +
 * wireWindowEvents, then from the RENDERER calls the auto-verifiable
 * guiHost.cjs commands via `window.__TAURI_INTERNALS__.invoke` (the exact
 * path the frontend uses), and asserts on the results. Modeled on
 * electron/spike/f2Verify.cjs.
 *
 * Covers (headless, structural — see the PASS/FAIL list at the end for which
 * checks are structural-only vs need attended/visual confirmation):
 *  - update_tray_notice_count {count:3} → no throw + tray exists
 *  - update_tray_menu {imChannels, triggerCount} → no throw
 *  - get_abu_window_id      → returns a number (macOS only — Rust errors on
 *    other platforms too, so a throw there is treated as expected-not-a-fail
 *    when run on non-macOS)
 *  - get_active_window      → returns the {app_name, window_title, bundle_id}
 *    shape
 *  - show_screen_border {stopLabel} → get_overlay_window_id returns an id +
 *    2 new windows (overlay + stop button) exist + the stop button's DOM
 *    actually shows the threaded-through label (not just "no throw") +
 *    BOTH cross-window event directions round-trip for real: main→overlay
 *    (`computer-use-status`, driving the overlay's step/action text) and a
 *    simulated stop-button click→main (`computer-use-abort`, via a listener
 *    registered on the harness's own main window using the real
 *    `@tauri-apps/api`-equivalent `transformCallback`/`invoke` machinery)
 *  - hide_screen_border     → both windows gone
 *  - pet_show               → 1 new window exists
 *  - pet_set_frame          → no throw
 *  - pet_hide               → window still exists but not visible
 *  - pet_focus_main         → no throw
 *
 * NOT covered here (attended/visual — see report): the tray icon's actual
 * appearance/position in the menu bar, the overlay's red-border VISUAL +
 * true OS-level click-through (setIgnoreMouseEvents' effect can't be probed
 * without a real mouse event), the stop button's real physical clickability
 * (this harness simulates the click via `element.click()`, which exercises
 * the JS listener + event wiring but not "does an actual mouse click land on
 * this window given its always-on-top level/focusability"), the pet's visual
 * rendering/drag/notification-bubble behavior, and `get_active_window`'s
 * REAL content (this harness can't assert what the "actual" frontmost app is
 * without a controlled attended setup — and in this sandboxed run it FAILS
 * on a macOS TCC Automation permission gate, not a code defect: the exact
 * same osascript run from a bare shell in this environment fails identically
 * with the same "未获得授权将Apple事件发送给System Events" error — see report).
 *
 * Run: npx electron electron/spike/f8GuiVerify.cjs   (self-exits, prints JSON)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { registerTauriHost, wireWindowEvents } = require('../tauriHost.cjs');
const { hasTray } = require('../guiHost.cjs');

app.on('window-all-closed', () => app.quit());

/** @type {{name: string, pass: boolean, detail?: unknown, structuralOnly?: boolean}[]} */
const checks = [];
function record(name, pass, detail, structuralOnly) {
  checks.push({ name, pass, detail, structuralOnly: !!structuralOnly });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** `predicate` may be sync or async (awaited either way). */
async function waitUntil(predicate, timeoutMs = 3000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return await predicate();
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
  // get_abu_window_id (guiHost.cjs) resolves the tracked main window via
  // tauriHost's getMainWindow() — that's only populated by wireWindowEvents
  // (main.cjs calls it for the real main window); without it here, "main
  // window not found" is a harness-setup gap, not a product bug.
  wireWindowEvents(win);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const invokeIn = async (cmd, args) =>
    win.webContents.executeJavaScript(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`
    );

  // ── Tray: update_tray_notice_count ─────────────────────────────────────
  try {
    await invokeIn('update_tray_notice_count', { count: 3 });
    record('update_tray_notice_count (no throw)', true);
    record('tray exists after update_tray_notice_count', hasTray());
  } catch (err) {
    record('update_tray_notice_count', false, String(err));
  }

  // ── Tray: update_tray_menu ──────────────────────────────────────────────
  try {
    await invokeIn('update_tray_menu', {
      imChannels: [{ platform: 'wecom', label: '● 企业微信', sessions: 2 }],
      triggerCount: 1,
    });
    record('update_tray_menu (no throw)', true);
  } catch (err) {
    record('update_tray_menu', false, String(err));
  }

  // ── window_info: get_abu_window_id ─────────────────────────────────────
  try {
    const id = await invokeIn('get_abu_window_id');
    record('get_abu_window_id returns a value', typeof id === 'number' && id > 0, id, true);
  } catch (err) {
    // Rust also errors on non-macOS; only a genuine FAIL on macOS.
    record('get_abu_window_id', process.platform !== 'darwin', String(err));
  }

  // ── window_info: get_active_window ─────────────────────────────────────
  try {
    const info = await invokeIn('get_active_window');
    const shaped =
      info &&
      typeof info === 'object' &&
      typeof info.app_name === 'string' &&
      typeof info.window_title === 'string' &&
      ('bundle_id' in info);
    record('get_active_window shape', shaped, info, true);
  } catch (err) {
    record('get_active_window', false, String(err));
  }

  // ── Overlay: show_screen_border ─────────────────────────────────────────
  try {
    const before = BrowserWindow.getAllWindows().length;
    await invokeIn('show_screen_border', { stopLabel: '停止' });
    const gotTwo = await waitUntil(() => BrowserWindow.getAllWindows().length >= before + 2);
    record('show_screen_border creates overlay+stop-button windows', gotTwo, {
      before,
      after: BrowserWindow.getAllWindows().length,
    });

    const overlayId = await invokeIn('get_overlay_window_id');
    record('get_overlay_window_id returns an id', typeof overlayId === 'number' && overlayId > 0, overlayId, true);

    // Not just "no throw" — actually read the stop button's rendered label,
    // proving the stopLabel query-string → preload → window.__CU_I18N__ →
    // inline <script> plumbing (guiHost.cjs/guiTauriGlobalPreload.cjs)
    // threads the caption through correctly end-to-end.
    const stopBtnWin = BrowserWindow.getAllWindows().find(
      (w) => w.getBounds().width === 160 && w.getBounds().height === 40
    );
    if (stopBtnWin) {
      const label = await stopBtnWin.webContents.executeJavaScript(
        `document.getElementById('stopLabel') && document.getElementById('stopLabel').textContent`
      );
      record('stop-button label threaded through (stopLabel query→preload→DOM)', label === '停止', label);
    } else {
      record('stop-button label threaded through (stopLabel query→preload→DOM)', false, 'stop button window not found');
    }

    // Cross-window event bridge: the MAIN window emits 'computer-use-status'
    // (computerUseStatus.ts's emitStatusToOverlay) via the real
    // `@tauri-apps/api` `emit()` → `plugin:event|emit`; the OVERLAY window
    // listens via its minimal `window.__TAURI__.event.listen()` shim
    // (guiTauriGlobalPreload.cjs). Both round-trip through the SAME
    // tauriHost.cjs `subscriptions`/`deliver()` registry, so this proves that
    // registry is genuinely cross-window, not just same-window loopback.
    const overlayWin = BrowserWindow.getAllWindows().find(
      (w) => w !== win && w !== stopBtnWin && w.getBounds().width !== 160
    );
    if (overlayWin) {
      // Give the overlay's listen() call (an async invoke from its preload)
      // a beat to register before emitting, or the event would fire into an
      // empty subscription set.
      await sleep(300);
      await invokeIn('plugin:event|emit', {
        event: 'computer-use-status',
        payload: { step: 1, action: 'verify', stepLabel: 'Step 1' },
      });
      const gotStatus = await waitUntil(async () => {
        const text = await overlayWin.webContents.executeJavaScript(
          `document.getElementById('statusBar') && document.getElementById('statusBar').textContent`
        );
        return typeof text === 'string' && text.includes('verify');
      }, 2000);
      record('overlay receives cross-window computer-use-status event', gotStatus);
    } else {
      record('overlay receives cross-window computer-use-status event', false, 'overlay window not found');
    }

    // Reverse direction: the STOP BUTTON emits 'computer-use-abort' on click
    // (stop-button.html's inline <script>, via its guiTauriGlobalPreload.cjs
    // shim); the MAIN window listens via the REAL `@tauri-apps/api` listen()
    // (computerUseStatus.ts's setupAbortListener). Register an equivalent
    // listener directly on the harness's own main window (it uses the real
    // production preload.cjs, so `__TAURI_INTERNALS__.transformCallback` is
    // the same machinery `listen()` uses internally) and simulate the click.
    if (stopBtnWin) {
      await win.webContents.executeJavaScript(`
        (async () => {
          window.__abuAbortReceived = false;
          const cbId = window.__TAURI_INTERNALS__.transformCallback(() => { window.__abuAbortReceived = true; });
          await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'computer-use-abort', handler: cbId });
        })();
      `);
      await sleep(150); // let the listen() invoke round-trip land before the click
      await stopBtnWin.webContents.executeJavaScript(`document.getElementById('stopBtn').click()`);
      const gotAbort = await waitUntil(
        () => win.webContents.executeJavaScript('window.__abuAbortReceived === true'),
        2000
      );
      record('main window receives cross-window computer-use-abort click event', gotAbort);
    } else {
      record('main window receives cross-window computer-use-abort click event', false, 'stop button window not found');
    }
  } catch (err) {
    record('show_screen_border', false, String(err));
  }

  // ── Overlay: hide_screen_border ─────────────────────────────────────────
  try {
    const before = BrowserWindow.getAllWindows().length;
    await invokeIn('hide_screen_border');
    const gone = await waitUntil(() => BrowserWindow.getAllWindows().length <= before - 2);
    record('hide_screen_border removes both windows', gone, {
      before,
      after: BrowserWindow.getAllWindows().length,
    });
  } catch (err) {
    record('hide_screen_border', false, String(err));
  }

  // ── Pet: pet_show / pet_set_frame / pet_hide / pet_focus_main ──────────
  let petWin = null;
  try {
    const before = BrowserWindow.getAllWindows();
    await invokeIn('pet_show');
    const appeared = await waitUntil(() => BrowserWindow.getAllWindows().length > before.length);
    petWin = BrowserWindow.getAllWindows().find((w) => !before.includes(w)) || null;
    record('pet_show creates a window', appeared && !!petWin, {
      before: before.length,
      after: BrowserWindow.getAllWindows().length,
    });
  } catch (err) {
    record('pet_show', false, String(err));
  }

  try {
    await invokeIn('pet_set_frame', { width: 120, height: 160, anchorBottom: true, anchorRight: true });
    record('pet_set_frame (no throw)', true);
  } catch (err) {
    record('pet_set_frame', false, String(err));
  }

  try {
    await invokeIn('pet_hide');
    const hidden = await waitUntil(() => !petWin || petWin.isDestroyed() || !petWin.isVisible());
    record('pet_hide hides (keeps window alive)', hidden, {
      exists: !!petWin && !petWin.isDestroyed(),
      visible: petWin && !petWin.isDestroyed() ? petWin.isVisible() : null,
    });
  } catch (err) {
    record('pet_hide', false, String(err));
  }

  try {
    await invokeIn('pet_focus_main');
    record('pet_focus_main (no throw)', true);
  } catch (err) {
    record('pet_focus_main', false, String(err));
  }

  const passed = checks.every((c) => c.pass);
  for (const c of checks) {
    const tag = c.structuralOnly ? ' [structural-only]' : '';
    console.log(
      `[f8-gui] ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${tag}${c.detail !== undefined ? ' ' + JSON.stringify(c.detail) : ''}`
    );
  }
  console.log(`[f8-gui] PASSED=${passed}`);
  app.exit(passed ? 0 : 1);
});
