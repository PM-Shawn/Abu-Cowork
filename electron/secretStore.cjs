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

/** Read the on-disk JSON blob into `store`. Decrypt is LAZY (see note). */
function loadFromDisk() {
  store = new Map();
  failedKeys = new Set();
  if (!filePath || !fs.existsSync(filePath)) return;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    warn('failed to read secrets file, starting empty store', errMsg(err));
    return;
  }
  if (raw.trim().length === 0) return;

  try {
    const json = JSON.parse(raw);
    for (const [key, b64] of Object.entries(json)) {
      if (typeof b64 === 'string') store.set(key, b64);
    }
  } catch (err) {
    // Corrupt/unparseable file: do NOT start empty and let the next write
    // overwrite it — that would permanently discard recoverable ciphertext
    // (silent total key loss). Preserve the file aside first, THEN continue
    // empty so a fresh store can be built without destroying the old blobs.
    const aside = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(filePath, aside);
      warn(`secrets file corrupt/unparseable — preserved as ${aside}, starting empty`, errMsg(err));
    } catch (renameErr) {
      warn('secrets file corrupt AND could not be preserved aside', errMsg(renameErr));
    }
    store = new Map();
    return;
  }

  // failedKeys is populated LAZILY by get() — the frontend reads every provider
  // key at boot, so a failed decrypt is caught there. We deliberately do NOT
  // eager-decrypt every entry here: that would run a synchronous decryptString
  // over the whole store on the main thread before the window, and on a
  // re-signed macOS build (dev rebuilds ad-hoc re-sign) the first Keychain
  // access can raise a modal prompt that hangs launch. When safeStorage is
  // unavailable we can't read anything at all, so mark all as failed up front
  // (no decrypt call involved).
  if (!encryptionAvailable) {
    for (const key of store.keys()) failedKeys.add(key);
  }
}

/**
 * Atomic durable write: temp file + fsync + rename. THROWS on failure so the
 * caller (secret_set/delete/clear_all) rejects the invoke — a swallowed write
 * error would report a save as successful yet be gone after restart (matches
 * the Tauri backend, whose persist() propagates its Err to the frontend).
 */
function persist() {
  if (!filePath) return;
  const obj = {};
  for (const [k, v] of store) obj[k] = v;
  const json = JSON.stringify(obj, null, 2);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, json, 'utf8');
  // fsync the temp file's data blocks before the rename (Rust's sync_all), so a
  // crash/power-loss right after the (journaled) rename can't expose a
  // truncated/zero-length store — which would silently lose every key.
  const fd = fs.openSync(tmp, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
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
    // A write silently dropped would look like a successful save (the key just
    // "didn't stick"). Surface it to the renderer instead.
    const msg = 'safeStorage encryption unavailable — cannot store secret securely';
    warn(msg);
    throw new Error(msg);
  }
  // No swallowing catch: an encrypt or persist (durability) failure must reject
  // secret_set so the user learns the key wasn't saved, rather than seeing a
  // fake success and finding it gone after restart (matches the Tauri backend).
  const buf = safeStorage.encryptString(String(value));
  store.set(key, buf.toString('base64'));
  failedKeys.delete(key);
  persist();
}

/** @param {string} key */
function del(key) {
  store.delete(key);
  failedKeys.delete(key);
  persist();
}

/** @param {string} key */
function has(key) {
  // Exclude undecryptable keys — matches Tauri macOS, where the in-memory index
  // holds only decryptable secrets (failed keys live only in failed_keys()).
  return store.has(key) && !failedKeys.has(key);
}

function list() {
  return [...store.keys()].filter((k) => !failedKeys.has(k));
}

function getFailedKeys() {
  return [...failedKeys];
}

/** Wipe everything. `knownKeys` is accepted (contract parity) but ignored — mirrors macOS Tauri behavior. */
function clearAll() {
  store.clear();
  failedKeys.clear();
  persist();
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
