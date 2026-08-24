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

test('setup:electron-dev runs copy-resources so every browser-artifact digest gets stamped', () => {
  // check:browser-artifacts 校验 4 个产物戳，setup 的构建步骤只写其中 3 个；
  // src-tauri/browser-extension 的戳只有 copy-resources 写，缺了它新 worktree
  // 首次 verify 必报 STALE。
  const setupScript = readFileSync(path.join(repoRoot, 'scripts', 'setup-electron-dev.mjs'), 'utf8');
  const browserRuntimeAt = setupScript.indexOf("'build:electron-browser-runtime'");
  const sidecarAt = setupScript.indexOf("'build:sidecar'");
  const copyResourcesAt = setupScript.indexOf("'copy-resources'");
  assert.notEqual(copyResourcesAt, -1, 'setup:electron-dev must run copy-resources');
  assert.ok(
    copyResourcesAt > browserRuntimeAt && browserRuntimeAt !== -1,
    'copy-resources needs abu-chrome-extension/dist built first',
  );
  assert.ok(
    copyResourcesAt > sidecarAt && sidecarAt !== -1,
    'copy-resources needs sidecar/index.mjs built first',
  );
});
