import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

test('Electron dev launch rebuilds native agent runtimes before the renderer', () => {
  assert.equal(
    packageJson.scripts['preelectron:dev'],
    'npm run electron:dev:check && npm run build:sidecar && npm run build:native-helper && npm run build:electron:renderer',
  );
});

test('enterprise Electron dev launch rebuilds the enterprise sidecar and native helper', () => {
  assert.equal(
    packageJson.scripts['preelectron:dev:enterprise'],
    'npm run electron:dev:check && ABU_BUILD_TARGET=enterprise npm run build:sidecar && npm run build:native-helper && ABU_BUILD_TARGET=enterprise npm run build:electron:renderer',
  );
});
