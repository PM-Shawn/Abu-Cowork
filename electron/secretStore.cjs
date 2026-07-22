/**
 * Electron main-side secret store (Phase 2 slice C) — safeStorage-backed
 * key→value store that backs the frontend's 7 `secret_*` commands
 * (src/utils/secretStore.ts, the frontend's single choke point for secrets).
 *
 * `safeStorage` (Electron) only offers encryptString(plaintext)->Buffer /
 * decryptString(Buffer)->string / isEncryptionAvailable()->bool — there is no
 * built-in KV store, so this module persists the encrypted blobs itself as a
 * JSON file of base64 strings, keyed by the same colon-namespaced keys the
 * frontend uses (`provider:<id>`, `aux:webSearch`, `aux:imageGen`,
 * `imagegen:<backendId>`).
 *
 * Mirrors the shape (not the crypto) of the Tauri macOS backend
 * (src-tauri/src/secrets.rs): an in-memory map loaded once at startup,
 * test-decrypted on load so entries that fail (e.g. OS keychain/key
 * rotated) are tracked in `failedKeys` rather than silently dropped, and
 * atomic (temp file + rename) persistence on every mutation.
 *
 * NOT a reproduction of secrets.bin's AES-256-GCM/HKDF format — safeStorage
 * uses the OS's own credential/keychain-backed encryption under the hood, so
 * existing Tauri-produced ciphertext is opaque to this module. See
 * docs/2026-07-22-phase2-sliceC-secret-migration-plan.md for that deferred
 * migration.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { safeStorage } = require('electron');
const { abuAppDataDir } = require('./appEnv.cjs');

const STORE_FILENAME = 'secrets.enc.json';

/** @type {string | null} */
let filePath = null;
/** key -> base64(encryptString(value)) */
let store = new Map();
/** Keys present on disk that failed to decrypt (load-time or subsequent). */
let failedKeys = new Set();
let encryptionAvailable = false;
let initialized = false;

function warn(msg, extra) {
  console.warn(`[secretStore] ${msg}`, extra !== undefined ? extra : '');
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Read the on-disk JSON blob into `store`, then test-decrypt every entry. */
function loadFromDisk() {
  store = new Map();
  failedKeys = new Set();
  if (!filePath) return;

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.trim().length > 0) {
        const json = JSON.parse(raw);
        for (const [key, b64] of Object.entries(json)) {
          if (typeof b64 === 'string') store.set(key, b64);
        }
      }
    } catch (err) {
      // Corrupt/unreadable file: fail-soft to an empty store rather than
      // crashing main — matches Tauri's posture of never locking a user out
      // entirely because of one bad entry (here: the whole file).
      warn('failed to read/parse secrets file, starting empty store', errMsg(err));
      store = new Map();
      return;
    }
  }

  if (!encryptionAvailable) {
    // Can't verify anything without safeStorage — treat every existing
    // entry as unreadable rather than pretending they're fine.
    for (const key of store.keys()) failedKeys.add(key);
    return;
  }

  for (const [key, b64] of store) {
    try {
      safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch {
      failedKeys.add(key);
    }
  }
}

/** Atomic write: temp file + rename, so a crash mid-write can't corrupt the store. */
function persist() {
  if (!filePath) return;
  try {
    const obj = {};
    for (const [k, v] of store) obj[k] = v;
    const json = JSON.stringify(obj, null, 2);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    warn('failed to persist secrets file', errMsg(err));
  }
}

/**
 * Called once from registerTauriHost(app), i.e. after app 'ready' (safeStorage
 * requires the app to be ready on some platforms).
 * @param {import('electron').App} app
 */
function initSecretStore(app) {
  if (initialized) return;
  initialized = true;

  const dir = abuAppDataDir(app);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort; write path below will surface a real error if this failed */
  }
  filePath = path.join(dir, STORE_FILENAME);

  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable();
  } catch (err) {
    encryptionAvailable = false;
    warn('safeStorage.isEncryptionAvailable() threw', errMsg(err));
  }

  if (!encryptionAvailable) {
    warn(
      'safeStorage encryption is NOT available on this system — operating in degraded mode: ' +
        'secret_get returns null, secret_set throws (surfaced to the renderer) rather than ' +
        'silently storing plaintext.'
    );
  }

  loadFromDisk();

  if (failedKeys.size > 0) {
    warn(
      `${failedKeys.size} entrie(s) failed to decrypt at load (hardware/OS-key change likely):`,
      [...failedKeys]
    );
  }
}

/** @param {string} key */
function get(key) {
  if (!encryptionAvailable) return null;
  const b64 = store.get(key);
  if (b64 === undefined) return null;
  try {
    const plain = safeStorage.decryptString(Buffer.from(b64, 'base64'));
    failedKeys.delete(key);
    return plain;
  } catch (err) {
    failedKeys.add(key);
    warn(`decrypt failed for key "${key}"`, errMsg(err));
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 */
function set(key, value) {
  if (!encryptionAvailable) {
    // Deliberate exception to fail-soft: a write silently dropped would look
    // like a successful save to the user (their key just "didn't stick").
    // Surface this to the renderer instead.
    const msg = 'safeStorage encryption unavailable — cannot store secret securely';
    warn(msg);
    throw new Error(msg);
  }
  try {
    const buf = safeStorage.encryptString(String(value));
    store.set(key, buf.toString('base64'));
    failedKeys.delete(key);
    persist();
  } catch (err) {
    // Fail-soft here (unlike the degraded-mode case above): this is an
    // unexpected encrypt/persist failure, not the known "no OS key store"
    // condition, and callers already treat secret_set as void/best-effort.
    warn(`encrypt/set failed for key "${key}"`, errMsg(err));
  }
}

/** @param {string} key */
function del(key) {
  try {
    store.delete(key);
    failedKeys.delete(key);
    persist();
  } catch (err) {
    warn(`delete failed for key "${key}"`, errMsg(err));
  }
}

/** @param {string} key */
function has(key) {
  return store.has(key);
}

function list() {
  return [...store.keys()];
}

function getFailedKeys() {
  return [...failedKeys];
}

/** Wipe everything. `knownKeys` is accepted (contract parity) but ignored — mirrors macOS Tauri behavior. */
function clearAll() {
  try {
    store.clear();
    failedKeys.clear();
    persist();
  } catch (err) {
    warn('clearAll failed', errMsg(err));
  }
}

const SECRET_CMDS = new Set([
  'secret_get',
  'secret_set',
  'secret_delete',
  'secret_has',
  'secret_list',
  'secret_failed_keys',
  'secret_clear_all',
]);

/**
 * Map a `secret_*` command to the store. Returns `undefined` when `cmd` is
 * not one of the 7 secret commands, so tauriHost.cjs knows to fall through
 * to its own dispatch()/default stub.
 * @param {string} cmd
 * @param {Record<string, unknown>} [args]
 */
function secretDispatch(cmd, args) {
  if (!SECRET_CMDS.has(cmd)) return undefined;
  const a = args || {};
  switch (cmd) {
    case 'secret_get':
      return get(String(a.key));
    case 'secret_set':
      set(String(a.key), String(a.value));
      return null;
    case 'secret_delete':
      del(String(a.key));
      return null;
    case 'secret_has':
      return has(String(a.key));
    case 'secret_list':
      return list();
    case 'secret_failed_keys':
      return getFailedKeys();
    case 'secret_clear_all':
      clearAll();
      return null;
    default:
      return undefined;
  }
}

module.exports = { initSecretStore, secretDispatch };
