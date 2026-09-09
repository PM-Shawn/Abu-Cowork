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

test('the host-ui gate provisions the browser automation runtime itself', () => {
  // The DOM-action tests in electron:host-ui-test (dialogs, downloads, frames)
  // reach browserHost.cjs's loadAutomationRuntime(), which reads
  // abu-chrome-extension/dist/content.js and deliberately has no fallback to
  // the committed src-tauri/browser-extension/ copy (b2cc8e34). dist/ is
  // gitignored, so a fresh clone has nothing to load.
  //
  // The build used to live only OUTSIDE this gate — later in the electron:test
  // chain (electron:command-test / electron:browser-test), in CI's install step
  // (electron-build.yml), and in setup:electron-dev. All three left
  // `npm run electron:host-ui-test` unrunnable on its own, and made the chain
  // pass only on a machine where an earlier run had already left dist/ behind.
  // Pin the dependency where the gate declares it, so the gate is self-sufficient.
  assert.equal(
    packageJson.scripts['preelectron:host-ui-test'],
    'npm run build:browser-extension',
  );
  const chain = packageJson.scripts['electron:test'];
  assert.ok(
    chain.includes('npm run electron:host-ui-test'),
    'electron:test must still run the host-ui gate',
  );
});
