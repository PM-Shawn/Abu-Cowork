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
  isApprovedBridgeCommand,
  retireStaleChromeBridge,
  resolveChromeBridgeRuntimeLaunch,
  verifiedBridgeProcess,
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
  assert.deepEqual(await resolveChromeBridgeRuntimeLaunch(
    { isPackaged: false },
    [],
    { takeoverImpl: async () => ({ status: 'none' }) },
  ), {
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
  assert.deepEqual(await resolveChromeBridgeRuntimeLaunch(
    { isPackaged: true },
    [],
    { takeoverImpl: async () => ({ status: 'none' }) },
  ), {
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
    resolveChromeBridgeRuntimeLaunch(
      { isPackaged: true },
      [],
      { takeoverImpl: async () => ({ status: 'none' }) },
    ),
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

test('only reviewed first-party bridge command lines are eligible for takeover', () => {
  assert.equal(
    isApprovedBridgeCommand(
      'node /Users/test/.npm/_npx/hash/node_modules/.bin/abu-browser-bridge'
    ),
    true,
  );
  assert.equal(
    isApprovedBridgeCommand(
      '/resources/node-runtime/bin/node /resources/chrome-bridge-runtime/server.mjs'
    ),
    true,
  );
  assert.equal(
    isApprovedBridgeCommand(
      'node /repo/electron/chrome-bridge-runtime/dist/server.mjs'
    ),
    true,
  );
  assert.equal(isApprovedBridgeCommand('python -m http.server 9875'), false);
  assert.equal(
    isApprovedBridgeCommand('node -e "console.log(\'abu-browser-bridge\')"'),
    false,
  );
});

test('POSIX bridge verification requires same uid, approved command, and both ports', () => {
  const outputs = [
    '501 node /tmp/node_modules/.bin/abu-browser-bridge\n',
    [
      'node 99 user 1u IPv4 TCP 127.0.0.1:9875 (LISTEN)',
      'node 99 user 2u IPv4 TCP 127.0.0.1:9876 (LISTEN)',
    ].join('\n'),
  ];
  const verified = verifiedBridgeProcess(99, {
    platform: 'darwin',
    uid: 501,
    lsofPath: '/test/lsof',
    execFileSync: () => outputs.shift(),
  });
  assert.equal(verified.pid, 99);

  const missingPort = [
    '501 node /tmp/node_modules/.bin/abu-browser-bridge\n',
    'node 99 user 1u IPv4 TCP 127.0.0.1:9875 (LISTEN)',
  ];
  assert.equal(
    verifiedBridgeProcess(99, {
      platform: 'darwin',
      uid: 501,
      lsofPath: '/test/lsof',
      execFileSync: () => missingPort.shift(),
    }),
    null,
  );
});

test('stale bridge takeover never signals an unverified process', async () => {
  const signals = [];
  const result = await retireStaleChromeBridge({
    platform: 'darwin',
    uid: 501,
    lsofPath: '/test/lsof',
    statusOverride: {
      service: 'abu-browser-bridge',
      pid: 4321,
      wsPort: 9876,
    },
    execFileSync: () => '501 python -m http.server 9875\n',
    kill: (_pid, signal) => signals.push(signal),
  });
  assert.equal(result.status, 'unverified-owner');
  assert.deepEqual(signals, []);
});

test('verified stale bridge receives graceful termination before a new launch', async () => {
  const outputs = [
    '501 node /tmp/node_modules/.bin/abu-browser-bridge\n',
    [
      'node 4321 user 1u IPv4 TCP 127.0.0.1:9875 (LISTEN)',
      'node 4321 user 2u IPv4 TCP 127.0.0.1:9876 (LISTEN)',
    ].join('\n'),
  ];
  const signals = [];
  let alive = true;
  const result = await retireStaleChromeBridge({
    platform: 'darwin',
    uid: 501,
    lsofPath: '/test/lsof',
    statusOverride: {
      service: 'abu-browser-bridge',
      pid: 4321,
      wsPort: 9876,
    },
    execFileSync: () => outputs.shift(),
    kill: (_pid, signal) => {
      if (signal === 'SIGTERM') {
        signals.push(signal);
        alive = false;
        return;
      }
      if (signal === 0 && !alive) {
        const error = new Error('gone');
        error.code = 'ESRCH';
        throw error;
      }
    },
  });
  assert.deepEqual(result, { status: 'retired', pid: 4321 });
  assert.deepEqual(signals, ['SIGTERM']);
});
