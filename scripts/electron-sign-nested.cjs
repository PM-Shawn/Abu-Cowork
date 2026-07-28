/**
 * electron-builder afterPack hook — deep-sign nested Mach-O binaries that
 * electron-builder's own signing pass does not cover, then retain a pre-fuse
 * clone for packaged automation.
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
 * Nested signing is a no-op when the build is unsigned (identity: null / no
 * signing info). The automation clone is created for every builder invocation:
 * release CI runs the same smoke after `dist:electron`, not only after --dir.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

/** Dirs under Contents/Resources whose Mach-O contents we own and must sign. */
const NESTED_BINARY_DIRS = ['native-helper', 'sandbox-launcher', 'python-runtime', 'node-runtime'];
const RUNTIME_MARKERS = [
  { directory: 'node-runtime', executable: ['bin', 'node'], kind: 'node' },
  { directory: 'python-runtime', executable: ['bin', 'python3'], kind: 'python' },
];

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

function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function refreshRuntimeMarkers(resourcesDir) {
  for (const runtime of RUNTIME_MARKERS) {
    const root = path.join(resourcesDir, runtime.directory);
    const markerPath = path.join(root, '.abu-runtime.json');
    const executablePath = path.join(root, ...runtime.executable);
    if (!fs.existsSync(markerPath) || !fs.existsSync(executablePath)) {
      throw new Error(`signed ${runtime.kind} runtime is incomplete under ${root}`);
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.kind !== runtime.kind || typeof marker.executableSha256 !== 'string') {
      throw new Error(`invalid ${runtime.kind} runtime marker at ${markerPath}`);
    }
    marker.executableSha256 = sha256File(executablePath);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }
  console.log('[sign-nested] refreshed signed Node/Python runtime hashes');
}

function signNestedMacBinaries(context) {
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
  refreshRuntimeMarkers(resourcesDir);
  console.log(`[sign-nested] signed ${signed} nested Mach-O file(s) with "${identity}"`);
}

function copyDirectory(source, destination, platform) {
  fs.rmSync(destination, { force: true, recursive: true });
  let copied = false;
  if (platform === 'darwin') {
    copied = spawnSync('/bin/cp', ['-cR', source, destination], {
      encoding: 'utf8',
      timeout: 120_000,
    }).status === 0;
  } else if (platform === 'linux') {
    copied = spawnSync('/bin/cp', ['-a', '--reflink=auto', source, destination], {
      encoding: 'utf8',
      timeout: 120_000,
    }).status === 0;
  }
  if (!copied) {
    fs.rmSync(destination, { force: true, recursive: true });
    fs.cpSync(source, destination, {
      dereference: false,
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  signNestedMacBinaries(context);

  // Playwright's Electron driver needs the Node inspector, which the release
  // package deliberately disables. Retain the exact pre-fuse tree before
  // electron-builder hardens the real output. This is generated for both
  // `--dir` and distributable builds because release CI smokes the latter.
  const outputRoot = path.dirname(context.appOutDir);
  const e2eRoot = `${outputRoot}-e2e`;
  const destination = path.join(e2eRoot, path.basename(context.appOutDir));
  fs.mkdirSync(e2eRoot, { recursive: true });
  copyDirectory(context.appOutDir, destination, context.electronPlatformName);
  console.log(`[packaged-e2e-clone] copied pre-fuse package to ${destination}`);
};
