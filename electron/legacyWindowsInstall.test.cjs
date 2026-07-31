'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LEGACY_UNINSTALL_KEY,
  hideLegacyTauriUninstallEntry,
  inspectLegacyTauriInstall,
} = require('./legacyWindowsInstall.cjs');

function registry(values) {
  const calls = [];
  const runRegistry = (args) => {
    calls.push(args);
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    const name = args.at(-1);
    const value = values[name];
    return value == null
      ? { status: 1, stdout: '', stderr: 'missing' }
      : {
          status: 0,
          stdout: `${LEGACY_UNINSTALL_KEY}\r\n    ${name}    REG_SZ    ${value}\r\n`,
          stderr: '',
        };
  };
  return { calls, runRegistry };
}

const validValues = {
  DisplayName: 'Abu',
  DisplayVersion: '0.33.0',
  InstallLocation: '"C:\\Users\\tester\\AppData\\Local\\Abu"',
  UninstallString: '"C:\\Users\\tester\\AppData\\Local\\Abu\\uninstall.exe"',
};

test('recognizes and hides only the historical current-user Tauri install', () => {
  const fake = registry(validValues);
  const options = {
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    runRegistry: fake.runRegistry,
  };
  assert.deepEqual(inspectLegacyTauriInstall(options), {
    displayName: 'Abu',
    displayVersion: '0.33.0',
    installLocation: 'C:\\Users\\tester\\AppData\\Local\\Abu',
    uninstallString: '"C:\\Users\\tester\\AppData\\Local\\Abu\\uninstall.exe"',
  });
  assert.equal(hideLegacyTauriUninstallEntry(options).hidden, true);
  assert.deepEqual(fake.calls.at(-1), [
    'add',
    LEGACY_UNINSTALL_KEY,
    '/v',
    'SystemComponent',
    '/t',
    'REG_DWORD',
    '/d',
    '1',
    '/f',
  ]);
});

test('rejects a similarly named uninstall entry outside the legacy path', () => {
  const fake = registry({
    ...validValues,
    InstallLocation: 'C:\\Users\\tester\\Downloads\\Abu',
    UninstallString: '"C:\\Users\\tester\\Downloads\\Abu\\uninstall.exe"',
  });
  const result = hideLegacyTauriUninstallEntry({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    runRegistry: fake.runRegistry,
  });
  assert.deepEqual(result, { hidden: false, reason: 'not-recognized' });
  assert.equal(fake.calls.some((args) => args[0] === 'add'), false);
});

test('rejects Electron-era and malformed versions', () => {
  for (const displayVersion of ['0.34.0', '1.0.0', 'unknown']) {
    const fake = registry({ ...validValues, DisplayVersion: displayVersion });
    assert.equal(
      inspectLegacyTauriInstall({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
        runRegistry: fake.runRegistry,
      }),
      null,
    );
  }
});
