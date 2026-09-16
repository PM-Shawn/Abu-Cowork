#!/usr/bin/env node

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordSourceDigest } from './check-browser-artifacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
async function buildLinkedomWorkerIifeSource() {
  const result = await build({
    entryPoints: [path.resolve(root, 'node_modules/linkedom/worker.js')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'LinkeDOM',
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function main() {
  const linkedomWorkerIifeSource = await buildLinkedomWorkerIifeSource();
  await build({
    entryPoints: [path.resolve(root, 'abu-browser-bridge/src/queryJsWorker.mjs')],
    outfile: path.resolve(root, 'electron/browser-runtime/dist/queryJsWorker.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    minify: false,
    define: {
      __ABU_BUNDLED_LINKEDOM_WORKER_IIFE_SOURCE__: JSON.stringify(linkedomWorkerIifeSource),
    },
  });
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
  recordSourceDigest('electron/browser-runtime/dist/queryJsWorker.mjs');
  recordSourceDigest('electron/browser-runtime/dist/server.mjs');
  console.log('[build-electron-browser-runtime] electron/browser-runtime/dist/server.mjs built');
  console.log('[build-electron-browser-runtime] electron/browser-runtime/dist/queryJsWorker.mjs built');
}

main().catch((err) => {
  console.error('[build-electron-browser-runtime] build failed:', err);
  process.exit(1);
});
