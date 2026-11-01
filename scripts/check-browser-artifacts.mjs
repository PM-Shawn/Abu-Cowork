#!/usr/bin/env node

/**
 * Guard: the browser packages ship as build artifacts, and the app loads the
 * artifacts, not the sources.
 *
 *   abu-chrome-extension/           → abu-chrome-extension/dist/
 *                                     src-tauri/browser-extension/
 *   abu-browser-bridge/src/tools.ts → electron/browser-runtime/dist/server.mjs
 *                                     electron/browser-runtime/dist/queryJsWorker.mjs
 *                                     electron/chrome-bridge-runtime/dist/server.mjs
 *                                     electron/chrome-bridge-runtime/dist/queryJsWorker.mjs
 *
 * Source and output digests bind every artifact to the completed build.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXTENSION_FILES = [
  'background.js', 'background.js.map', 'content.js', 'content.js.map',
  'offscreen.js', 'offscreen.js.map', 'popup.js', 'popup.js.map',
  'manifest.json', 'popup.html', 'offscreen.html',
];
const EXTENSION_SOURCES = [
  'abu-chrome-extension/src', 'abu-browser-shared/types.ts',
  'abu-chrome-extension/manifest.json', 'abu-chrome-extension/package.json',
  'abu-chrome-extension/package-lock.json', 'abu-chrome-extension/build.js',
];

/** Every artifact, with the sources it is built from and how to rebuild it. */
export const ARTIFACTS = [
  ...['abu-chrome-extension/dist', 'src-tauri/browser-extension'].flatMap(directory =>
    EXTENSION_FILES.map(file => ({
      artifact: `${directory}/${file}`,
      sources: EXTENSION_SOURCES,
      rebuild: directory === 'abu-chrome-extension/dist'
        ? 'npm run build:browser-extension'
        : 'npm run build:browser-extension && npm run copy-resources',
    }))),
  {
    artifact: 'electron/browser-runtime/dist/server.mjs',
    sources: ['abu-browser-bridge/src', 'electron/browser-runtime/server.ts'],
    rebuild: 'npm run build:electron-browser-runtime',
  },
  {
    artifact: 'electron/browser-runtime/dist/queryJsWorker.mjs',
    sources: [
      'abu-browser-bridge/src/queryJsWorker.mjs',
      'package-lock.json',
      'scripts/build-electron-browser-runtime.mjs',
    ],
    rebuild: 'npm run build:electron-browser-runtime',
  },
  {
    artifact: 'electron/chrome-bridge-runtime/dist/server.mjs',
    sources: ['abu-browser-bridge/src'],
    rebuild: 'npm run build:electron-browser-runtime',
  },
  {
    artifact: 'electron/chrome-bridge-runtime/dist/queryJsWorker.mjs',
    sources: [
      'abu-browser-bridge/src/queryJsWorker.mjs',
      'package-lock.json',
      'scripts/build-electron-chrome-bridge-runtime.mjs',
    ],
    rebuild: 'npm run build:electron-browser-runtime',
  },
];

/** Tests are not bundled, so touching one must not read as a stale artifact. */
function isBundledSource(name) {
  return !name.endsWith('.test.ts') && !name.endsWith('.test.tsx');
}

/** Every bundled source file under a path, sorted for a stable digest. */
function sourceFiles(relative, out = []) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return out;
  if (fs.statSync(absolute).isFile()) {
    if (isBundledSource(relative)) out.push(relative);
    return out;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    sourceFiles(path.join(relative, entry.name), out);
  }
  return out;
}

/**
 * Digest of the sources an artifact is built from.
 *
 * Content, not mtime: git rewrites files on stash, checkout and rebase, so an
 * mtime comparison reports a rebuild is needed after operations that changed
 * nothing. This check exists to catch a real omission — it has to stay quiet
 * otherwise, or it trains people to ignore it.
 */
export function sourceDigest(sources) {
  const hash = createHash('sha256');
  for (const source of sources.flatMap((s) => sourceFiles(s))) {
    hash.update(source);
    hash.update(fs.readFileSync(path.join(ROOT, source)));
  }
  return hash.digest('hex');
}

/**
 * Where an artifact's source digest is recorded.
 *
 * Deliberately not beside the artifact: `src-tauri/browser-extension/` is
 * tracked in git and CI diffs it against a fresh build of
 * `abu-chrome-extension/dist/`, so a stamp inside either directory would
 * either have to be committed as a generated file or show up as drift.
 */
const STAMP_DIR = path.join(ROOT, '.artifact-digests');

export function stampPathFor(artifact) {
  return path.join(STAMP_DIR, `${artifact.replace(/[/\\]/g, '__')}.sources`);
}

/** Called by the build scripts once they have written an artifact. */
export function recordSourceDigest(artifact) {
  const entry = ARTIFACTS.find((a) => a.artifact === artifact);
  if (!entry) throw new Error(`no artifact entry for ${artifact}`);
  fs.mkdirSync(STAMP_DIR, { recursive: true });
  fs.writeFileSync(stampPathFor(artifact), `${buildDigest(entry)}\n`);
}

function buildDigest(entry) {
  return JSON.stringify({
    sources: sourceDigest(entry.sources),
    artifact: createHash('sha256').update(fs.readFileSync(path.join(ROOT, entry.artifact))).digest('hex'),
  });
}

export function recordExtensionDigests(directory) {
  for (const file of EXTENSION_FILES) recordSourceDigest(`${directory}/${file}`);
}

export function assertExtensionDigests(directory) {
  for (const file of EXTENSION_FILES) {
    const artifact = `${directory}/${file}`;
    const entry = ARTIFACTS.find(candidate => candidate.artifact === artifact);
    if (!entry) throw new Error(`no artifact entry for ${artifact}`);
    const stamp = stampPathFor(artifact);
    if (!fs.existsSync(path.join(ROOT, artifact)) || !fs.existsSync(stamp)
      || fs.readFileSync(stamp, 'utf8').trim() !== buildDigest(entry)) {
      throw new Error(`Unverified browser artifact ${artifact}. Rebuild with: ${entry.rebuild}`);
    }
  }
}

/** Running as a script? Only then does it check and exit. */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) {
  // Imported for `recordSourceDigest` — do not run the check or exit.
} else {

const stale = [];
const missing = [];

for (const { artifact, sources, rebuild } of ARTIFACTS) {
  const artifactPath = path.join(ROOT, artifact);
  const stampPath = stampPathFor(artifact);
  if (!fs.existsSync(artifactPath)) {
    missing.push({ artifact, rebuild });
    continue;
  }
  const expected = buildDigest({ artifact, sources });
  const recorded = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : null;
  if (recorded !== expected) {
    stale.push({ artifact, rebuild, recorded, expected });
  }
}

if (missing.length === 0 && stale.length === 0) {
  console.log('[check-browser-artifacts] browser artifacts are up to date');
  process.exit(0);
}

for (const { artifact, rebuild } of missing) {
  console.error(`[check-browser-artifacts] MISSING ${artifact}\n  build it with: ${rebuild}`);
}
for (const { artifact, rebuild, recorded } of stale) {
  console.error(
    `[check-browser-artifacts] STALE ${artifact}\n` +
    `  ${recorded === null ? 'no build digest recorded for' : 'the sources or output no longer match'} the artifact the app actually loads.\n` +
    `  rebuild with: ${rebuild}`,
  );
}
process.exit(1);
}
