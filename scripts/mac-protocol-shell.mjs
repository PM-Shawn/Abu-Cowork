import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const scheme = 'abu-dev';

export function devBundleId(root, realpath = nodeFs.realpathSync) {
  // Different checkouts must not share a LaunchServices identity.
  const suffix = createHash('sha256').update(realpath(root)).digest('hex').slice(0, 12);
  return `com.abu.cowork.dev.${suffix}`;
}

export function replaceDevShell(app, stagedApp, fileSystem = nodeFs) {
  const backup = path.join(path.dirname(stagedApp), 'previous.app');
  const hadPrevious = fileSystem.existsSync(app);
  if (hadPrevious) fileSystem.renameSync(app, backup);
  try {
    fileSystem.renameSync(stagedApp, app);
  } catch (error) {
    if (hadPrevious) {
      try {
        fileSystem.renameSync(backup, app);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `Dev shell replacement failed; previous shell retained at ${backup}`);
      }
    }
    throw error;
  }
  if (hadPrevious) fileSystem.rmSync(backup, { recursive: true });
}

export function prepareMacProtocolShell(root = repoRoot, run = execFileSync, fileSystem = nodeFs) {
  const source = path.join(root, 'node_modules/electron/dist/Electron.app');
  if (!fileSystem.existsSync(source)) throw new Error('Electron.app is missing; run npm run setup:electron-dev first.');
  const directory = path.join(root, '.dev-shell');
  const app = path.join(directory, 'Electron.app');
  const marker = path.join(directory, 'identity.json');
  const bundleId = devBundleId(root, fileSystem.realpathSync);
  const version = JSON.parse(fileSystem.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
  const identity = JSON.stringify({ version, arch: process.arch, bundleId, scheme, revision: 1 });
  const binary = path.join(app, 'Contents/MacOS/Electron');
  const output = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const diagnostic = { stdio: ['ignore', 'ignore', 'inherit'] };

  // Never replace a redirected directory, or delete anything outside this cache.
  for (const target of [directory, app]) {
    if (fileSystem.existsSync(target) && fileSystem.lstatSync(target).isSymbolicLink()) {
      throw new Error(`Dev shell cache must not be a symlink: ${target}`);
    }
  }

  function ready() {
    try {
      if (!fileSystem.existsSync(binary) || fileSystem.readFileSync(marker, 'utf8') !== identity) return false;
      const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], output));
      if (plist.CFBundleIdentifier !== bundleId) return false;
      const types = plist.CFBundleURLTypes;
      if (types?.length !== 1 || types[0].CFBundleURLSchemes?.length !== 1 || types[0].CFBundleURLSchemes[0] !== scheme) return false;
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], output);
      return true;
    } catch {
      return false;
    }
  }

  fileSystem.mkdirSync(directory, { recursive: true });
  if (!ready()) {
    console.error(`[dev-shell] Preparing Electron ${version} (${bundleId})`);
    const staging = fileSystem.mkdtempSync(path.join(directory, 'build-'));
    const stagedApp = path.join(staging, 'Electron.app');
    try {
      run('/usr/bin/ditto', [source, stagedApp], diagnostic);
      const plist = path.join(stagedApp, 'Contents/Info.plist');
      run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, plist], diagnostic);
      run('/usr/bin/plutil', ['-replace', 'CFBundleURLTypes', '-json', JSON.stringify([{
        CFBundleURLName: bundleId,
        CFBundleTypeRole: 'Viewer',
        CFBundleURLSchemes: [scheme],
      }]), plist], diagnostic);
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagedApp], diagnostic);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], diagnostic);
      replaceDevShell(app, stagedApp, fileSystem);
      fileSystem.writeFileSync(marker, identity);
    } finally {
      // A failed rollback leaves the previous shell here for recovery.
      if (!fileSystem.existsSync(path.join(staging, 'previous.app'))) {
        fileSystem.rmSync(staging, { recursive: true, force: true });
      }
    }
  }

  // Re-register on every launch, but do not re-sign a valid shell: its stable
  // code identity avoids repeated Keychain ACL prompts. Fail if LS disagrees.
  run(lsregister, ['-f', app], diagnostic);
  run('/usr/bin/xcrun', [
    'swift',
    path.join(repoRoot, 'scripts/register-dev-protocol.swift'),
    scheme,
    bundleId,
    app,
  ], diagnostic);
  return binary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('This helper is macOS-only.');
  // stdout is deliberately just the executable path.
  console.log(prepareMacProtocolShell());
}
