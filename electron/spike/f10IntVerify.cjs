/**
 * F10 integration proof — drives computer-use / AX commands through the FULL
 * production path a renderer would use: window.__TAURI_INTERNALS__.invoke →
 * preload → tauriHost → nativeHelperManager (spawns the helper + camelCase→
 * snake_case arg conversion) → native-helper RPC → result. This is what was
 * stubbed before F10 integration.
 *
 * Sends camelCase args exactly like computerTools.ts does, so it exercises the
 * router's Tauri-style casing (appName→app_name, sessionId→session_id), the AX
 * session cache across separate RPC calls, and the host-owned Observe → Act →
 * Verify state lifecycle. The action is a read-only cursor-position query: it
 * consumes state_id without clicking or typing into the target application.
 *
 * Run: npx electron electron/spike/f10IntVerify.cjs   (real machine; AX/screen
 * TCC inherit the launching Terminal's grants)
 */
'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const { registerTauriHost, setMainWindow } = require('../tauriHost.cjs');
const { registerPrivilegedWindow } = require('../securityBoundary.cjs');

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  // This is an explicit local acceptance fixture. Keep the production approval
  // path intact while deterministically accepting its native dialogs here.
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
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
  registerPrivilegedWindow(win, page, { label: 'main' });
  setMainWindow(win);
  await win.loadFile(page);

  const out = await win.webContents.executeJavaScript(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const tokenArg = '__abuComputerUseToken';
    const conversationId = 'f10-integration';
    const loopId = 'f10-state-lifecycle';
    const begin = (toolCallId, actionIntent, expectedStateId = null, scope = 'ui-control') =>
      invoke('computer_use_begin_session', {
        conversationId,
        loopId,
        toolCallId,
        interactionMode: 'foreground',
        scope,
        targetApp: scope === 'ui-control' ? 'Finder' : null,
        expectedStateId,
        actionIntent,
        permissionMode: 'standard',
      });
    const privileged = (cmd, args, token) => invoke(cmd, { ...args, [tokenArg]: token });
    const end = (token) => invoke('computer_use_end_session', { [tokenArg]: token });
    const r = {};
    try { r.perms = await invoke('check_macos_permissions'); } catch (e) { r.permsErr = String(e); }
    if (r.perms?.accessibility !== true || r.perms?.screen_recording !== true) {
      r.preconditionError = 'Electron requires Accessibility and Screen Recording permissions';
      return r;
    }
    await invoke('computer_use_set_enabled', { enabled: true });

    let observe;
    try {
      observe = await begin('observe-before', { action: 'get_app_state', category: 'none', summary: '' });
      r.activated = await privileged('activate_app', { appName: 'Finder' }, observe.token);
      const snap = await privileged('ax_snapshot', { appName: 'Finder' }, observe.token);
      r.sessionId = snap && snap.session_id;
      r.stateId = snap && snap.state_id;
      r.elementCount = snap && snap.elements ? snap.elements.length : -1;
    } catch (e) { r.snapErr = String(e); }
    finally { if (observe?.token) await end(observe.token); }

    let action;
    try {
      action = await begin(
        'consume-state',
        { action: 'move', category: 'none', summary: '' },
        r.stateId,
      );
      r.cursor = await privileged('mouse_move', {}, action.token);
      r.actionOk = Array.isArray(r.cursor && r.cursor.was_at);
    } catch (e) { r.actionErr = String(e); }
    finally { if (action?.token) await end(action.token); }

    try {
      await begin(
        'reuse-state',
        { action: 'move', category: 'none', summary: '' },
        r.stateId,
      );
      r.reuseRejected = false;
    } catch (e) {
      r.reuseErr = String(e);
      r.reuseRejected = /consumed|latest observation|fresh state_id/.test(r.reuseErr);
    }

    let verify;
    try {
      verify = await begin('observe-after', { action: 'get_app_state', category: 'none', summary: '' });
      const snap = await privileged('ax_snapshot', { appName: 'Finder' }, verify.token);
      r.verifiedStateId = snap && snap.state_id;
      r.verifiedElementCount = snap && snap.elements ? snap.elements.length : -1;
    } catch (e) { r.verifyErr = String(e); }
    finally { if (verify?.token) await end(verify.token); }

    let capture;
    try {
      capture = await begin(
        'capture-after',
        { action: 'screenshot', category: 'none', summary: '' },
        null,
        'screen-read',
      );
      const cap = await privileged('capture_screen', {}, capture.token);
      r.capW = cap && cap.width;
      r.capBase64Len = cap && cap.base64 ? cap.base64.length : 0;
    }
    catch (e) { r.capErr = String(e); }
    finally { if (capture?.token) await end(capture.token); }

    try {
      await invoke('ax_close_session', { sessionId: r.sessionId });
      r.closeOk = true;
    } catch (e) { r.closeErr = String(e); }
    await invoke('computer_use_end_task', { conversationId, loopId });
    return r;
  })()`);

  const passed =
    !!out.perms && typeof out.perms.accessibility === 'boolean' &&
    typeof out.activated === 'string' &&              // bare string, not {activated}
    typeof out.sessionId === 'string' && out.elementCount > 0 &&  // ax_snapshot via app_name worked
    typeof out.stateId === 'string' && out.stateId.length > 0 &&  // host owns state issuance
    out.actionOk === true && out.reuseRejected === true &&        // single-use state at dispatch boundary
    typeof out.verifiedStateId === 'string' &&
    out.verifiedStateId !== out.stateId && out.verifiedElementCount > 0 &&
    out.capW > 0 && out.capBase64Len > 0 &&            // capture returns base64 shape
    out.closeOk === true;

  console.log('[f10-int] ' + JSON.stringify(out));
  console.log('[f10-int] PASSED=' + passed);
  app.exit(passed ? 0 : 1);
});
