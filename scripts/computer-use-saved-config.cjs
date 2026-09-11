'use strict';

const { readLiveEvalConfig } = require('./computer-use-live-eval.cjs');

function selectSavedEvalConfig(settings, decryptKey) {
  try {
    const state = settings?.state;
    const active = state?.activeModel;
    const providers = state?.providers?.filter((provider) => provider.id === active?.providerId);
    if (providers?.length !== 1 || typeof active?.modelId !== 'string') throw new Error();
    const provider = providers[0];
    if (provider.enabled !== true || provider.apiFormat !== 'openai-compatible'
      || !provider.models?.some((model) => model.id === active.modelId)) throw new Error();
    const env = { ABU_CU_EVAL_LIVE: '1', ABU_CU_EVAL_BASE_URL: provider.baseUrl,
      ABU_CU_EVAL_MODEL: active.modelId, ABU_CU_EVAL_API_KEY: 'validation-only' };
    if (readLiveEvalConfig(env).status !== 'ready') throw new Error();
    const result = readLiveEvalConfig({ ...env, ABU_CU_EVAL_API_KEY: decryptKey(`provider:${provider.id}`) });
    if (result.status !== 'ready') throw new Error();
    return result.config;
  } catch {
    // Never include provider values, keychain errors, or profile contents.
    throw new Error('saved-eval-configuration-unavailable');
  }
}

async function readSavedDesktopEvalConfig({ sourceProfile, secretsFile } = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { _electron } = require('playwright');
  const { withoutLiveEvalCredential } = require('./computer-use-live-eval.cjs');
  if (process.platform !== 'win32' || !path.isAbsolute(sourceProfile ?? '')
    || !path.isAbsolute(secretsFile ?? '')) throw new Error('saved-eval-configuration-unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-cu-saved-config-'));
  let app;
  try {
    const profile = path.join(root, 'profile');
    // Copy only Chromium local storage. No cookies, application databases,
    // conversations, extensions, or executable code are loaded from the source.
    fs.cpSync(path.join(sourceProfile, 'Local Storage'), path.join(profile, 'Local Storage'), {
      recursive: true, filter: (source) => !fs.lstatSync(source).isSymbolicLink(),
    });
    // Windows safeStorage needs this profile's DPAPI-wrapped encryption key.
    // No cookies or other browser databases are copied with the metadata.
    fs.copyFileSync(path.join(sourceProfile, 'Local State'), path.join(profile, 'Local State'));
    app = await _electron.launch({ args: [path.join(__dirname, 'computer-use-saved-config-reader.cjs'),
      `--user-data-dir=${profile}`], env: { ...withoutLiveEvalCredential(process.env),
      ABU_CU_SAVED_SECRETS: secretsFile }, timeout: 30000 });
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState();
    return await app.evaluate(() => globalThis.__cuReadSavedConfig());
  } catch {
    throw new Error('saved-eval-configuration-unavailable');
  } finally {
    // If shutdown fails, retain the copy; never delete a live Chromium profile.
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { selectSavedEvalConfig, readSavedDesktopEvalConfig };
