#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TAR = '/usr/bin/tar';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const REQUIRED_BUNDLE_ID = 'com.abu.app';

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(
      `${path.basename(command)} exited ${result.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return options.capture ? result.stdout.trim() : '';
}

function plistValue(appPath, key) {
  return runChecked(
    PLIST_BUDDY,
    ['-c', `Print :${key}`, path.join(appPath, 'Contents', 'Info.plist')],
    { capture: true }
  );
}

export function validateArchiveEntries(entries, rootName = 'Abu.app') {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('transition archive is empty');
  }
  let hasInfoPlist = false;
  let hasExecutable = false;

  for (const rawEntry of entries) {
    const entry = String(rawEntry).replace(/\/$/, '');
    if (!entry || entry.startsWith('/')) {
      throw new Error(`unsafe transition archive entry: ${rawEntry}`);
    }
    const segments = entry.split('/');
    if (
      segments[0] !== rootName ||
      segments.some((segment) => !segment || segment === '.' || segment === '..') ||
      segments.some((segment) => segment === '__MACOSX' || segment.startsWith('._'))
    ) {
      throw new Error(`unexpected transition archive entry: ${rawEntry}`);
    }
    if (entry === `${rootName}/Contents/Info.plist`) hasInfoPlist = true;
    if (entry.startsWith(`${rootName}/Contents/MacOS/`) && segments.length === 4) {
      hasExecutable = true;
    }
  }

  if (!hasInfoPlist) throw new Error('transition archive is missing Contents/Info.plist');
  if (!hasExecutable) throw new Error('transition archive is missing Contents/MacOS executable');
  return { rootName, entryCount: entries.length };
}

export function listArchiveEntries(archivePath) {
  const listing = runChecked(TAR, ['-tzf', archivePath], { capture: true });
  return listing.split(/\r?\n/).filter(Boolean);
}

export function extractArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  runChecked(TAR, ['-xzf', archivePath, '-C', destination]);
}

export function packAppArchive(appPath, outputPath) {
  const resolvedApp = fs.realpathSync(appPath);
  if (!fs.statSync(resolvedApp).isDirectory() || path.basename(resolvedApp) !== 'Abu.app') {
    throw new Error('transition source must be a directory named Abu.app');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });
  runChecked(
    TAR,
    [
      '-czf',
      outputPath,
      '--format',
      'pax',
      '--no-xattrs',
      '--no-mac-metadata',
      '-C',
      path.dirname(resolvedApp),
      path.basename(resolvedApp),
    ],
    {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    }
  );
  return validateArchiveEntries(listArchiveEntries(outputPath));
}

export function verifyMacAppBundle(appPath, options = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS transition bundles can only be verified on macOS');
  }
  const bundleId = plistValue(appPath, 'CFBundleIdentifier');
  const version = plistValue(appPath, 'CFBundleShortVersionString');
  const executableName = plistValue(appPath, 'CFBundleExecutable');
  if (bundleId !== REQUIRED_BUNDLE_ID) {
    throw new Error(`unexpected bundle id ${bundleId}; expected ${REQUIRED_BUNDLE_ID}`);
  }
  if (options.version && version !== options.version) {
    throw new Error(`unexpected bundle version ${version}; expected ${options.version}`);
  }
  if (!executableName || executableName.includes('/') || executableName.includes('\\')) {
    throw new Error(`invalid CFBundleExecutable: ${executableName}`);
  }

  const executablePath = path.join(appPath, 'Contents', 'MacOS', executableName);
  fs.accessSync(executablePath, fs.constants.X_OK);
  if (options.arch) {
    const architectures = runChecked('/usr/bin/lipo', ['-archs', executablePath], {
      capture: true,
    }).split(/\s+/);
    if (!architectures.includes(options.arch)) {
      throw new Error(
        `bundle executable is missing ${options.arch}; found ${architectures.join(', ')}`
      );
    }
  }

  runChecked('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  runChecked('/usr/sbin/spctl', ['-a', '-vvv', '--type', 'execute', appPath]);
  runChecked('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  return { bundleId, version, executableName };
}

export function createVerifiedTransitionArchive({ appPath, outputPath, version, arch }) {
  const source = fs.realpathSync(appPath);
  const before = verifyMacAppBundle(source, { version, arch });
  const archive = packAppArchive(source, outputPath);
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-verify-'));
  try {
    extractArchive(outputPath, extractionRoot);
    const extractedApp = path.join(extractionRoot, 'Abu.app');
    const after = verifyMacAppBundle(extractedApp, { version, arch });
    return {
      outputPath: path.resolve(outputPath),
      archive,
      source: before,
      extracted: after,
    };
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    result[key.slice(2)] = value;
  }
  if (!result.app || !result.out) {
    throw new Error(
      'usage: electron-tauri-transition.mjs --app <Abu.app> --out <archive> [--version <version>] [--arch <arch>]'
    );
  }
  return result;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = createVerifiedTransitionArchive({
      appPath: args.app,
      outputPath: args.out,
      version: args.version,
      arch: args.arch,
    });
    process.stdout.write(
      `Verified Tauri transition archive: ${result.outputPath} (${result.archive.entryCount} entries)\n`
    );
  } catch (err) {
    process.stderr.write(
      `Transition archive failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  }
}
