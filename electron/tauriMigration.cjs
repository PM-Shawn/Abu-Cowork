/**
 * One-time Tauri→Electron user-data migration (handoff item #3,
 * docs/2026-07-22-phase2-sliceC-secret-migration-plan.md).
 *
 * Two migration families, run once per Electron app-data dir:
 *
 *  1. Secrets — decrypt the Tauri macOS `secrets.bin` (AES-256-GCM, machine-
 *     UUID-derived key; see tauriSecretsReader.cjs) and hand each plaintext to
 *     an injected `secretSet` callback (production: secretStore.cjs, which
 *     re-encrypts via safeStorage). The formats are incompatible so the file
 *     can NOT simply be copied. On Windows/Linux Tauri kept secrets in the OS
 *     keyring (no file), so there is nothing to migrate there.
 *
 *  2. Data dirs — copy `conversations/` (messages.jsonl + checkpoints +
 *     outputs; the canonical store), legacy `sessions/` (old tool-result
 *     files still read as a fallback by sessionMemory.ts), and `backups/`.
 *     Deliberately NOT migrated: `catalog.sqlite*` (a rebuildable projection
 *     of the JSONL — the app regenerates it), `notice.sqlite*`, `logs/`,
 *     `abu-diag-*.tmp`, and `secrets.bin` itself (handled by family 1; the
 *     Tauri original is never modified or deleted — Tauri installs keep
 *     working untouched).
 *
 * Safety properties:
 *  - Idempotent: a sentinel file (`tauri-migration.json`) in the Electron
 *    app-data dir marks completion; later runs are no-ops.
 *  - Never clobbers: existing Electron-side secret keys and existing target
 *    dirs are skipped, never overwritten or merged.
 *  - Best-effort: one failed entry/dir is recorded and the rest proceeds
 *    (same partial-failure stance as the Tauri loader).
 *  - Dry-run: `dryRun: true` computes the full summary with zero writes
 *    (no sentinel either).
 *
 * Zero Electron imports — everything host-specific (paths, secret store) is
 * injected, so this is unit-testable in plain Node. Wired from tauriHost.cjs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getMachineUuid, deriveTauriKey, readTauriSecrets } = require('./tauriSecretsReader.cjs');

const SENTINEL_FILENAME = 'tauri-migration.json';
/** Copied wholesale when present at the source and absent at the target. */
const DATA_DIRS = ['conversations', 'sessions', 'backups'];

/**
 * The Tauri app-data dir this Electron build should migrate from — mirrors
 * the dev/prod split of appEnv.cjs's abuAppDataDir (Tauri dev id is
 * `com.abu.app.dev`, prod is `com.abu.app`; see tauri.conf.json vs
 * tauri.dev.conf.json).
 * @param {string} appDataParent e.g. Electron's app.getPath('appData')
 * @param {boolean} isPackaged
 * @returns {string}
 */
function resolveTauriAppDataDir(appDataParent, isPackaged) {
  return path.join(appDataParent, isPackaged ? 'com.abu.app' : 'com.abu.app.dev');
}

/**
 * @typedef {Object} MigrationSummary
 * @property {boolean} dryRun
 * @property {{ migrated: string[], skippedExisting: string[], decryptFailed: string[],
 *              setFailed: string[], readError?: string, skippedReason?: string }} secrets
 * @property {Record<string, 'copied' | 'skipped-existing' | 'absent' | string>} dirs
 * @property {boolean} sentinelWritten
 * @property {boolean} [nothingToMigrate]
 */

/**
 * Run the one-time migration. Returns a summary object (also persisted into
 * the sentinel) or `{ skipped: 'already-migrated' }` when the sentinel exists.
 *
 * @param {Object} opts
 * @param {string} opts.tauriDir source Tauri app-data dir
 * @param {string} opts.electronDir target Electron app-data dir
 * @param {(key: string, value: string) => void} opts.secretSet
 * @param {(key: string) => boolean} opts.secretHas
 * @param {boolean} [opts.dryRun]
 * @param {Buffer} [opts.machineKey] test override; default derives from the real machine UUID
 * @param {{ log: Function, warn: Function }} [opts.log]
 * @returns {MigrationSummary | { skipped: string }}
 */
function runTauriMigration(opts) {
  const { tauriDir, electronDir, secretSet, secretHas, dryRun = false, machineKey } = opts;
  const log = opts.log || console;
  const say = (msg) => log.log(`[tauriMigration] ${msg}`);
  const warn = (msg) => log.warn(`[tauriMigration] ${msg}`);

  const sentinelPath = path.join(electronDir, SENTINEL_FILENAME);
  if (fs.existsSync(sentinelPath)) {
    return { skipped: 'already-migrated' };
  }

  /** @type {MigrationSummary} */
  const summary = {
    dryRun,
    secrets: { migrated: [], skippedExisting: [], decryptFailed: [], setFailed: [] },
    dirs: {},
    sentinelWritten: false,
  };

  const writeSentinel = () => {
    if (dryRun) return;
    fs.mkdirSync(electronDir, { recursive: true });
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), summary }, null, 2),
      'utf8'
    );
    summary.sentinelWritten = true;
  };

  if (!fs.existsSync(tauriDir)) {
    say(`no Tauri data dir at ${tauriDir} — nothing to migrate`);
    summary.nothingToMigrate = true;
    writeSentinel();
    return summary;
  }

  // ── 1. secrets ─────────────────────────────────────────────
  const secretsBin = path.join(tauriDir, 'secrets.bin');
  if (process.platform !== 'darwin') {
    // Tauri used the OS keyring off-macOS; the credentials live in the OS
    // store under the same service/key names, not in a file we could read.
    summary.secrets.skippedReason = `non-darwin platform (${process.platform}): Tauri secrets live in the OS keyring, no file to migrate`;
    say(summary.secrets.skippedReason);
  } else if (!fs.existsSync(secretsBin)) {
    summary.secrets.skippedReason = 'no secrets.bin at source';
    say(summary.secrets.skippedReason);
  } else {
    try {
      // Only touch ioreg when there is actually a file to decrypt.
      const key = machineKey || deriveTauriKey(getMachineUuid());
      const read = readTauriSecrets(secretsBin, key);
      if (read) {
        summary.secrets.decryptFailed = read.failed;
        if (read.failed.length > 0) {
          warn(`${read.failed.length} secret(s) failed to decrypt (machine change?): ${read.failed.join(', ')}`);
        }
        for (const [k, v] of read.entries) {
          if (secretHas(k)) {
            summary.secrets.skippedExisting.push(k);
            continue;
          }
          if (dryRun) {
            summary.secrets.migrated.push(k);
            continue;
          }
          try {
            secretSet(k, v);
            summary.secrets.migrated.push(k);
          } catch (err) {
            summary.secrets.setFailed.push(k);
            warn(`failed to store migrated secret "${k}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        say(
          `secrets: ${summary.secrets.migrated.length} ${dryRun ? 'would migrate' : 'migrated'}, ` +
            `${summary.secrets.skippedExisting.length} already present, ` +
            `${summary.secrets.decryptFailed.length} undecryptable, ` +
            `${summary.secrets.setFailed.length} store failures`
        );
      }
    } catch (err) {
      // Unreadable/unsupported secrets file must not block the data-dir copy.
      summary.secrets.readError = err instanceof Error ? err.message : String(err);
      warn(`could not read Tauri secrets: ${summary.secrets.readError}`);
    }
  }

  // ── 2. data dirs ───────────────────────────────────────────
  for (const name of DATA_DIRS) {
    const src = path.join(tauriDir, name);
    const dest = path.join(electronDir, name);
    if (!fs.existsSync(src)) {
      summary.dirs[name] = 'absent';
      continue;
    }
    if (fs.existsSync(dest)) {
      // The Electron shell already has its own data here — never merge or
      // overwrite it with older Tauri state.
      summary.dirs[name] = 'skipped-existing';
      say(`dir ${name}: target exists, skipping`);
      continue;
    }
    if (dryRun) {
      summary.dirs[name] = 'copied';
      say(`dir ${name}: would copy`);
      continue;
    }
    try {
      fs.mkdirSync(electronDir, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      summary.dirs[name] = 'copied';
      say(`dir ${name}: copied`);
    } catch (err) {
      summary.dirs[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
      warn(`dir ${name}: copy failed — ${summary.dirs[name]}`);
    }
  }

  writeSentinel();
  return summary;
}

module.exports = {
  resolveTauriAppDataDir,
  runTauriMigration,
  SENTINEL_FILENAME,
};
