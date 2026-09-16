#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordSourceDigest } from './check-browser-artifacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bridgeRoot = path.join(root, 'abu-browser-bridge');
const bridgePackage = JSON.parse(
  fs.readFileSync(path.join(bridgeRoot, 'package.json'), 'utf8'),
);

async function buildLinkedomWorkerIifeSource() {
  const result = await build({
    entryPoints: [path.join(root, 'node_modules', 'linkedom', 'worker.js')],
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
    entryPoints: [path.join(bridgeRoot, 'src', 'queryJsWorker.mjs')],
    outfile: path.join(root, 'electron', 'chrome-bridge-runtime', 'dist', 'queryJsWorker.mjs'),
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
    entryPoints: [path.join(bridgeRoot, 'src', 'index.ts')],
    outfile: path.join(root, 'electron', 'chrome-bridge-runtime', 'dist', 'server.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    minify: false,
    define: {
      __ABU_CHROME_BRIDGE_VERSION__: JSON.stringify(bridgePackage.version),
    },
    banner: {
      js:
        "import { createRequire as __abuCreateRequire } from 'node:module';\n" +
        'const require = __abuCreateRequire(import.meta.url);\n',
    },
  });
  recordSourceDigest('electron/chrome-bridge-runtime/dist/queryJsWorker.mjs');
  recordSourceDigest('electron/chrome-bridge-runtime/dist/server.mjs');
  console.log(
    '[build-electron-chrome-bridge-runtime] ' +
    'electron/chrome-bridge-runtime/dist/server.mjs built',
  );
  console.log(
    '[build-electron-chrome-bridge-runtime] ' +
    'electron/chrome-bridge-runtime/dist/queryJsWorker.mjs built',
  );
}

main().catch((error) => {
  console.error('[build-electron-chrome-bridge-runtime] build failed:', error);
  process.exit(1);
});
