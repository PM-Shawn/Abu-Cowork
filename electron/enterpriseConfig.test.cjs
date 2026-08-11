// node --test electron/enterpriseConfig.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONFIG_BASENAME,
  candidatePaths,
  normalizeConfig,
  loadEnterpriseRuntimeConfig,
  resolveEdition,
} = require('./enterpriseConfig.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abu-entcfg-'));
}

test('candidatePaths: env override first, then resource root, then managed path', () => {
  const paths = candidatePaths('/res', { env: { ABU_ENTERPRISE_CONFIG: '/x/custom.json' }, platform: 'darwin' });
  assert.deepEqual(paths, [
    '/x/custom.json',
    path.join('/res', CONFIG_BASENAME),
    path.join('/Library/Application Support/Abu', CONFIG_BASENAME),
  ]);
});

test('candidatePaths: windows managed path uses ProgramData', () => {
  const paths = candidatePaths('/res', { env: { ProgramData: 'D:\\PD' }, platform: 'win32' });
  assert.equal(paths[paths.length - 1], path.join('D:\\PD', 'Abu', CONFIG_BASENAME));
});

test('normalizeConfig: trims + strips trailing slash on serverUrl, keeps unknown keys', () => {
  const cfg = normalizeConfig({ serverUrl: ' https://abu.acme.com/ ', lockServerUrl: true, brandName: 'Acme' });
  assert.deepEqual(cfg, { serverUrl: 'https://abu.acme.com', lockServerUrl: true, brandName: 'Acme' });
});

test('normalizeConfig: rejects non-http serverUrl and non-object payloads', () => {
  assert.equal(normalizeConfig({ serverUrl: 'ftp://x' }), null);
  assert.equal(normalizeConfig([]), null);
  assert.equal(normalizeConfig('str'), null);
  // non-boolean lockServerUrl dropped, rest kept
  assert.deepEqual(normalizeConfig({ lockServerUrl: 'yes' }), {});
});

test('loadEnterpriseRuntimeConfig: reads resource-root file; malformed file is skipped', () => {
  const res = tmpDir();
  fs.writeFileSync(path.join(res, CONFIG_BASENAME), JSON.stringify({ serverUrl: 'http://localhost' }));
  const loaded = loadEnterpriseRuntimeConfig(res, { env: {}, platform: 'linux' });
  assert.equal(loaded.path, path.join(res, CONFIG_BASENAME));
  assert.deepEqual(loaded.config, { serverUrl: 'http://localhost' });

  const res2 = tmpDir();
  fs.writeFileSync(path.join(res2, CONFIG_BASENAME), '{not json');
  assert.equal(loadEnterpriseRuntimeConfig(res2, { env: {}, platform: 'linux' }), null);
});

test('loadEnterpriseRuntimeConfig: env override beats resource root', () => {
  const res = tmpDir();
  fs.writeFileSync(path.join(res, CONFIG_BASENAME), JSON.stringify({ serverUrl: 'http://from-res' }));
  const custom = path.join(tmpDir(), 'c.json');
  fs.writeFileSync(custom, JSON.stringify({ serverUrl: 'http://from-env' }));
  const loaded = loadEnterpriseRuntimeConfig(res, { env: { ABU_ENTERPRISE_CONFIG: custom }, platform: 'linux' });
  assert.equal(loaded.config.serverUrl, 'http://from-env');
});

test('resolveEdition: env wins, else config presence decides', () => {
  const loaded = { path: '/x', config: {} };
  assert.equal(resolveEdition(loaded, {}), 'enterprise');
  assert.equal(resolveEdition(null, {}), 'oss');
  assert.equal(resolveEdition(null, { ABU_BUILD_TARGET: 'enterprise' }), 'enterprise');
  assert.equal(resolveEdition(loaded, { ABU_EDITION: 'oss' }), 'oss');
});
