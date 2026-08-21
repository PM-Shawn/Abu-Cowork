#!/usr/bin/env node

/**
 * Guard: the browser packages ship as build artifacts, and the app loads the
 * artifacts, not the sources.
 *
 *   abu-chrome-extension/src        → abu-chrome-extension/dist/content.js
 *                                     (the extension AND, injected into an
 *                                      isolated world, the built-in browser)
 *   abu-browser-bridge/src/tools.ts → electron/browser-runtime/dist/server.mjs
 *                                     electron/chrome-bridge-runtime/dist/server.mjs
 *
 * Editing a source without rebuilding leaves the running app on the old code.
 * That is not hypothetical: a round of this work shipped a tool-description
 * change that never reached either runtime bundle, so the model kept seeing
 * the old description and a tester spent an evening reproducing a bug that
 * had already been "fixed". Newest-source-vs-artifact mtime catches it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every artifact, with the sources it is built from and how to rebuild it. */
const ARTIFACTS = [
  {
    artifact: 'abu-chrome-extension/dist/content.js',
    sources: ['abu-chrome-extension/src', 'abu-browser-shared/types.ts'],
    rebuild: 'npm run build:browser-extension',
  },
  {
    artifact: 'electron/browser-runtime/dist/server.mjs',
    sources: ['abu-browser-bridge/src', 'electron/browser-runtime/server.ts'],
    rebuild: 'npm run build:electron-browser-runtime',
  },
  {
    artifact: 'electron/chrome-bridge-runtime/dist/server.mjs',
    sources: ['abu-browser-bridge/src'],
    rebuild: 'npm run build:electron-browser-runtime',
  },
];

/** Tests are not bundled, so touching one must not read as a stale artifact. */
function isBundledSource(name) {
  return !name.endsWith('.test.ts') && !name.endsWith('.test.tsx');
}

/** Newest mtime under a file or directory, skipping build output and tests. */
function newestMtime(relative) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    return isBundledSource(relative) ? { mtime: stat.mtimeMs, file: relative } : null;
  }

  let newest = null;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    if (entry.isFile() && !isBundledSource(entry.name)) continue;
    const child = newestMtime(path.join(relative, entry.name));
    if (child && (!newest || child.mtime > newest.mtime)) newest = child;
  }
  return newest;
}

const stale = [];
const missing = [];

for (const { artifact, sources, rebuild } of ARTIFACTS) {
  const artifactPath = path.join(ROOT, artifact);
  if (!fs.existsSync(artifactPath)) {
    missing.push({ artifact, rebuild });
    continue;
  }
  const artifactMtime = fs.statSync(artifactPath).mtimeMs;
  for (const source of sources) {
    const newest = newestMtime(source);
    if (newest && newest.mtime > artifactMtime) {
      stale.push({ artifact, source: newest.file, rebuild });
      break;
    }
  }
}

if (missing.length === 0 && stale.length === 0) {
  console.log('[check-browser-artifacts] browser artifacts are up to date');
  process.exit(0);
}

for (const { artifact, rebuild } of missing) {
  console.error(`[check-browser-artifacts] MISSING ${artifact}\n  build it with: ${rebuild}`);
}
for (const { artifact, source, rebuild } of stale) {
  console.error(
    `[check-browser-artifacts] STALE ${artifact}\n` +
    `  ${source} is newer than the artifact the app actually loads.\n` +
    `  rebuild with: ${rebuild}`,
  );
}
process.exit(1);
