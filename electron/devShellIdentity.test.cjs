'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEV_SHELL_BUNDLE_ID_ENV,
  devShellSuffix,
  electronProductName,
  secretStoreFileName,
} = require('./devShellIdentity.cjs');

const bundleId = 'com.abu.cowork.dev.012345abcdef';

test('macOS protocol shells get checkout-scoped Safe Storage identities', () => {
  const options = {
    env: { [DEV_SHELL_BUNDLE_ID_ENV]: bundleId },
    platform: 'darwin',
    isPackaged: false,
  };
  assert.equal(devShellSuffix(options), '012345abcdef');
  assert.equal(electronProductName(options), 'abu-electron-dev-012345abcdef');
  assert.equal(secretStoreFileName(options), 'secrets.012345abcdef.enc.json');
});

test('invalid or non-macOS identities cannot influence local paths', () => {
  for (const value of ['../../escape', 'com.abu.cowork.dev.short', 'com.other.dev.012345abcdef']) {
    const options = {
      env: { [DEV_SHELL_BUNDLE_ID_ENV]: value },
      platform: 'darwin',
      isPackaged: false,
    };
    assert.equal(devShellSuffix(options), null);
    assert.equal(electronProductName(options), 'abu-electron-dev');
    assert.equal(secretStoreFileName(options), 'secrets.enc.json');
  }

  const otherPlatform = {
    env: { [DEV_SHELL_BUNDLE_ID_ENV]: bundleId },
    platform: 'win32',
    isPackaged: false,
  };
  assert.equal(electronProductName(otherPlatform), 'abu-electron-dev');
  assert.equal(secretStoreFileName(otherPlatform), 'secrets.enc.json');
});

test('packaged builds keep the production product and secret-store identities', () => {
  const options = {
    env: { [DEV_SHELL_BUNDLE_ID_ENV]: bundleId },
    platform: 'darwin',
    isPackaged: true,
  };
  assert.equal(electronProductName(options), 'Abu');
  assert.equal(secretStoreFileName(options), 'secrets.enc.json');
});
