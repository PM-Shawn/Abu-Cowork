/**
 * F10 integration proof — drives computer-use / AX commands through the FULL
 * production path a renderer would use: window.__TAURI_INTERNALS__.invoke →
 * preload → tauriHost → nativeHelperManager (spawns the helper + camelCase→
 * snake_case arg conversion) → native-helper RPC → result. This is what was
 * stubbed before F10 integration.
 *
 * Sends camelCase args exactly like computerTools.ts does, so it exercises the
 * router's Tauri-style casing (appName→app_name, sessionId→session_id,
 * elementId→element_id) AND the AX session cache across separate RPC calls.
 *
 * Run: npx electron electron/spike/f10IntVerify.cjs   (real machine; AX/screen
 * TCC inherit the launching Terminal's grants)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { registerTauriHost } = require('../tauriHost.cjs');

app.on('window-all-closed', () => app.quit());

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

  const out = await win.webContents.executeJavaScript(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const r = {};
    try { r.perms = await invoke('check_macos_permissions'); } catch (e) { r.permsErr = String(e); }
    try { r.activated = await invoke('activate_app', { appName: 'Finder' }); } catch (e) { r.activatedErr = String(e); }
    try {
      const snap = await invoke('ax_snapshot', { appName: 'Finder' });
      r.sessionId = snap && snap.session_id;
      r.elementCount = snap && snap.elements ? snap.elements.length : -1;
    } catch (e) { r.snapErr = String(e); }
    // Exercises camelCase→snake (sessionId/elementId) AND the session cache
    // (a wiring bug would say "session ... not found"; a real AX error is a PASS).
    try { r.press = await invoke('ax_press', { sessionId: r.sessionId, elementId: 0 }); r.pressOk = true; }
    catch (e) { r.pressErr = String(e); r.pressOk = !/not found/.test(String(e)); }
    try { const cap = await invoke('capture_screen'); r.capW = cap && cap.width; r.capBase64Len = cap && cap.base64 ? cap.base64.length : 0; }
    catch (e) { r.capErr = String(e); }
    try { await invoke('ax_close_session', { sessionId: r.sessionId }); r.closeOk = true; } catch (e) { r.closeErr = String(e); }
    return r;
  })()`);

  const passed =
    !!out.perms && typeof out.perms.accessibility === 'boolean' &&
    typeof out.activated === 'string' &&              // bare string, not {activated}
    typeof out.sessionId === 'string' && out.elementCount > 0 &&  // ax_snapshot via app_name worked
    out.pressOk === true &&                            // session cache round-trips through the router
    out.capW > 0 && out.capBase64Len > 0 &&            // capture returns base64 shape
    out.closeOk === true;

  console.log('[f10-int] ' + JSON.stringify(out));
  console.log('[f10-int] PASSED=' + passed);
  app.exit(passed ? 0 : 1);
});
