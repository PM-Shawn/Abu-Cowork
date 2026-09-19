'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const path = require('node:path');

const {
  CHROME_EXTENSIONS_URL,
  chromeExecutableCandidates,
  openChromeExtensionsPage,
} = require('./chromeExtensionsLauncher.cjs');

test('Windows searches per-user Chrome before machine-wide installs', () => {
  const env = {
    LOCALAPPDATA: String.raw`C:\Users\Abu\AppData\Local`,
    PROGRAMFILES: String.raw`C:\Program Files`,
    'PROGRAMFILES(X86)': String.raw`C:\Program Files (x86)`,
  };
  assert.deepEqual(chromeExecutableCandidates('win32', env, 'C:\\Users\\Abu'), [
    path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.win32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.win32.join(
      env['PROGRAMFILES(X86)'],
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),
  ]);
});

test('opens the Chrome extensions page through Chrome instead of the OS URL handler', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => calls.push({ unref: true });
  const spawnImpl = (executable, args, options) => {
    calls.push({ executable, args, options });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const chrome = String.raw`C:\Users\Abu\AppData\Local\Google\Chrome\Application\chrome.exe`;

  await openChromeExtensionsPage({
    platform: 'win32',
    env: { LOCALAPPDATA: String.raw`C:\Users\Abu\AppData\Local` },
    existsSync: (candidate) => candidate === chrome,
    spawnImpl,
  });

  assert.deepEqual(calls[0], {
    executable: chrome,
    args: ['--new-window', CHROME_EXTENSIONS_URL],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    },
  });
  assert.deepEqual(calls[1], { unref: true });
});

test('fails clearly when Chrome is not installed in a supported location', async () => {
  await assert.rejects(
    openChromeExtensionsPage({
      platform: 'win32',
      env: {},
      existsSync: () => false,
    }),
    /Chrome executable was not found/,
  );
});

test('macOS delivers the internal URL to Chrome through Launch Services', async () => {
  const calls = [];
  let acknowledge;
  let finished = false;
  const launched = openChromeExtensionsPage({
    platform: 'darwin',
    homeDir: '/Users/Abu',
    existsSync: () => true,
    execFileImpl: (executable, args, options, callback) => {
      calls.push({ executable, args, options });
      acknowledge = callback;
    },
    spawnImpl: () => assert.fail('must not pass internal URL on Chrome command line'),
  }).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(calls, [{
    executable: '/usr/bin/open',
    args: ['-a', '/Applications/Google Chrome.app', CHROME_EXTENSIONS_URL],
    options: { timeout: 10_000 },
  }]);
  acknowledge(null);
  await launched;
  assert.equal(finished, true);
});

test('macOS uses a per-user Chrome bundle when no system installation exists', async () => {
  let opened;
  const appBundle = path.join('/Users/Abu Person', 'Applications', 'Google Chrome.app');
  await openChromeExtensionsPage({
    platform: 'darwin',
    homeDir: '/Users/Abu Person',
    existsSync: (candidate) => candidate === path.join(appBundle, 'Contents', 'MacOS', 'Google Chrome'),
    execFileImpl: (_executable, args, _options, callback) => {
      opened = args;
      callback(null);
    },
  });
  assert.deepEqual(opened, ['-a', appBundle, CHROME_EXTENSIONS_URL]);
});

test('macOS reports a rejected or timed-out URL handoff instead of claiming success', async () => {
  for (const message of ['Launch Services rejected URL', 'open timed out']) {
    await assert.rejects(openChromeExtensionsPage({
      platform: 'darwin',
      existsSync: () => true,
      execFileImpl: (_executable, _args, _options, callback) => callback(new Error(message)),
    }), { message });
  }
});
