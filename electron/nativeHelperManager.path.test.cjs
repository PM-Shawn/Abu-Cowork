'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const {
  nativeHelperExecutableName,
  resolveHelperPath,
} = require('./nativeHelperManager.cjs');

test('native helper uses the Cargo .exe name in Windows packages', () => {
  assert.equal(nativeHelperExecutableName('win32'), 'native-helper.exe');
  assert.equal(
    resolveHelperPath({
      platform: 'win32',
      packaged: true,
      resourcesPath: 'C:\\Abu\\resources',
    }),
    path.join('C:\\Abu\\resources', 'native-helper', 'native-helper.exe'),
  );
});

test('native helper keeps the extensionless Unix binary name', () => {
  assert.equal(nativeHelperExecutableName('darwin'), 'native-helper');
  assert.equal(
    resolveHelperPath({
      platform: 'darwin',
      packaged: true,
      resourcesPath: '/Applications/Abu.app/Contents/Resources',
    }),
    '/Applications/Abu.app/Contents/Resources/native-helper/native-helper',
  );
});
