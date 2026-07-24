/**
 * Tauri→Electron data-migration end-to-end verification — boots real
 * (headless) Electron and drives the REAL pipeline: a synthesized
 * Tauri-format secrets.bin (encrypted with the REAL machine-UUID-derived key,
 * exercising the ioreg + HKDF path) + a fake conversations/sessions/backups
 * tree → runTauriMigration → the REAL safeStorage-backed secretStore
 * (electron/secretStore.cjs) → assert the plaintexts round-trip back out of
 * `secret_get` and the data dirs arrive file-by-file.
 *
 * Isolation: `app.setPath('appData', <tmp>)` BEFORE initSecretStore, so the
 * whole run (secrets.enc.json, migrated dirs, sentinel) lives under a temp
 * root and the real `com.abu.app.electron-dev` dir is never touched. The
 * production auto-migration wiring in registerTauriHost is not armed here
 * (not packaged, ABU_MIGRATE_FROM_TAURI unset).
 *
 * Checks:
 *  1. Machine-key decrypt: entries encrypted with deriveTauriKey(getMachineUuid())
 *     migrate and `secret_get` returns the exact original plaintexts (incl.
 *     unicode) — proves Tauri-decrypt → safeStorage-encrypt → decrypt e2e.
 *  2. Data dirs copied file-by-file; excluded families (catalog.sqlite, logs,
 *     secrets.bin itself) stay behind; source tree untouched.
 *  3. Sentinel written; second run is a sentinel-gated no-op.
 *  4. dryRun against a fresh target: full summary, zero writes, no secrets
 *     stored.
 *
 * Run: npx electron electron/spike/migrationVerify.cjs
 */
'use strict';
const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { listFiles } = require('./listFilesRecursive.cjs');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail ?? '' });
}

app.whenReady().then(async () => {
  // NOTE (unattended-run hazard, accepted): this harness drives REAL
  // safeStorage encrypt/decrypt. On a freshly ad-hoc re-signed Electron
  // binary the first Keychain access can raise a blocking modal
  // (secretStore.cjs documents the same hazard); if this harness ever shows
  // up as a 90s TIMEOUT in e2e-report on a fresh machine/build, that modal
  // is the likely cause — approve the Keychain prompt once and re-run.
  if (!safeStorage.isEncryptionAvailable()) {
    // Checked BEFORE creating any tmp dir: process.exit skips finally blocks,
    // so exiting later would leak the tmp tree.
    console.error('[migrationVerify] safeStorage unavailable on this system — cannot verify');
    process.exit(1);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-migration-verify-'));
  try {
    // Redirect ALL appData under the temp root BEFORE the secret store binds
    // its file path — full isolation from the real electron-dev dir.
    app.setPath('appData', tmpRoot);

    const { getMachineUuid, deriveTauriKey, writeTauriSecretsFile } = require('../tauriSecretsReader.cjs');
    const { runTauriMigration, SENTINEL_FILENAME } = require('../tauriMigration.cjs');
    const { initSecretStore, secretDispatch } = require('../secretStore.cjs');
    const { abuAppDataDir } = require('../appEnv.cjs');

    initSecretStore(app);
    const electronDir = abuAppDataDir(app);
    check('electron dir is under tmp isolation root', electronDir.startsWith(tmpRoot), electronDir);

    // ── synthesize a Tauri install ──────────────────────────
    const tauriDir = path.join(tmpRoot, 'com.abu.app.dev');
    fs.mkdirSync(path.join(tauriDir, 'conversations', 'conv1', 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(tauriDir, 'conversations', 'index.json'), '{"version":1}');
    fs.writeFileSync(path.join(tauriDir, 'conversations', 'conv1', 'messages.jsonl'), '{"role":"user"}\n');
    fs.writeFileSync(path.join(tauriDir, 'conversations', 'conv1', 'outputs', 'o.txt'), 'out');
    fs.mkdirSync(path.join(tauriDir, 'sessions', 'conv1', 'results'), { recursive: true });
    fs.writeFileSync(path.join(tauriDir, 'sessions', 'conv1', 'results', 'tc1.txt'), 'tool result');
    fs.mkdirSync(path.join(tauriDir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(tauriDir, 'backups', 'b1.json'), '{}');
    fs.writeFileSync(path.join(tauriDir, 'catalog.sqlite'), 'projection');
    fs.mkdirSync(path.join(tauriDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(tauriDir, 'logs', 'app.log'), 'log');

    const PLAINTEXTS = {
      'provider:claude': 'sk-ant-migration-test-123',
      'aux:webSearch': 'tvly-migration-test',
      'provider:unicode': '密钥-🔑-value',
    };
    const machineKey = deriveTauriKey(getMachineUuid());
    writeTauriSecretsFile(path.join(tauriDir, 'secrets.bin'), machineKey, PLAINTEXTS);
    const secretsBinBefore = fs.readFileSync(path.join(tauriDir, 'secrets.bin'), 'utf8');

    const migrationOpts = {
      tauriDir,
      electronDir,
      secretSet: (key, value) => secretDispatch('secret_set', { key, value }),
      secretHas: (key) => secretDispatch('secret_has', { key }) === true,
    };

    // ── check 1+2+3a: fresh migration ───────────────────────
    const summary = runTauriMigration(migrationOpts);
    check('fresh run not skipped', !('skipped' in summary), JSON.stringify(summary));
    check(
      'all 3 secrets migrated, none failed',
      summary.secrets &&
        summary.secrets.migrated.length === 3 &&
        summary.secrets.decryptFailed.length === 0 &&
        summary.secrets.setFailed.length === 0,
      JSON.stringify(summary.secrets)
    );
    for (const [k, v] of Object.entries(PLAINTEXTS)) {
      check(`secret_get("${k}") round-trips through safeStorage`, secretDispatch('secret_get', { key: k }) === v);
    }
    check(
      'conversations copied file-by-file',
      JSON.stringify(listFiles(path.join(electronDir, 'conversations'))) ===
        JSON.stringify([path.join('conv1', 'messages.jsonl'), path.join('conv1', 'outputs', 'o.txt'), 'index.json'].sort())
    );
    check('sessions copied', fs.readFileSync(path.join(electronDir, 'sessions', 'conv1', 'results', 'tc1.txt'), 'utf8') === 'tool result');
    check('backups copied', fs.existsSync(path.join(electronDir, 'backups', 'b1.json')));
    check('catalog.sqlite NOT migrated (rebuildable projection)', !fs.existsSync(path.join(electronDir, 'catalog.sqlite')));
    check('logs NOT migrated', !fs.existsSync(path.join(electronDir, 'logs')));
    check('secrets.bin NOT file-copied (format incompatible)', !fs.existsSync(path.join(electronDir, 'secrets.bin')));
    check('sentinel written', fs.existsSync(path.join(electronDir, SENTINEL_FILENAME)));
    check(
      'Tauri source untouched',
      fs.readFileSync(path.join(tauriDir, 'secrets.bin'), 'utf8') === secretsBinBefore &&
        fs.existsSync(path.join(tauriDir, 'conversations', 'conv1', 'messages.jsonl'))
    );

    // ── check 3b: idempotency ───────────────────────────────
    const second = runTauriMigration(migrationOpts);
    check('second run is sentinel-gated no-op', second.skipped === 'already-migrated', JSON.stringify(second));

    // ── check 4: dryRun against a fresh target ──────────────
    const dryTarget = path.join(tmpRoot, 'dry-target');
    const drySummary = runTauriMigration({
      ...migrationOpts,
      electronDir: dryTarget,
      secretSet: () => {
        throw new Error('dryRun must never call secretSet');
      },
      dryRun: true,
    });
    check(
      'dryRun summary reports would-migrate work',
      drySummary.dryRun === true &&
        drySummary.secrets.skippedExisting.length === 3 && // already stored by check 1
        drySummary.dirs.conversations === 'copied',
      JSON.stringify(drySummary)
    );
    check('dryRun wrote nothing (target dir not even created)', !fs.existsSync(dryTarget));
  } catch (err) {
    check('harness threw', false, err && err.stack ? err.stack : String(err));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.pass ? `\n      ${r.detail}` : ''}`);
    if (r.pass) pass++;
  }
  console.log(`[migrationVerify] ${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
});
