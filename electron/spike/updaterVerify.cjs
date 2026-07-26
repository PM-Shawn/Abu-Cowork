/**
 * Auto-update (F-slice #2) end-to-end verification against a MOCK feed —
 * boots real (hidden) Electron with the PRODUCTION preload + registerTauriHost,
 * serves a local generic-provider feed (latest-mac.yml + zip artifact), and
 * drives the EXACT invoke calls @tauri-apps/plugin-updater makes from a real
 * renderer (`@tauri-apps/api/core.js` imported by file URL — its imports are
 * relative, the plugin's own index.js uses bare specifiers a renderer can't
 * resolve; the invoke strings below are verbatim from the plugin's dist-js).
 *
 * Checks:
 *  1. Older feed version → plugin:updater|check returns null (no update).
 *  2. Newer feed (99.0.0) → check returns Update metadata: version, body
 *     (from releaseNotes), currentVersion, rid.
 *  3. download_and_install with a REAL renderer Channel → Tauri-shaped event
 *     stream: Started{contentLength=artifact size} first, ≥1 Progress whose
 *     chunkLengths sum to the size (guaranteed: ProgressCallbackTransform's
 *     _flush always emits a final event), Finished last; invoke resolves.
 *  4. A successful download leaves hasPendingInstall() true (the state that
 *     routes restart through quitAndInstall).
 *  5. Corrupted feed (wrong sha512, bumped version) → check sees it but
 *     download_and_install REJECTS (integrity), and the new download attempt
 *     cleared the earlier pending-install flag (no stale-install restart).
 *
 * NOT covered (needs a signed build + real OSS feed — F11 remainder):
 * quitAndInstallIfPending's actual quit/install (marks the quitting guard +
 * native Squirrel replace — needs a signed .app), and the packaged
 * app-update.yml pickup (electron-builder embeds it from the yml `publish`
 * block only for dmg/zip targets).
 *
 * Run: npx electron electron/spike/updaterVerify.cjs
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail ?? '' });
}

// ── mock feed state (mutable so one server plays all scenarios) ──
const ZIP_NAME = 'Abu-mock-mac.zip';
const zipBytes = crypto.randomBytes(512 * 1024); // 512KB — several stream chunks
const zipSha512 = crypto.createHash('sha512').update(zipBytes).digest('base64');
let feedVersion = '0.0.1';
let feedSha512 = zipSha512;

function latestMacYml() {
  return [
    `version: ${feedVersion}`,
    'files:',
    `  - url: ${ZIP_NAME}`,
    `    sha512: ${feedSha512}`,
    `    size: ${zipBytes.length}`,
    `path: ${ZIP_NAME}`,
    `sha512: ${feedSha512}`,
    `releaseDate: '2026-07-24T00:00:00.000Z'`,
    'releaseNotes: mock notes for updater harness',
    '',
  ].join('\n');
}

function startFeedServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url && req.url.includes('latest-mac.yml')) {
        res.writeHead(200, { 'Content-Type': 'text/yaml' });
        res.end(latestMacYml());
      } else if (req.url && req.url.includes(ZIP_NAME)) {
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': String(zipBytes.length),
        });
        res.end(zipBytes);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

app.whenReady().then(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-updater-verify-'));
  let server = null;
  const scratchHtml = path.join(__dirname, '__updaterVerify-scratch.html');
  try {
    // Isolate ALL appData under tmp BEFORE registerTauriHost (initSecretStore
    // binds its file path there) — never touch the real electron-dev dir.
    app.setPath('appData', tmpRoot);

    server = await startFeedServer();
    const feedUrl = `http://127.0.0.1:${server.address().port}/`;
    // Must be set BEFORE the first plugin:updater|* dispatch — updaterHost
    // reads it once at lazy configure time.
    process.env.ABU_UPDATER_FEED_URL = feedUrl;

    const { registerTauriHost } = require('../tauriHost.cjs');
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
    fs.writeFileSync(scratchHtml, '<!doctype html><title>updater-verify</title>');
    await win.loadFile(scratchHtml);

    const coreJsUrl = pathToFileURL(
      path.join(__dirname, '..', '..', 'node_modules', '@tauri-apps', 'api', 'core.js')
    ).href;

    // ── 1) older feed version → no update ──
    const nullResult = await win.webContents.executeJavaScript(`(async () => {
      const core = await import(${JSON.stringify(coreJsUrl)});
      window.__core = core;
      return await core.invoke('plugin:updater|check', {});
    })()`);
    check('check() with an older feed version returns null', nullResult === null, JSON.stringify(nullResult));

    // ── 2) newer feed → Update metadata ──
    feedVersion = '99.0.0';
    const meta = await win.webContents.executeJavaScript(
      `window.__core.invoke('plugin:updater|check', {})`
    );
    check('check() sees the newer feed version', meta && meta.version === '99.0.0', JSON.stringify(meta));
    check('check() maps releaseNotes to body', meta && meta.body === 'mock notes for updater harness');
    check(
      'check() carries currentVersion + a rid',
      meta && typeof meta.currentVersion === 'string' && meta.currentVersion.length > 0 && typeof meta.rid === 'number',
      JSON.stringify(meta)
    );

    // ── 3) download_and_install via a REAL renderer Channel ──
    const dl = await win.webContents.executeJavaScript(`(async () => {
      const core = window.__core;
      const events = [];
      const ch = new core.Channel();
      ch.onmessage = (m) => events.push(m);
      await core.invoke('plugin:updater|download_and_install', { onEvent: ch, rid: ${meta.rid} });
      // Give the last already-queued callback IPC a beat to arrive.
      await new Promise((r) => setTimeout(r, 150));
      return events;
    })()`);
    const started = dl.filter((e) => e.event === 'Started');
    const progress = dl.filter((e) => e.event === 'Progress');
    const finished = dl.filter((e) => e.event === 'Finished');
    check('download stream starts with Started', dl.length > 0 && dl[0].event === 'Started', JSON.stringify(dl[0]));
    check(
      'Started carries the artifact contentLength',
      started.length === 1 && started[0].data && started[0].data.contentLength === zipBytes.length,
      JSON.stringify(started)
    );
    const progressSum = progress.reduce((s, e) => s + (e.data ? e.data.chunkLength : 0), 0);
    check(
      'Progress chunkLengths sum to the artifact size',
      progress.length >= 1 && progressSum === zipBytes.length,
      `events=${progress.length} sum=${progressSum} expected=${zipBytes.length}`
    );
    check('stream ends with Finished', finished.length === 1 && dl[dl.length - 1].event === 'Finished', JSON.stringify(dl.map((e) => e.event)));

    // ── 4) restart wiring: a successful download leaves an install pending ──
    // (quitAndInstallIfPending itself is NOT driven here — it marks the
    // quitting guard and calls the real quitAndInstall, which needs a signed
    // build to complete; asserting the pending flag exercises the state
    // machine that decides whether restart takes the install path.)
    const { hasPendingInstall } = require('../updaterHost.cjs');
    check('a successful download leaves an install pending', hasPendingInstall() === true);

    // ── 5) corrupted feed (wrong sha512) → download rejects ──
    feedVersion = '99.0.1';
    feedSha512 = crypto.createHash('sha512').update(Buffer.from('not the artifact')).digest('base64');
    const badMeta = await win.webContents.executeJavaScript(
      `window.__core.invoke('plugin:updater|check', {})`
    );
    check('check() sees the corrupted-feed version', badMeta && badMeta.version === '99.0.1', JSON.stringify(badMeta));
    const rejected = await win.webContents.executeJavaScript(`(async () => {
      try {
        await window.__core.invoke('plugin:updater|download_and_install', { onEvent: new window.__core.Channel(), rid: ${badMeta ? badMeta.rid : 0} });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: String(err) };
      }
    })()`);
    check('download_and_install rejects on sha512 mismatch', rejected.rejected === true, JSON.stringify(rejected));
    // The stale flag from the SUCCESSFUL v-mock download above must have been
    // cleared when the new (failed) download started — otherwise restart
    // would quitAndInstall against torn-down squirrel state (review finding).
    check('a failed download clears the earlier pending install', hasPendingInstall() === false);
  } catch (err) {
    check('harness threw', false, err && err.stack ? err.stack : String(err));
  } finally {
    if (server) server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(scratchHtml, { force: true });
    // electron-updater's download cache resolves from os.homedir() (AppAdapter
    // getAppCacheDir), NOT app.getPath('appData') — the tmp redirect above
    // doesn't cover it. Remove the dev-cache dir (name set by updaterHost's
    // dev config) so harness runs don't pollute the real ~/Library/Caches.
    const cacheBase =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches')
        : process.platform === 'win32'
          ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
          : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    fs.rmSync(path.join(cacheBase, 'abu-updater-dev-cache'), { recursive: true, force: true });
  }

  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.pass ? `\n      ${r.detail}` : ''}`);
    if (r.pass) pass++;
  }
  console.log(`[updaterVerify] ${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
});
