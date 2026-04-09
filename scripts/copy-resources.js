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
for (const name of ['builtin-skills', 'builtin-agents']) {
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

// Copy Chrome extension build output for bundling with the app
const extensionSrc = resolve(root, 'abu-chrome-extension', 'dist');
const extensionDest = resolve(dest, 'browser-extension');
if (existsSync(extensionSrc)) {
  if (existsSync(extensionDest)) {
    rmSync(extensionDest, { recursive: true });
  }
  cpSync(extensionSrc, extensionDest, { recursive: true });
  console.log('[copy-resources] Copied abu-chrome-extension/dist/ → src-tauri/browser-extension/');
} else {
  console.warn('[copy-resources] Warning: abu-chrome-extension/dist/ not found, skipping (run extension build first)');
}
