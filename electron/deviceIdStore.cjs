/**
 * File-backed persistence for the analytics `device_id`.
 *
 * WHY: the renderer (src/utils/deviceId.ts) kept the id in localStorage only.
 * Under Electron that lands in the CHROMIUM PROFILE (userData/Local Storage/
 * leveldb) — the most fragile tier we have: a reinstall, a "clear cache", a
 * profile reset, or Chromium's own quota eviction wipes it, the renderer mints
 * a fresh uuid, and the console counts one machine as N devices.
 *
 * The fix is deliberately minimal — the SAME random uuid, written one more
 * place. No hardware fingerprint, no machine id, no new signal (the analytics
 * design doc's constraint: "精简，不上指纹").
 *
 * The file lives in abuAppDataDir(), which is a SIBLING of the Chromium
 * profile (`.../com.abu.app.electron` vs `.../Abu`), not a child — so wiping
 * renderer storage cannot take it with it.
 *
 * Reconciliation runs in preload (electron/preload.cjs) at preload-eval time,
 * before any renderer module evaluates, so `getDeviceId()` stays SYNCHRONOUS
 * and every existing call site is untouched.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEVICE_ID_CHANNEL = 'abu:device-id:resolve';
const DEVICE_ID_FILENAME = 'device-id.json';
const RECORD_VERSION = 1;
const MAX_DEVICE_ID_CHARS = 256;

/** Control characters would survive JSON round-tripping but corrupt any log line. */
function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Deliberately LENIENT — this same predicate gates the id we adopt from an
 * existing user's localStorage, and adopting it unchanged is the whole point
 * of the migration path. Rejecting a legitimate legacy id (e.g. by demanding a
 * strict uuid-v4 shape) would mint a replacement and produce exactly the
 * "every user is suddenly new" artifact this change exists to prevent.
 *
 * Mirrors tauriLocalStorageMigration.cjs's own `abu_device_id` validator
 * (non-empty, <= 256 chars) plus a control-character guard, since unlike that
 * one this value gets written back into a JSON file.
 */
function isValidDeviceId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DEVICE_ID_CHARS &&
    !hasControlChars(value)
  );
}

/** Same shape the renderer's generateId() produced, so ids stay indistinguishable. */
function generateDeviceId() {
  return crypto.randomUUID();
}

function deviceIdFilePath(dir) {
  return path.join(dir, DEVICE_ID_FILENAME);
}

/** @returns {string|null} the stored id, or null if absent/unreadable/corrupt. */
function readDeviceIdFile(dir) {
  try {
    const record = JSON.parse(fs.readFileSync(deviceIdFilePath(dir), 'utf8'));
    if (record?.version !== RECORD_VERSION) return null;
    return isValidDeviceId(record?.deviceId) ? record.deviceId : null;
  } catch {
    // Absent, truncated, or hand-mangled — treated the same as "no file yet",
    // which falls through to adopting localStorage rather than minting.
    return null;
  }
}

/**
 * Atomic write (staging + rename), same discipline as the migration sentinel:
 * a half-written file would read back as corrupt and, on the next launch,
 * silently promote a NEW id.
 * @returns {boolean} whether the id is now durably on disk.
 */
function writeDeviceIdFile(dir, deviceId, source) {
  const target = deviceIdFilePath(dir);
  const staging = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      staging,
      JSON.stringify(
        {
          version: RECORD_VERSION,
          deviceId,
          source,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
    fs.renameSync(staging, target);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      // The rename already consumed it on the success path.
    }
  }
}

/**
 * Resolve the authoritative device id for this machine.
 *
 * Precedence — file > localStorage > mint:
 *  - `file`          the file already holds an id; it wins, and the caller
 *                    writes it back into localStorage if they disagree.
 *  - `local-storage` MIGRATION: no file yet but this user already has an id.
 *                    Adopt it verbatim and persist. Never mint here — minting
 *                    would reset every existing user to "new" in one release.
 *  - `generated`     genuinely first launch.
 *
 * Never throws: on any fs failure it degrades to the caller's localStorage
 * value (or a fresh id) with `persisted: false`, and the next launch retries.
 *
 * @param {{dir: string, localStorageId?: unknown}} options
 * @returns {{id: string, source: 'file'|'local-storage'|'generated', persisted: boolean}}
 */
function resolveDeviceId({ dir, localStorageId }) {
  const fileId = readDeviceIdFile(dir);
  if (fileId) return { id: fileId, source: 'file', persisted: true };

  const adopted = isValidDeviceId(localStorageId) ? localStorageId : null;
  const id = adopted ?? generateDeviceId();
  const source = adopted ? 'local-storage' : 'generated';
  return { id, source, persisted: writeDeviceIdFile(dir, id, source) };
}

module.exports = {
  DEVICE_ID_CHANNEL,
  DEVICE_ID_FILENAME,
  RECORD_VERSION,
  MAX_DEVICE_ID_CHARS,
  isValidDeviceId,
  generateDeviceId,
  deviceIdFilePath,
  readDeviceIdFile,
  writeDeviceIdFile,
  resolveDeviceId,
};
