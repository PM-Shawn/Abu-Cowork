'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { guiDispatch, __test } = require('./guiHost.cjs');

test('Windows active-window script avoids PowerShell reserved variables and fails closed', () => {
  assert.match(__test.WINDOWS_ACTIVE_WINDOW_SCRIPT, /\$ErrorActionPreference = "Stop"/);
  assert.match(__test.WINDOWS_ACTIVE_WINDOW_SCRIPT, /\[uint32\]\$windowProcessId = 0/);
  assert.match(__test.WINDOWS_ACTIVE_WINDOW_SCRIPT, /Foreground window is unavailable/);
  assert.match(__test.WINDOWS_ACTIVE_WINDOW_SCRIPT, /Get-Process .* -ErrorAction Stop/);
  assert.doesNotMatch(__test.WINDOWS_ACTIVE_WINDOW_SCRIPT, /\$pid\b/i);
});

test('Windows active-window identity is parsed without a native desktop session', async () => {
  const calls = [];
  const identity = await __test.getActiveWindowForPlatform(
    'win32',
    async (file, args) => {
      calls.push({ file, args });
      return 'explorer|||Downloads|||explorer|||4242\n';
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.equal(calls[0].args[2], __test.WINDOWS_ACTIVE_WINDOW_SCRIPT);
  assert.deepEqual(identity, {
    app_name: 'explorer',
    window_title: 'Downloads',
    bundle_id: 'explorer',
    process_id: 4242,
  });
});

test(
  'native active-window probe returns the complete identity required by the Computer Use gate',
  {
    skip:
      process.env.ABU_RUN_NATIVE_ACTIVE_WINDOW_TEST !== '1' ||
      !['darwin', 'win32'].includes(process.platform),
  },
  async () => {
    const identity = await guiDispatch(null, 'get_active_window', {});

    assert.equal(typeof identity.app_name, 'string');
    assert.ok(identity.app_name.trim().length > 0);
    assert.equal(typeof identity.bundle_id, 'string');
    assert.ok(identity.bundle_id.trim().length > 0);
    assert.ok(Number.isInteger(identity.process_id));
    assert.ok(identity.process_id > 0);
  }
);
