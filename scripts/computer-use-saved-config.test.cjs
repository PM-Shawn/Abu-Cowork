'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectSavedEvalConfig, readSavedDesktopEvalConfig } = require('./computer-use-saved-config.cjs');

const settings = { state: { activeModel: { providerId: 'chosen', modelId: 'test-model' }, providers: [
  { id: 'other', enabled: true, apiFormat: 'openai-compatible', baseUrl: 'https://other.invalid/v1', apiKey: 'unused' },
  { id: 'chosen', enabled: true, apiFormat: 'openai-compatible', baseUrl: 'https://chosen.invalid/v1',
    models: [{ id: 'test-model' }], apiKey: '' },
] } };

test('saved evaluation uses only the explicitly active provider and decrypts only its key', () => {
  const config = selectSavedEvalConfig(settings, (key) => {
    assert.equal(key, 'provider:chosen');
    return 'test-only-secret';
  });
  assert.deepEqual(config, { baseUrl: 'https://chosen.invalid/v1', model: 'test-model', apiKey: 'test-only-secret' });
});

test('saved evaluation fails closed for unsupported or ambiguous selection without exposing source details', () => {
  const neverDecrypt = () => { throw new Error('must-not-decrypt'); };
  for (const value of [null, {}, { state: {} },
    { state: { ...settings.state, activeModel: { providerId: 'missing', modelId: 'test-model' } } },
    { state: { ...settings.state, activeModel: { providerId: 'chosen', modelId: 'absent' } } },
    { state: { ...settings.state, providers: [...settings.state.providers, settings.state.providers[1]] } },
    ...[{ enabled: false }, { apiFormat: 'anthropic' }, { baseUrl: 'http://remote.invalid' },
      { baseUrl: 'https://private:secret@remote.invalid' }].map((change) => ({ state: {
      ...settings.state, providers: [{ ...settings.state.providers[1], ...change }],
    } })),
  ]) assert.throws(() => selectSavedEvalConfig(value, neverDecrypt), /^Error: saved-eval-configuration-unavailable$/);
});

test('saved evaluation never substitutes another provider key or discloses decryption errors', () => {
  for (const decrypt of [() => null, () => '', () => { throw new Error('private-path-and-key'); }]) {
    assert.throws(() => selectSavedEvalConfig(settings, decrypt), /^Error: saved-eval-configuration-unavailable$/);
  }
});

test('saved reader returns active config from a copy and leaves source profile and encrypted file unchanged', {
  skip: process.platform !== 'win32' || process.env.ABU_CU_SAVED_CONFIG_TEST !== '1', timeout: 60000,
}, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { _electron } = require('playwright');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-cu-saved-reader-test-'));
  const sourceProfile = path.join(root, 'source');
  const secretsFile = path.join(root, 'secrets.enc.json');
  let app;
  try {
    app = await _electron.launch({ args: [path.join(__dirname, 'computer-use-saved-config-reader.cjs'),
      `--user-data-dir=${sourceProfile}`], env: { ...process.env, ABU_CU_SAVED_SECRETS: secretsFile } });
    const page = await app.firstWindow();
    await page.waitForLoadState();
    await page.evaluate((value) => {
      localStorage.setItem('abu-settings', JSON.stringify(value));
      localStorage.setItem('abu-chat', 'PRIVATE_HISTORY_MUST_NOT_BE_RETURNED');
    }, settings);
    const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.encryptString('test-only-secret').toString('base64'));
    fs.writeFileSync(secretsFile, JSON.stringify({ 'provider:chosen': encrypted }));
    await app.close();
    app = null;
    const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const files = fs.readdirSync(path.join(sourceProfile, 'Local Storage', 'leveldb'))
      .map((name) => path.join(sourceProfile, 'Local Storage', 'leveldb', name));
    files.push(path.join(sourceProfile, 'Local State'));
    const before = files.map(hash);
    const secretBefore = hash(secretsFile);
    assert.deepEqual(await readSavedDesktopEvalConfig({ sourceProfile, secretsFile }), {
      baseUrl: 'https://chosen.invalid/v1', model: 'test-model', apiKey: 'test-only-secret',
    });
    assert.deepEqual(files.map(hash), before);
    assert.equal(hash(secretsFile), secretBefore);
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
