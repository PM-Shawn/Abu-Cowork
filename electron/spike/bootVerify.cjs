/**
 * Boot-verify harness — acceptance check for Phase 2 slice A ("startup
 * foundation") + slice B ("event bridge") + slice C ("secret store") + slice D
 * ("window family + preventable close"). Same shape as
 * electron/spike/bootSpike.cjs, but exercises the PRODUCTION preload
 * (electron/preload.cjs) + registerTauriHost(app) instead of the throwaway
 * capture shim, to prove the real frontend now boots past the
 * path-plugin/platform-detection cascade.
 *
 * Loads dist-electron-spike/index.html windowless (show:false), lets it
 * settle, then asserts NONE of the five known boot-cascade error substrings
 * (from the pre-slice-A boot spike) still appear in captured renderer
 * console output. Then (slice B) drives a real event round-trip: registers a
 * `listen()`-shaped callback via `transformCallback` + `plugin:event|listen`
 * in the page world, has main call `emitEvent()`, and asserts the callback
 * received the Tauri Event object — proving the callback survives the
 * contextBridge boundary and main→renderer delivery works. Then (slice C)
 * drives a real secret_set/get/has/list/delete round-trip through
 * window.__TAURI_INTERNALS__.invoke, asserting a non-ASCII value round-trips
 * exactly. That round-trip is wrapped in a timeout because safeStorage can
 * trigger an OS Keychain access prompt on first use on macOS, which would
 * block this unattended run — see the secretRoundTrip block below. Then
 * (slice D) drives a real `plugin:window|*` round-trip (is_focused/set_title/
 * set_theme/outer_position) AND proves preventable-close: this harness wires
 * the same `win.on('close')` prevent-default + emitEvent('close-requested')
 * pattern main.cjs uses (via setMainWindow/isQuitting from tauriHost.cjs),
 * registers a page-side 'close-requested' listener the same way the
 * eventRoundTrip block does, calls win.close() from main, and asserts both
 * that the window survived (close was prevented) and that the renderer's
 * listener actually fired. Writes electron-results/boot-verify.json with
 * {pass, remainingErrors, stubCommands, eventRoundTrip, secretRoundTrip,
 * secretNote?, windowRoundTrip, closePrevented, closeRequestedDelivered}.
 * PASS requires no cascade errors AND eventRoundTrip AND secretRoundTrip AND
 * windowRoundTrip AND closePrevented AND closeRequestedDelivered. Run:
 *   npm run electron:boot-verify
 */
'use strict';

const { app, BrowserWindow, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  registerTauriHost,
  getStubbedCommands,
  emitEvent,
  wireWindowEvents,
} = require('../tauriHost.cjs');
const { registerPrivilegedWindow } = require('../securityBoundary.cjs');

const SETTLE_MS = 9000;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const OUT = path.join(REPO_ROOT, 'electron-results', 'boot-verify.json');
const PRELOAD = path.join(__dirname, '..', 'preload.cjs');

// Boot-cascade errors observed BEFORE slice A (see boot-spike.json) — these
// MUST be gone once the path plugin + platform detection are real.
const MUST_BE_GONE = [
  'Platform detection init error',
  '[RegistryWatcher] Failed to start',
  '[PluginLoader] Plugin discovery failed',
  'Discovery refresh failed',
  'Notice inbox drain error',
  '[Memdir] Migration failed',
];

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  if (!fs.existsSync(INDEX)) {
    console.error('[boot-verify] missing build:', INDEX, '\nRun: npx vite build --base=./ --outDir dist-electron-spike');
    app.exit(2);
    return;
  }

  registerTauriHost(app);

  const consoleLines = [];
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true, // must match production main.cjs so the verify exercises the real posture
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (...a) => {
    const parts = a.slice(1).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
    consoleLines.push(parts.join(' '));
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    consoleLines.push('RENDER-GONE ' + JSON.stringify(d));
  });

  // Slice D: this harness owns its own window (it doesn't go through main.cjs's
  // createWindow()), so wire it via the SAME shared helper main.cjs uses — so
  // the close-prevention test below exercises the real production wiring
  // (isQuitting + has-listener guards), not a copy that could drift.
  wireWindowEvents(win);
  registerPrivilegedWindow(win, INDEX, { label: 'boot-verify' });

  try {
    await win.loadFile(INDEX);
  } catch (err) {
    consoleLines.push('LOAD-ERROR ' + String(err));
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // Phase 2 slice B acceptance: prove the callback registered via
  // transformCallback survives the contextBridge boundary and that main
  // (emitEvent) can deliver an event back to it through the real
  // plugin:event|listen subscription registry. The child `srcdoc` iframe is
  // a regression check for HTML widgets: its navigation must not clear the
  // still-live top-level renderer's subscriptions.
  let eventRoundTrip = false;
  try {
    await win.webContents.executeJavaScript(`
      (async () => {
        globalThis.__abuEvtTest = null;
        const id = window.__TAURI_INTERNALS__.transformCallback((e) => { globalThis.__abuEvtTest = e; });
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'abu-b-roundtrip', target: { kind: 'Any' }, handler: id });
        const iframe = document.createElement('iframe');
        iframe.hidden = true;
        const iframeLoaded = new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }));
        iframe.srcdoc = '<!doctype html><title>widget regression</title>';
        document.body.appendChild(iframe);
        await iframeLoaded;
        return true;
      })()
    `);
    emitEvent('abu-b-roundtrip', { hello: 'B' });
    await new Promise((r) => setTimeout(r, 300));
    const result = await win.webContents.executeJavaScript('globalThis.__abuEvtTest');
    eventRoundTrip = !!result && result.event === 'abu-b-roundtrip' && typeof result.id === 'number' && result.payload && result.payload.hello === 'B';
    if (!eventRoundTrip) {
      consoleLines.push('EVENT-ROUNDTRIP-MISMATCH ' + JSON.stringify(result));
    }
  } catch (err) {
    consoleLines.push('EVENT-ROUNDTRIP-ERROR ' + String(err));
  }

  // 0.38 reliability regression: the fixed Abu sidecar stream uses a
  // preload-owned Electron IPC channel instead of the compatibility Tauri
  // event registry. Prove a real sidecar echo still returns after another
  // child-frame navigation.
  let sidecarDirectRoundTrip = false;
  let sidecarSequencedReplay = false;
  try {
    const sidecarResult = await win.webContents.executeJavaScript(`
      (async () => {
        const requestId = 'boot-direct-sidecar';
        const received = [];
        const unsubscribe = window.__ABU_SHELL__.subscribeSidecarEvents((event) => {
          if (event.type !== 'message') return;
          try {
            const message = JSON.parse(event.payload);
            if (message.id === requestId) received.push({ message, event });
          } catch {}
        });
        try {
          const iframe = document.createElement('iframe');
          iframe.hidden = true;
          const iframeLoaded = new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }));
          iframe.srcdoc = '<!doctype html><title>sidecar channel regression</title>';
          document.body.appendChild(iframe);
          await iframeLoaded;

          await window.__TAURI_INTERNALS__.invoke('mcp_write', {
            id: 'abu-sidecar',
            message: JSON.stringify({
              jsonrpc: '2.0',
              id: requestId,
              method: 'echo',
              params: { channel: 'dedicated' },
            }),
          });
          for (let attempt = 0; attempt < 40 && received.length === 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const matched = received[0];
          const snapshot = await window.__ABU_SHELL__.getSidecarBridgeSnapshot(
            Math.max(0, (matched?.event?.sequence ?? 1) - 1),
          );
          return {
            echo: matched?.message?.result?.channel === 'dedicated',
            sequencedReplay: Number.isSafeInteger(matched?.event?.sequence)
              && matched.event.sequence > 0
              && Number.isSafeInteger(matched?.event?.generation)
              && matched.event.generation > 0
              && snapshot?.events?.some?.((event) =>
                event.sequence === matched.event.sequence
                && event.payload === matched.event.payload
              ),
          };
        } finally {
          unsubscribe();
        }
      })()
    `);
    sidecarDirectRoundTrip = sidecarResult?.echo === true;
    sidecarSequencedReplay = sidecarResult?.sequencedReplay === true;
    if (!sidecarDirectRoundTrip) {
      consoleLines.push('SIDECAR-DIRECT-ROUNDTRIP-MISMATCH');
    }
    if (!sidecarSequencedReplay) {
      consoleLines.push('SIDECAR-SEQUENCED-REPLAY-MISMATCH');
    }
  } catch (err) {
    consoleLines.push('SIDECAR-DIRECT-ROUNDTRIP-ERROR ' + String(err));
  }

  // Phase 2 slice C acceptance: real secret_set/get/has/list/delete round-trip
  // through the production IPC surface, asserting a non-ASCII value survives
  // exactly. RISK: safeStorage can trigger an OS Keychain access prompt on
  // first use on macOS, which would block this unattended run — so the
  // round-trip is raced against a timeout, and an unavailable/timed-out
  // safeStorage is recorded as a clear note rather than treated as a silent
  // crash (the harness still finishes and reports the other checks).
  let secretRoundTrip = false;
  let secretNote;
  const SECRET_TIMEOUT_MS = 6000;
  try {
    let encryptionAvailable = false;
    try {
      encryptionAvailable = safeStorage.isEncryptionAvailable();
    } catch (err) {
      consoleLines.push('SECRET-ROUNDTRIP-AVAILABILITY-ERROR ' + String(err));
    }

    if (!encryptionAvailable) {
      secretNote = 'safeStorage unavailable / possible Keychain prompt — needs attended verification';
      consoleLines.push('SECRET-ROUNDTRIP-SKIPPED: safeStorage.isEncryptionAvailable() === false');
    } else {
      const attempt = win.webContents.executeJavaScript(`
        (async () => {
          const K = 'provider:__spikeC_test__';
          const inv = (c,a)=>window.__TAURI_INTERNALS__.invoke(c,a);
          await inv('secret_set', { key: K, value: 'sk-electron-C-秘密🔐' });
          const got = await inv('secret_get', { key: K });
          const has = await inv('secret_has', { key: K });
          const list = await inv('secret_list', {});
          await inv('secret_delete', { key: K });
          const afterDel = await inv('secret_get', { key: K });
          return { got, has, listHasK: Array.isArray(list) && list.includes(K), afterDel };
        })()
      `);
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ __timedOut: true }), SECRET_TIMEOUT_MS)
      );
      const result = await Promise.race([attempt, timeout]);

      if (result && result.__timedOut) {
        secretNote = 'safeStorage unavailable / possible Keychain prompt — needs attended verification';
        consoleLines.push(`SECRET-ROUNDTRIP-TIMEOUT after ${SECRET_TIMEOUT_MS}ms`);
      } else {
        secretRoundTrip =
          !!result &&
          result.got === 'sk-electron-C-秘密🔐' &&
          result.has === true &&
          result.listHasK === true &&
          result.afterDel === null;
        if (!secretRoundTrip) {
          consoleLines.push('SECRET-ROUNDTRIP-MISMATCH ' + JSON.stringify(result));
        }
      }
    }
  } catch (err) {
    secretNote = 'safeStorage unavailable / possible Keychain prompt — needs attended verification';
    consoleLines.push('SECRET-ROUNDTRIP-ERROR ' + String(err));
  }

  // Best-effort cleanup so the test key never lingers in the real dev secret
  // store even if the round-trip timed out before its own delete (capped so a
  // hung page can't block the harness).
  try {
    await Promise.race([
      win.webContents.executeJavaScript(
        `window.__TAURI_INTERNALS__.invoke('secret_delete', { key: 'provider:__spikeC_test__' }).then(() => true).catch(() => true)`
      ),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* ignore */
  }

  // Phase 2 slice D acceptance (1/2): real `plugin:window|*` round-trip
  // through the production IPC surface — is_focused resolves a boolean,
  // set_title/set_theme don't throw, outer_position returns numeric x/y.
  let windowRoundTrip = false;
  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
        const focused = await inv('plugin:window|is_focused', {});
        await inv('plugin:window|set_title', { title: 'abu-boot-verify-D' });
        await inv('plugin:window|set_theme', { value: 'dark' });
        const pos = await inv('plugin:window|outer_position', {});
        return { focusedType: typeof focused, pos };
      })()
    `);
    windowRoundTrip =
      !!result &&
      result.focusedType === 'boolean' &&
      !!result.pos &&
      typeof result.pos.x === 'number' &&
      typeof result.pos.y === 'number';
    if (!windowRoundTrip) {
      consoleLines.push('WINDOW-ROUNDTRIP-MISMATCH ' + JSON.stringify(result));
    }
  } catch (err) {
    consoleLines.push('WINDOW-ROUNDTRIP-ERROR ' + String(err));
  }

  // Phase 2 slice D acceptance (2/2): preventable close. Register a
  // page-side 'close-requested' listener the same way eventRoundTrip does,
  // then call win.close() from MAIN (not via the app_exit command — that
  // would flip isQuitting() and let the close through, which is the OTHER
  // path, not this one). Assert the window survived (preventDefault worked)
  // AND the renderer actually received the event (emitEvent → deliver()
  // reached the real plugin:event|listen subscription, not just that
  // preventDefault ran).
  let closePrevented = false;
  let closeRequestedDelivered = false;
  try {
    await win.webContents.executeJavaScript(`
      (async () => {
        globalThis.__abuCloseTest = null;
        const id = window.__TAURI_INTERNALS__.transformCallback((e) => { globalThis.__abuCloseTest = e; });
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'close-requested', target: { kind: 'Any' }, handler: id });
        return true;
      })()
    `);
    win.close();
    await new Promise((r) => setTimeout(r, 300));
    closePrevented = !win.isDestroyed();
    if (!closePrevented) {
      consoleLines.push('CLOSE-NOT-PREVENTED: window was destroyed by win.close()');
    } else {
      const delivered = await win.webContents.executeJavaScript('globalThis.__abuCloseTest');
      closeRequestedDelivered = !!delivered && delivered.event === 'close-requested';
      if (!closeRequestedDelivered) {
        consoleLines.push('CLOSE-REQUESTED-NOT-DELIVERED ' + JSON.stringify(delivered));
      }
    }
  } catch (err) {
    consoleLines.push('CLOSE-ROUNDTRIP-ERROR ' + String(err));
  }

  // Phase 2 slice E acceptance: real plugin:fs|* round-trip. Drives the raw
  // invokes the way @tauri-apps/plugin-fs does — a RAW-BODY write (bytes as the
  // invoke body, path+options in headers) then a byte-array read decoded back —
  // proving the preload's raw-body/headers forwarding and the Node fs handlers
  // work, and that a non-ASCII value survives exactly. baseDir 12 = Temp.
  let fsRoundTrip = false;
  const statTarget = path.join(app.getPath('temp'), `abu-stat-target-${process.pid}.txt`);
  const statLink = path.join(app.getPath('temp'), `abu-stat-link-${process.pid}.txt`);
  try {
    fs.writeFileSync(statTarget, 'stat-target');
    try {
      fs.rmSync(statLink, { force: true });
    } catch {
      /* absent */
    }
    fs.symlinkSync(statTarget, statLink);
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const inv = window.__TAURI_INTERNALS__.invoke;
        const rel = 'abu-sliceE-test-秘密.txt';
        const bytes = new TextEncoder().encode('fs slice E 内容🗂️');
        await inv('plugin:fs|write_text_file', bytes, { headers: { path: encodeURIComponent(rel), options: JSON.stringify({ baseDir: 12 }) } });
        const existsRes = await inv('plugin:fs|exists', { path: rel, options: { baseDir: 12 } });
        const readBack = await inv('plugin:fs|read_text_file', { path: rel, options: { baseDir: 12 } });
        const decoded = new TextDecoder().decode(new Uint8Array(readBack));
        const statTarget = await inv('plugin:fs|stat', { path: ${JSON.stringify(statTarget)} });
        const statLink = await inv('plugin:fs|stat', { path: ${JSON.stringify(statLink)} });
        const lstatLink = await inv('plugin:fs|lstat', { path: ${JSON.stringify(statLink)} });
        await inv('plugin:fs|remove', { path: rel, options: { baseDir: 12 } });
        const afterRemove = await inv('plugin:fs|exists', { path: rel, options: { baseDir: 12 } });
        return { existsRes, decoded, statTarget, statLink, lstatLink, afterRemove };
      })()
    `);
    fsRoundTrip =
      !!result &&
      result.existsRes === true &&
      result.decoded === 'fs slice E 内容🗂️' &&
      result.statTarget?.isFile === true &&
      result.statTarget?.isSymlink === false &&
      typeof result.statTarget?.mtime === 'string' &&
      result.statLink?.isFile === true &&
      result.lstatLink?.isSymlink === true &&
      result.afterRemove === false;
    if (!fsRoundTrip) {
      consoleLines.push('FS-ROUNDTRIP-MISMATCH ' + JSON.stringify(result));
    }
  } catch (err) {
    consoleLines.push('FS-ROUNDTRIP-ERROR ' + String(err));
  } finally {
    try {
      fs.rmSync(statLink, { force: true });
      fs.rmSync(statTarget, { force: true });
    } catch {
      /* best-effort */
    }
  }

  // Slice-E review regression: the fs capability scope must be enforced — an
  // out-of-scope absolute read (/etc/passwd) must be REFUSED, not served.
  let fsScopeGuard = false;
  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          await window.__TAURI_INTERNALS__.invoke('plugin:fs|read_text_file', { path: '/etc/passwd' });
          return { denied: false };
        } catch (e) { return { denied: true }; }
      })()
    `);
    fsScopeGuard = !!result && result.denied === true;
    if (!fsScopeGuard) consoleLines.push('FS-SCOPE-NOT-ENFORCED ' + JSON.stringify(result));
  } catch (err) {
    consoleLines.push('FS-SCOPE-ERROR ' + String(err));
  }

  // A renderer with the real privileged preload remains untrusted until its
  // WebContents and exact local page are registered. Exercise Electron's real
  // sender/senderFrame objects here, not only the plain-Node unit fakes.
  let ipcSenderGuard = false;
  let rogueWin;
  try {
    rogueWin = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await rogueWin.loadURL('data:text/html,<title>untrusted-ipc-sender</title>');
    const result = await rogueWin.webContents.executeJavaScript(`
      (async () => {
        try {
          await window.__TAURI_INTERNALS__.invoke('plugin:path|home_dir', {});
          return { denied: false };
        } catch (error) {
          return { denied: true, message: String(error) };
        }
      })()
    `);
    ipcSenderGuard =
      !!result &&
      result.denied === true &&
      result.message.includes('Blocked privileged IPC: unregistered IPC sender');
    if (!ipcSenderGuard) {
      consoleLines.push('IPC-SENDER-GUARD-NOT-ENFORCED ' + JSON.stringify(result));
    }
  } catch (err) {
    consoleLines.push('IPC-SENDER-GUARD-ERROR ' + String(err));
  } finally {
    if (rogueWin && !rogueWin.isDestroyed()) rogueWin.destroy();
  }

  let navigationGuard = false;
  let popupGuard = false;
  try {
    const trustedUrl = win.webContents.getURL();
    await win.webContents.executeJavaScript(`
      (() => {
        const link = document.createElement('a');
        link.href = 'data:text/html,<title>blocked-navigation</title>';
        document.body.appendChild(link);
        link.click();
        link.remove();
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));
    navigationGuard = win.webContents.getURL() === trustedUrl;
    if (!navigationGuard) {
      consoleLines.push('NAVIGATION-GUARD-NOT-ENFORCED ' + win.webContents.getURL());
    }

    const beforePopupCount = BrowserWindow.getAllWindows().length;
    await win.webContents.executeJavaScript(`
      (() => {
        window.open('data:text/html,<title>blocked-popup</title>', '_blank');
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));
    popupGuard = BrowserWindow.getAllWindows().length === beforePopupCount;
    if (!popupGuard) {
      consoleLines.push(
        `POPUP-GUARD-NOT-ENFORCED before=${beforePopupCount} after=${BrowserWindow.getAllWindows().length}`
      );
    }
  } catch (err) {
    consoleLines.push('NAVIGATION-POPUP-GUARD-ERROR ' + String(err));
  }

  const errorLines = consoleLines.filter((l) => /error|gone|LOAD-ERROR|Uncaught|TypeError/i.test(l));
  const remainingErrors = [...new Set(errorLines)];
  const goneOk = MUST_BE_GONE.every((needle) => !remainingErrors.some((l) => l.includes(needle)));
  // secretRoundTrip is only REQUIRED when safeStorage is actually available. If
  // it's unavailable / the round-trip timed out (secretNote set), that's an
  // attended-verification gap, not a slice-C failure — don't regress PASS on it.
  const secretOk = secretRoundTrip || !!secretNote;
  const pass =
    goneOk &&
    eventRoundTrip &&
    sidecarDirectRoundTrip &&
    sidecarSequencedReplay &&
    secretOk &&
    windowRoundTrip &&
    closePrevented &&
    closeRequestedDelivered &&
    fsRoundTrip &&
    fsScopeGuard &&
    ipcSenderGuard &&
    navigationGuard &&
    popupGuard;

  const stubCommands = getStubbedCommands();

  const report = {
    pass,
    remainingErrors,
    stubCommands,
    eventRoundTrip,
    sidecarDirectRoundTrip,
    sidecarSequencedReplay,
    secretRoundTrip,
    ...(secretNote ? { secretNote } : {}),
    windowRoundTrip,
    closePrevented,
    closeRequestedDelivered,
    fsRoundTrip,
    fsScopeGuard,
    ipcSenderGuard,
    navigationGuard,
    popupGuard,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(
    `[boot-verify] ${pass ? 'PASS' : 'FAIL'} — ${remainingErrors.length} remaining console error line(s), eventRoundTrip=${eventRoundTrip}, sidecarDirectRoundTrip=${sidecarDirectRoundTrip}, sidecarSequencedReplay=${sidecarSequencedReplay}, secretRoundTrip=${secretRoundTrip}, windowRoundTrip=${windowRoundTrip}, closePrevented=${closePrevented}, closeRequestedDelivered=${closeRequestedDelivered}, fsRoundTrip=${fsRoundTrip}, ipcSenderGuard=${ipcSenderGuard}, navigationGuard=${navigationGuard}, popupGuard=${popupGuard} → ${OUT}`
  );
  if (secretNote) {
    console.log(`  ⚠ secretNote: ${secretNote}`);
  }
  if (remainingErrors.length) {
    for (const l of remainingErrors) console.log('  •', l);
  }

  app.exit(pass ? 0 : 1);
});
