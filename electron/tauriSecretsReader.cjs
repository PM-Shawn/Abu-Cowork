/**
 * Pure-Node reader for the Tauri macOS secrets file (`secrets.bin`) — the
 * decrypt half of the Tauri→Electron secret migration (handoff item #3,
 * docs/2026-07-22-phase2-sliceC-secret-migration-plan.md).
 *
 * The Tauri shell (src-tauri/src/secrets.rs, `mod macos`) stores provider API
 * keys as AES-256-GCM ciphertext in `<Tauri appData>/secrets.bin`, with the
 * key derived from the machine's IOPlatformUUID via HKDF-SHA256. This module
 * reproduces that exact derivation + byte layout in node:crypto so the
 * Electron shell can decrypt the entries once and re-encrypt them through
 * safeStorage (electron/secretStore.cjs). Verified against real
 * Tauri-produced files (GCM auth tag authenticates 28/28 entries across two
 * real installs — the tag is a cryptographic proof the derivation and layout
 * match; a single wrong byte in the key fails every tag).
 *
 * Format facts (transcribed from secrets.rs, the source of truth):
 *  - File is JSON despite the .bin extension:
 *      { "version": 1, "entries": { "<key>": "<base64>" } }
 *  - Each entry, base64-decoded: [12-byte nonce][ciphertext][16-byte GCM tag]
 *  - key = HKDF-SHA256(ikm = UTF-8 bytes of the IOPlatformUUID string,
 *          salt = "abu.secrets.v1", info = "abu-secrets-aes256gcm", len = 32)
 *  - Partial-failure semantics: one undecryptable entry (tampered, truncated,
 *    machine changed) must NOT fail the load — it is reported in `failed`
 *    while the rest still decrypt (mirrors secrets.rs `decrypt_all`).
 *
 * Zero Electron imports — usable from plain-Node tests and harnesses.
 */
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HKDF_SALT = Buffer.from('abu.secrets.v1');
const HKDF_INFO = Buffer.from('abu-secrets-aes256gcm');
const FILE_FORMAT_VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Fetch the machine UUID exactly as the Rust `machine_uid` crate does on
 * macOS: the IOPlatformUUID from IORegistry (36-char uppercase string,
 * hyphens included). The UTF-8 bytes of this string are the HKDF input key
 * material — any casing/whitespace difference derives a different key, so
 * this must stay byte-identical to `machine_uid::get()`.
 * @returns {string}
 */
function getMachineUuid() {
  if (process.platform !== 'darwin') {
    throw new Error(`getMachineUuid: only supported on macOS (got ${process.platform})`);
  }
  const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    encoding: 'utf8',
  });
  const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new Error('getMachineUuid: IOPlatformUUID not found in ioreg output');
  }
  return m[1];
}

/**
 * Derive the AES-256-GCM key from a machine UUID string (HKDF-SHA256 with
 * the fixed salt/info from secrets.rs).
 * @param {string} machineUuid
 * @returns {Buffer} 32-byte key
 */
function deriveTauriKey(machineUuid) {
  // hkdfSync returns an ArrayBuffer — wrap it so callers get a real Buffer.
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(machineUuid, 'utf8'), HKDF_SALT, HKDF_INFO, KEY_LEN)
  );
}

/**
 * Decrypt one packed entry. Throws on any failure (bad base64, truncated,
 * GCM auth reject, non-UTF-8 plaintext) — the caller collects failures
 * per-key rather than aborting the whole read.
 * @param {Buffer} key
 * @param {string} b64
 * @returns {string} plaintext
 */
function decryptEntry(key, b64) {
  const packed = Buffer.from(b64, 'base64');
  // nonce + tag is the minimum valid size (== that exactly ⇒ empty plaintext,
  // which the Rust side happily produces/decrypts, so it must pass here too).
  if (packed.length < NONCE_LEN + TAG_LEN) {
    throw new Error('truncated entry');
  }
  const nonce = packed.subarray(0, NONCE_LEN);
  const ctWithTag = packed.subarray(NONCE_LEN);
  const tag = ctWithTag.subarray(ctWithTag.length - TAG_LEN);
  const ct = ctWithTag.subarray(0, ctWithTag.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  // Reject invalid UTF-8 like the Rust side's String::from_utf8 does, instead
  // of silently substituting replacement chars into what may be an API key.
  const text = plain.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), plain) !== 0) {
    throw new Error('plaintext is not valid UTF-8');
  }
  return text;
}

/**
 * Read + decrypt a Tauri secrets.bin.
 *
 * @param {string} filePath
 * @param {Buffer} key 32-byte AES key (from deriveTauriKey)
 * @returns {{ entries: Map<string, string>, failed: string[] } | null}
 *   null when the file does not exist; empty result for an empty file.
 *   THROWS on unparseable JSON or an unsupported format version — the caller
 *   decides how to surface that (never guess at an unknown layout).
 */
function readTauriSecrets(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length === 0) return { entries: new Map(), failed: [] };

  /** @type {{ version?: unknown, entries?: Record<string, unknown> }} */
  let model;
  try {
    model = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `readTauriSecrets: unparseable secrets file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (model.version !== FILE_FORMAT_VERSION) {
    throw new Error(`readTauriSecrets: unsupported secrets file version ${String(model.version)}`);
  }

  const entries = new Map();
  const failed = [];
  for (const [k, b64] of Object.entries(model.entries || {})) {
    if (typeof b64 !== 'string') {
      failed.push(k);
      continue;
    }
    try {
      entries.set(k, decryptEntry(key, b64));
    } catch {
      failed.push(k);
    }
  }
  return { entries, failed };
}

/**
 * TEST/HARNESS ONLY — encrypt a plaintext map into the Tauri packed format
 * (mirrors secrets.rs `encrypt_all`: fresh random 12-byte nonce per entry,
 * base64(nonce || ct || tag)). Production code never writes the Tauri format;
 * this exists so tests and the migration harness can synthesize realistic
 * secrets.bin fixtures.
 * @param {Buffer} key
 * @param {Record<string, string>} plainObj
 * @returns {Record<string, string>} key → base64 packed ciphertext
 */
function encryptTauriEntries(key, plainObj) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(plainObj)) {
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([cipher.update(Buffer.from(v, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    out[k] = Buffer.concat([nonce, ct, tag]).toString('base64');
  }
  return out;
}

/**
 * TEST/HARNESS ONLY — write a complete Tauri-format secrets.bin fixture.
 * @param {string} filePath
 * @param {Buffer} key
 * @param {Record<string, string>} plainObj
 */
function writeTauriSecretsFile(filePath, key, plainObj) {
  const model = { version: FILE_FORMAT_VERSION, entries: encryptTauriEntries(key, plainObj) };
  fs.writeFileSync(filePath, JSON.stringify(model), 'utf8');
}

module.exports = {
  getMachineUuid,
  deriveTauriKey,
  readTauriSecrets,
  encryptTauriEntries,
  writeTauriSecretsFile,
};
