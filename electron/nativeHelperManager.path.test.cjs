'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  nativeHelperExecutableName,
  resolveHelperPath,
  HELPER_CMDS,
  buildNativeHelperRequest,
  validateHelperHello,
  NATIVE_HELPER_PROTOCOL_VERSION,
} = require('./nativeHelperManager.cjs');

test('native helper exposes a read-only health probe for diagnostics', () => {
  assert.equal(HELPER_CMDS.has('native_helper_health'), true);
  assert.deepEqual(
    buildNativeHelperRequest('native_helper_health', {
      method: 'mouse_click',
      x: 100,
      y: 200,
    }),
    { method: 'health', params: {} },
  );
});

test('native helper owns the frontmost-app identity probe used by Computer Use', () => {
  assert.equal(HELPER_CMDS.has('frontmost_app_identity'), true);
  assert.deepEqual(
    buildNativeHelperRequest('frontmost_app_identity', {}),
    { method: 'frontmost_app_identity', params: {} },
  );
});

test('macOS AX snapshots prefer the focused window before the whole app tree', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src-tauri', 'src', 'accessibility_macos.rs'),
    'utf8',
  );
  const focused = source.indexOf('copy_attr(app, "AXFocusedWindow")');
  const main = source.indexOf('copy_attr(app, "AXMainWindow")');
  const fallback = source.indexOf('CFRetain(app)', main);
  const walk = source.indexOf('walk_and_cache(snapshot_root, 0, &mut st)');

  assert.ok(focused >= 0, 'focused-window root is missing');
  assert.ok(main > focused, 'main-window fallback must follow focused window');
  assert.ok(fallback > main, 'whole-app fallback must be last');
  assert.ok(walk > fallback, 'cached snapshot must walk the selected root');
});

test('native helper hello contract exposes version, platform, commands, and startup time', () => {
  const hello = {
    protocol_version: NATIVE_HELPER_PROTOCOL_VERSION,
    binary_version: '0.0.1',
    platform: 'macos',
    supported_commands: ['hello', 'health', 'ax_snapshot'],
    started_at_ms: 1_700_000_000_000,
  };
  assert.equal(validateHelperHello(hello), hello);
});

test('native helper version mismatch fails with an explicit compatibility error', () => {
  assert.throws(
    () => validateHelperHello({
      protocol_version: NATIVE_HELPER_PROTOCOL_VERSION + 1,
      binary_version: '9.9.9',
      platform: 'macos',
      supported_commands: [],
      started_at_ms: 1,
    }),
    /protocol is incompatible/,
  );
});

test('native helper request builder fails closed for an unknown command', () => {
  assert.equal(
    buildNativeHelperRequest('arbitrary_helper_method', { method: 'keyboard_type' }),
    null,
  );
});

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
