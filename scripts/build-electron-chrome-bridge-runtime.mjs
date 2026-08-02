#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bridgeRoot = path.join(root, 'abu-browser-bridge');
const bridgePackage = JSON.parse(
  fs.readFileSync(path.join(bridgeRoot, 'package.json'), 'utf8'),
);

async function main() {
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
  console.log(
    '[build-electron-chrome-bridge-runtime] ' +
    'electron/chrome-bridge-runtime/dist/server.mjs built',
  );
}

main().catch((error) => {
  console.error('[build-electron-chrome-bridge-runtime] build failed:', error);
  process.exit(1);
});
