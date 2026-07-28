'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu chrome bridge host '));
const repoRoot = path.join(root, 'repo with spaces');
const packagedRoot = path.join(root, 'resources with spaces');
const appEnvPath = require.resolve('./appEnv.cjs');

require.cache[appEnvPath] = {
  id: appEnvPath,
  filename: appEnvPath,
  loaded: true,
  exports: {
    REPO_ROOT: repoRoot,
    resourceRoot: (app) => app?.isPackaged ? packagedRoot : repoRoot,
  },
};

const {
  CHROME_BRIDGE_RUNTIME_COMMAND,
  bundledChromeBridgeArgs,
  chromeBridgeRuntimePath,
  resolveChromeBridgeRuntimeLaunch,
} = require('./chromeBridgeHost.cjs');

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('Chrome bridge uses a stable first-party command and the development bundle', async () => {
  const script = path.join(
    repoRoot,
    'electron',
    'chrome-bridge-runtime',
    'dist',
    'server.mjs',
  );
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');

  assert.equal(CHROME_BRIDGE_RUNTIME_COMMAND, 'abu-chrome-bridge-runtime');
  assert.equal(chromeBridgeRuntimePath({ isPackaged: false }), script);
  assert.deepEqual(await resolveChromeBridgeRuntimeLaunch({ isPackaged: false }), {
    command: 'node',
    args: [script],
    env: {},
  });
});

test('packaged Chrome bridge resolves only from application resources', async () => {
  const script = path.join(packagedRoot, 'chrome-bridge-runtime', 'server.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');

  assert.equal(chromeBridgeRuntimePath({ isPackaged: true }), script);
  assert.deepEqual(await resolveChromeBridgeRuntimeLaunch({ isPackaged: true }), {
    command: 'node',
    args: [script],
    env: {},
  });
});

test('missing bundled Chrome bridge fails without a network fallback', async () => {
  fs.rmSync(path.join(packagedRoot, 'chrome-bridge-runtime'), {
    recursive: true,
    force: true,
  });

  await assert.rejects(
    resolveChromeBridgeRuntimeLaunch({ isPackaged: true }),
    /Bundled Chrome bridge runtime is missing/,
  );
});

test('legacy npx wrapper arguments are removed while the supported port is preserved', () => {
  assert.deepEqual(
    bundledChromeBridgeArgs([
      '-y',
      '--package=abu-browser-bridge@0.2.0',
      'abu-browser-bridge@0.2.0',
      '--port',
      '19999',
    ]),
    ['--port', '19999'],
  );
  assert.deepEqual(bundledChromeBridgeArgs(['--port=20000']), ['--port', '20000']);
});

test('invalid or unsupported Chrome bridge arguments fail instead of being discarded', () => {
  assert.throws(() => bundledChromeBridgeArgs(['--port', '70000']), /Invalid Chrome bridge port/);
  assert.throws(() => bundledChromeBridgeArgs(['--unknown']), /Unsupported Chrome bridge argument/);
});
