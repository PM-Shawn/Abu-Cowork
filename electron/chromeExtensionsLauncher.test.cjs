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
