/**
 * Copy builtin-skills/ and builtin-agents/ into src-tauri/resources/
 * so that Tauri bundles them without the _up_/ prefix issue.
 *
 * Run via: npm run copy-resources
 */

import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dest = resolve(root, 'src-tauri');

// Clean previous copies
for (const name of ['builtin-skills', 'builtin-agents', 'sidecar']) {
  const target = resolve(dest, name);
  if (existsSync(target)) {
    rmSync(target, { recursive: true });
  }
}

const resources = ['builtin-skills', 'builtin-agents'];

for (const name of resources) {
  const src = resolve(root, name);
  if (!existsSync(src)) {
    console.warn(`[copy-resources] Warning: ${name}/ not found, skipping`);
    continue;
  }
  cpSync(src, resolve(dest, name), { recursive: true });
  console.log(`[copy-resources] Copied ${name}/ → src-tauri/${name}/`);
}

// Sidecar: copy ONLY the built bundle (sidecar/index.mjs, produced by
// `npm run build:sidecar` from sidecar/src/**), not the whole sidecar/
// directory — the source .ts files (and their .test.ts files) have no
// business being inside the packaged app's resources.
{
  const sidecarBundle = resolve(root, 'sidecar', 'index.mjs');
  if (!existsSync(sidecarBundle)) {
    console.warn('[copy-resources] Warning: sidecar/index.mjs not found — run `npm run build:sidecar` first, skipping');
  } else {
    const sidecarDestDir = resolve(dest, 'sidecar');
    mkdirSync(sidecarDestDir, { recursive: true });
    cpSync(sidecarBundle, resolve(sidecarDestDir, 'index.mjs'));
    console.log('[copy-resources] Copied sidecar/index.mjs → src-tauri/sidecar/index.mjs');
  }
}

// Copy Chrome extension build output for bundling with the app
const extensionSrc = resolve(root, 'abu-chrome-extension', 'dist');
const extensionDest = resolve(dest, 'browser-extension');
if (existsSync(extensionSrc)) {
  if (existsSync(extensionDest)) {
    rmSync(extensionDest, { recursive: true });
  }
  cpSync(extensionSrc, extensionDest, { recursive: true });
  // Stamp the copy too: CI diffs it against a fresh build, so a source edit
  // that skipped this step has to fail locally, not two pushes later.
  const { recordSourceDigest } = await import('./check-browser-artifacts.mjs');
  recordSourceDigest('src-tauri/browser-extension/content.js');
  console.log('[copy-resources] Copied abu-chrome-extension/dist/ → src-tauri/browser-extension/');
} else {
  console.warn('[copy-resources] Warning: abu-chrome-extension/dist/ not found, skipping (run extension build first)');
}
