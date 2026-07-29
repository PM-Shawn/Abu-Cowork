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
 *     can NOT simply be copied. Windows Tauri secrets live in Credential
 *     Manager and are migrated by tauriLocalStorageMigration.cjs, which can
 *     derive the explicit custom-provider key allowlist from abu-settings.
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
 *    app-data dir marks completion; later runs are no-ops. The sentinel is
 *    only written when the run completed CLEANLY — a read error, safeStorage
 *    store failure, or dir-copy error leaves it unwritten so the next boot
 *    retries (undecryptable entries alone don't block it: a machine-UUID
 *    change is permanent and retrying can't fix it).
 *  - Never clobbers: existing Electron-side secret keys and existing target
 *    dirs are skipped, never overwritten or merged. Dir copies are staged
 *    (copy to `<dest>.migrating`, then rename) so a crash mid-copy can never
 *    leave a half-populated dir that later runs mistake for real data.
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

function hasValidSentinel(sentinelPath) {
  try {
    const record = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    return (
      record?.version === 1 &&
      record?.summary?.sentinelWritten === true &&
      typeof record?.migratedAt === 'string'
    );
  } catch {
    return false;
  }
}

function writeSentinelAtomic(sentinelPath, record) {
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  const stagingPath = `${sentinelPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(stagingPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(stagingPath, sentinelPath);
  } finally {
    fs.rmSync(stagingPath, { force: true });
  }
}

function removeStagingBestEffort(stagingPath) {
  try {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  } catch {
    // The parent itself can be a file or otherwise unusable. The copy attempt
    // below records the actionable migration error; staging cleanup must never
    // escape first (Node versions differ on rmSync's ENOTDIR handling).
  }
}

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
  if (hasValidSentinel(sentinelPath)) {
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
    summary.sentinelWritten = true; // set BEFORE stringify so the persisted record agrees
    writeSentinelAtomic(
      sentinelPath,
      { version: 1, migratedAt: new Date().toISOString(), summary }
    );
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
    summary.secrets.skippedReason =
      process.platform === 'win32'
        ? 'Windows keyring (Credential Manager) migration is handled by tauriLocalStorageMigration'
        : `non-darwin platform (${process.platform}): no file-based secrets.bin`;
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
    // Staged copy: copy into a sibling temp dir, then rename into place. A
    // crash / force-quit / ENOSPC mid-copy leaves only the staging dir behind
    // (cleaned up on the next run), never a half-populated `dest` that the
    // never-clobber guard below would wrongly treat as authoritative data.
    const staging = `${dest}.migrating`;
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
      removeStagingBestEffort(staging); // leftover from a crashed run
      fs.mkdirSync(electronDir, { recursive: true });
      fs.cpSync(src, staging, { recursive: true });
      fs.renameSync(staging, dest);
      summary.dirs[name] = 'copied';
      say(`dir ${name}: copied`);
    } catch (err) {
      summary.dirs[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
      warn(`dir ${name}: copy failed — ${summary.dirs[name]}`);
      removeStagingBestEffort(staging); // next run also cleans
    }
  }

  // One-shot protection: only burn the sentinel when this run completed
  // cleanly. readError (e.g. a transient ioreg failure), any setFailed
  // (safeStorage momentarily unavailable) or a dir copy error may all be
  // recoverable — leave the sentinel unwritten so the next boot retries
  // (already-migrated secrets are skippedExisting, already-copied dirs are
  // skipped-existing, so the retry is idempotent). decryptFailed alone does
  // NOT block the sentinel: a machine-UUID change is permanent and retrying
  // can never fix it (mirrors Tauri surfacing failed_keys instead of failing).
  const clean =
    !summary.secrets.readError &&
    summary.secrets.setFailed.length === 0 &&
    !Object.values(summary.dirs).some((v) => String(v).startsWith('error:'));
  if (clean) {
    writeSentinel();
  } else if (!dryRun) {
    warn('migration incomplete — sentinel NOT written; will retry on next launch');
  }
  return summary;
}

module.exports = {
  resolveTauriAppDataDir,
  runTauriMigration,
  SENTINEL_FILENAME,
  hasValidSentinel,
};
