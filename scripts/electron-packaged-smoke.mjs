/**
 * Packaged-build smoke test (F12, first packaging slice).
 *
 * Launches the ACTUAL electron-builder output (an unsigned, unpacked app under
 * release-electron/) via Playwright-for-Electron and asserts the packaging
 * wiring is correct end-to-end — the thing a `--dir` build can prove without a
 * signing certificate:
 *   1. The packaged app launches and opens a window (no boot crash — which also
 *      transitively proves node-pty, required at boot by tauriHost→ptyHost,
 *      loads under the packaged Electron ABI).
 *   2. It reports app.isPackaged === true (we're testing the real bundle, not
 *      a dev `electron .`).
 *   3. The bundled resources resolve under process.resourcesPath: sidecar
 *      bundle, builtin-skills, and the native-helper binary all exist there —
 *      i.e. extraResources landed where appEnv.cjs / tauriHost.cjs
 *      (BaseDirectory.Resource) / nativeHelperManager.cjs now look when packaged.
 *   4. The REAL frontend rendered (React mounted into #root), not the
 *      placeholder page — i.e. dist-electron-spike was bundled and loads.
 *
 * Run: npm run smoke:electron:packaged   (after `npm run pack:electron`)
 *
 * NOT covered (documented, needs signing/real user flow): a full sidecar agent
 * round-trip (needs an API key + a user message), signed-install behavior,
 * auto-update, and cross-arch native rebuilds — later slices.
 */
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'release-electron';

/** Locate the packaged binary + its Resources dir across mac/win/linux --dir outputs. */
function findPackagedApp() {
  const macArches = ['mac-arm64', 'mac', 'mac-x64', 'mac-universal'];
  for (const a of macArches) {
    const appDir = path.join(OUT, a, 'Abu.app');
    const bin = path.join(appDir, 'Contents', 'MacOS', 'Abu');
    if (fs.existsSync(bin)) {
      return { bin, resources: path.join(appDir, 'Contents', 'Resources') };
    }
  }
  // linux --dir
  for (const name of ['abu', 'Abu']) {
    const bin = path.join(OUT, 'linux-unpacked', name);
    if (fs.existsSync(bin)) {
      return { bin, resources: path.join(OUT, 'linux-unpacked', 'resources') };
    }
  }
  // win --dir
  const winBin = path.join(OUT, 'win-unpacked', 'Abu.exe');
  if (fs.existsSync(winBin)) {
    return { bin: winBin, resources: path.join(OUT, 'win-unpacked', 'resources') };
  }
  return null;
}

async function main() {
  const found = findPackagedApp();
  if (!found) {
    console.error(
      `[packaged-smoke] no packaged app found under ${OUT}/ — run \`npm run pack:electron\` first`
    );
    process.exit(1);
  }
  console.log(`[packaged-smoke] launching ${found.bin}`);

  const checks = {};
  const errors = {};

  const app = await electron.launch({ executablePath: found.bin, args: [] });
  try {
    const window = await app.firstWindow({ timeout: 30_000 });
    checks.windowOpened = !!window;
    await window.waitForLoadState('domcontentloaded', { timeout: 30_000 });

    // ── main-process assertion: we launched the REAL packaged bundle ──
    // (Keep this evaluate trivial — Playwright's eval scope has no `require`, so
    // do filesystem checks below from the test process instead.)
    const isPackaged = await app.evaluate(({ app: a }) => a.isPackaged);
    checks.isPackaged = isPackaged === true;

    // ── bundled resources landed under Contents/Resources ── (checked locally)
    checks.sidecarInResources = fs.existsSync(path.join(found.resources, 'sidecar', 'index.mjs'));
    checks.skillsInResources = fs.existsSync(path.join(found.resources, 'builtin-skills'));
    checks.helperInResources = fs.existsSync(
      path.join(found.resources, 'native-helper', 'native-helper')
    );

    // ── renderer assertion: real frontend mounted (not the placeholder) ──
    try {
      await window.waitForFunction(
        () => {
          const root = document.querySelector('#root');
          return !!root && root.children.length > 0;
        },
        { timeout: 20_000 }
      );
      checks.realFrontendRendered = true;
    } catch (err) {
      checks.realFrontendRendered = false;
      errors.frontend = String(err);
    }
  } catch (err) {
    errors.launch = String(err);
  } finally {
    await app.close();
  }

  const passed =
    Object.values(checks).length > 0 &&
    Object.values(checks).every(Boolean) &&
    Object.keys(errors).length === 0;
  console.log('[packaged-smoke] checks = ' + JSON.stringify(checks, null, 2));
  if (Object.keys(errors).length) {
    console.log('[packaged-smoke] errors = ' + JSON.stringify(errors, null, 2));
  }
  console.log('[packaged-smoke] PASSED = ' + passed);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[packaged-smoke] fatal', err);
  process.exit(1);
});
