/**
 * L5 W0 — is Abu's own Computer Use chrome absent from the helper's frames?
 *
 * The overlay border and the stop button are created with
 * `setContentProtection(true)`, which on Windows 10 2004+ maps to
 * `WDA_EXCLUDEFROMCAPTURE`. The native helper captures the monitor with
 * Windows Graphics Capture, and the whole design of the virtual cursor and
 * status strip (research note 12-l5-presentation-layer-brief.md) rests on
 * that chrome never appearing in what the model sees. This measures it.
 *
 * Three captures of the primary monitor through the real helper binary:
 *   A  no chrome                     baseline
 *   B  chrome shown, protected       must match A along the border band
 *   C  chrome shown, protection OFF  must differ — proves B was a real test
 *
 * Prints aggregates only (pixel counts and ratios); no pixels, no window
 * titles, nothing typed. The border is on screen for about three seconds.
 * No input is synthesized.
 *
 * Run: npx electron electron/spike/windowsOverlayCaptureVerify.cjs
 * Exit code 0 = PASS, 1 = FAIL, 2 = could not run.
 */
'use strict';
const { app, BrowserWindow, nativeImage, screen, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { guiDispatch } = require('../guiHost.cjs');
const { registerTauriHost } = require('../tauriHost.cjs');

const HELPER = path.resolve(__dirname, '../native-helper/target/release/native-helper.exe');
const BAND_PX = 8;          // physical pixels sampled along the top and left edges
const CHANGE_THRESHOLD = 24; // per-channel |delta| that counts as a changed pixel
const REQUEST_TIMEOUT_MS = 15_000;

app.on('window-all-closed', () => { /* explicit exit below */ });

function startHelper() {
  const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue; // events
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${msg.error.code ?? 'error'}: ${msg.error.message ?? String(msg.error)}`));
      else entry.resolve(msg.result);
    }
  });
  child.stderr.on('data', () => { /* helper diagnostics are not part of the verdict */ });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { child, request };
}

function frameHash(bitmap) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < bitmap.length; i += 97) { h ^= BigInt(bitmap[i]); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16);
}

const captureLog = [];
async function captureMonitor(helper) {
  const started = Date.now();
  const result = await helper.request('capture_screen', {});
  const image = nativeImage.createFromBuffer(Buffer.from(result.base64, 'base64'));
  const size = image.getSize();
  const bitmap = image.toBitmap();
  captureLog.push({ ms: Date.now() - started, revision: result.snapshot_revision, hash: frameHash(bitmap), origin: [result.origin_x, result.origin_y], size: [size.width, size.height] });
  return {
    bitmap, // BGRA, size.width * size.height * 4
    width: size.width,
    height: size.height,
    scale: result.scale_factor,
    monitor: result.monitor_id,
  };
}

/** Compare two frames along the top and left edge bands. */
function bandDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, reason: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const rows = Math.min(BAND_PX, a.height);
  const cols = Math.min(BAND_PX, a.width);
  let pixels = 0;
  let changed = 0;
  let maxDelta = 0;
  const visit = (x, y) => {
    const offset = (y * a.width + x) * 4;
    let delta = 0;
    for (let c = 0; c < 3; c += 1) {
      delta = Math.max(delta, Math.abs(a.bitmap[offset + c] - b.bitmap[offset + c]));
    }
    pixels += 1;
    if (delta > CHANGE_THRESHOLD) changed += 1;
    if (delta > maxDelta) maxDelta = delta;
  };
  for (let y = 0; y < rows; y += 1) for (let x = 0; x < a.width; x += 1) visit(x, y);
  for (let y = rows; y < a.height; y += 1) for (let x = 0; x < cols; x += 1) visit(x, y);
  return { comparable: true, pixels, changed, changedRatio: Number((changed / pixels).toFixed(4)), maxDelta };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}

app.whenReady().then(async () => {
  const report = { platform: process.platform, electron: process.versions.electron };
  let exitCode = 2;
  let helper = null;
  try {
    if (process.platform !== 'win32') throw new Error('Windows only');
    registerTauriHost(app); // the chrome pages' preload talks to it, as in production
    helper = startHelper();
    const hello = await helper.request('hello', {});
    report.driver = hello?.capabilities?.driver?.id ?? null;
    report.dpiAwareness = hello?.capabilities?.driver?.capture?.dpi_awareness ?? null;

    const a = await captureMonitor(helper);
    report.frame = { width: a.width, height: a.height, scale: a.scale, monitor: a.monitor };
    report.displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id }));

    await guiDispatch(app, 'show_screen_border', { stopLabel: 'Stop' });
    await sleep(2500); // ready-to-show + a breath of the border animation
    report.chromeWindows = await Promise.all(chromeWindows().map(async (win) => {
      const bounds = win.getBounds();
      const page = await win.webContents.capturePage().catch(() => null);
      let paintedPixels = null;
      if (page) {
        const bmp = page.toBitmap();
        const size = page.getSize();
        let painted = 0;
        for (let i = 3; i < bmp.length; i += 4) if (bmp[i] > 16) painted += 1;
        paintedPixels = { painted, total: size.width * size.height };
      }
      return {
        visible: win.isVisible(),
        loading: win.webContents.isLoading(),
        page: path.basename(win.webContents.getURL().split('?')[0]),
        bounds,
        paintedPixels,
      };
    }));
    const b = await captureMonitor(helper);
    report.protectedVsBaseline = bandDiff(a, b);

    for (const win of chromeWindows()) win.setContentProtection(false);
    await sleep(1200);
    const c = await captureMonitor(helper);
    report.unprotectedVsBaseline = bandDiff(a, c);
    for (const win of chromeWindows()) win.setContentProtection(true);

    // Control probes: does ANY fresh window reach the helper frame? D is an
    // opaque bar, E a layered (transparent) one, both unprotected.
    const probe = async (label, opts) => {
      const win = new BrowserWindow({
        x: 0, y: 0, width: a.width, height: 24, frame: false, alwaysOnTop: true,
        focusable: false, skipTaskbar: true, show: false, ...opts,
      });
      await win.loadURL('data:text/html,<body style="margin:0;background:%23ff2020;height:24px"></body>');
      win.show();
      await sleep(1200);
      const frame = await captureMonitor(helper);
      report[label] = bandDiff(a, frame);
      // Where did the red bar land, if anywhere? Bounding box of strongly red pixels.
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
      for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
        const o = (y * frame.width + x) * 4; // BGRA
        if (frame.bitmap[o + 2] > 200 && frame.bitmap[o + 1] < 70 && frame.bitmap[o] < 70) {
          count += 1; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
      report[label].redPixels = count ? { count, box: [minX, minY, maxX, maxY] } : { count: 0 };
      // Same moment, Chromium's own screen capture: is the bar there?
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: frame.width, height: frame.height } });
      const thumb = sources[0]?.thumbnail;
      if (thumb) {
        const tb = thumb.toBitmap(); const ts = thumb.getSize(); let red = 0;
        for (let y = 0; y < Math.min(24, ts.height); y += 1) for (let x = 0; x < ts.width; x += 1) {
          const o = (y * ts.width + x) * 4; if (tb[o + 2] > 200 && tb[o + 1] < 70 && tb[o] < 70) red += 1;
        }
        report[label].chromiumTopBandRed = { red, of: Math.min(24, ts.height) * ts.width, size: [ts.width, ts.height] };
      }
      // What changed anywhere between baseline and this capture (bounding box)?
      let cx0 = Infinity, cy0 = Infinity, cx1 = -1, cy1 = -1, changedAll = 0;
      for (let y = 0; y < frame.height; y += 2) for (let x = 0; x < frame.width; x += 2) {
        const o = (y * frame.width + x) * 4; let d = 0;
        for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(a.bitmap[o + c] - frame.bitmap[o + c]));
        if (d > CHANGE_THRESHOLD) { changedAll += 1; if (x < cx0) cx0 = x; if (y < cy0) cy0 = y; if (x > cx1) cx1 = x; if (y > cy1) cy1 = y; }
      }
      report[label].changedAnywhere = changedAll ? { sampled: changedAll, box: [cx0, cy0, cx1, cy1] } : { sampled: 0 };
      win.destroy();
      await sleep(300);
    };
    await probe('opaqueProbeVsBaseline', { backgroundColor: '#ff2020' });
    await probe('layeredProbeVsBaseline', { transparent: true });

    const excluded = report.protectedVsBaseline.comparable && report.protectedVsBaseline.changedRatio < 0.05;
    const wouldShow = report.unprotectedVsBaseline.comparable && report.unprotectedVsBaseline.changedRatio > 0.3;
    report.verdict = excluded && wouldShow
      ? 'PASS'
      : !wouldShow
        ? 'INCONCLUSIVE (unprotected chrome did not show up either — band/timing problem)'
        : 'FAIL (protected chrome is visible in the helper frame)';
    exitCode = report.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    try { await guiDispatch(app, 'hide_screen_border', {}); } catch { /* best effort */ }
    if (helper) helper.child.kill();
    report.captures = captureLog;
    console.log(JSON.stringify(report, null, 2));
    app.exit(exitCode);
  }
});
