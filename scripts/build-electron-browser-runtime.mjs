#!/usr/bin/env node

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordSourceDigest } from './check-browser-artifacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function main() {
  await build({
    entryPoints: [path.resolve(root, 'electron/browser-runtime/server.ts')],
    outfile: path.resolve(root, 'electron/browser-runtime/dist/server.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    minify: false,
    external: ['./wsServer.js'],
    banner: {
      js:
        "import { createRequire as __abuCreateRequire } from 'node:module';\n" +
        'const require = __abuCreateRequire(import.meta.url);\n',
    },
  });
  recordSourceDigest('electron/browser-runtime/dist/server.mjs');
  console.log('[build-electron-browser-runtime] electron/browser-runtime/dist/server.mjs built');
}

main().catch((err) => {
  console.error('[build-electron-browser-runtime] build failed:', err);
  process.exit(1);
});
