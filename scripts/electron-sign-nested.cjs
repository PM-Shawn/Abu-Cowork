/**
 * electron-builder afterPack hook — deep-sign nested Mach-O binaries that
 * electron-builder's own signing pass does not cover: extraResources
 * (native-helper today; python/node runtimes when they're added).
 *
 * Why: notarization rejects ANY unsigned Mach-O inside the .app, and
 * electron-builder only signs the app bundle + asarUnpacked binaries — files
 * shipped via extraResources are copied verbatim. This mirrors the exact
 * deep-sign step the Tauri release CI performs on python-runtime/node-runtime
 * (.github/workflows/release.yml "Deep-signing embedded Mach-O binaries"),
 * with the same hardened-runtime + entitlements flags.
 *
 * Ordering: afterPack runs after files are laid out and BEFORE the outer app
 * signature — required, since signing a nested file after the outer seal
 * would invalidate it.
 *
 * No-op when the build is unsigned (identity: null / no signing info), so
 * `pack:electron` dev builds are unaffected.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/** Dirs under Contents/Resources whose Mach-O contents we own and must sign. */
const NESTED_BINARY_DIRS = ['native-helper', 'sandbox-launcher', 'python-runtime', 'node-runtime'];

function isMachO(filePath) {
  // Mach-O magics: feedface/feedfacf (+ swapped) and cafebabe (fat).
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) return false;
    const magic = buf.readUInt32BE(0);
    return (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe
    );
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else if (e.isFile()) yield p;
  }
}

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // Resolve the signing identity the same way the main pass will. When the
  // build is unsigned (mac.identity: null and no CSC env), skip entirely.
  const identity =
    context.packager.platformSpecificBuildOptions.identity || process.env.CSC_NAME || null;
  if (!identity) {
    console.log('[sign-nested] unsigned build — skipping nested Mach-O signing');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesDir = path.join(context.appOutDir, appName, 'Contents', 'Resources');
  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');
  const keychain = process.env.CSC_KEYCHAIN || null;

  let signed = 0;
  for (const dirName of NESTED_BINARY_DIRS) {
    const dir = path.join(resourcesDir, dirName);
    if (!fs.existsSync(dir)) continue;
    for (const f of walkFiles(dir)) {
      if (!isMachO(f)) continue;
      const args = [
        '--force',
        '--timestamp',
        '--options',
        'runtime',
        '--entitlements',
        entitlements,
        '--sign',
        identity,
      ];
      if (keychain) args.push('--keychain', keychain);
      args.push(f);
      execFileSync('codesign', args);
      signed++;
    }
  }
  console.log(`[sign-nested] signed ${signed} nested Mach-O file(s) with "${identity}"`);
};
