'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const MAX_RECORDS = 512;
const MAX_KEY_LENGTH = 1024;
const MAX_NAME_LENGTH = 200;
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const TIERS = new Set(['ordinary', 'approval-required']);
const SOURCES = new Set(['dialog', 'settings']);

/**
 * The identity key is the Gate's own classification key, never a new one:
 * Windows reports `aumid:<lowercase AUMID>` for packaged apps and the
 * lowercase executable path otherwise; macOS reports the bundle id.
 */
function grantIdentityKey(identity) {
  const value = typeof identity?.bundle_id === 'string'
    ? identity.bundle_id.trim().toLowerCase()
    : '';
  return value && value.length <= MAX_KEY_LENGTH ? value : null;
}

/**
 * What a remembered grant binds to besides the key. A validly signed
 * executable binds to its signer subject: a renamed or replaced binary with
 * another signer (or none) does not inherit the grant. Packaged apps carry
 * the publisher in the AUMID and bind to `package-trusted`. Unsigned apps
 * bind by key only — the same weakness the ordinary-tier trust rule accepts.
 */
function grantSignature(identity) {
  const signatureStatus = typeof identity?.signature_status === 'string'
    && identity.signature_status.trim()
    ? identity.signature_status.trim().toLowerCase()
    : null;
  const signer = signatureStatus === 'valid'
    && typeof identity?.signer_subject === 'string'
    && identity.signer_subject.trim()
    ? identity.signer_subject.trim()
    : null;
  return { signatureStatus, signer };
}

function displayNameOf(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name ? name.slice(0, MAX_NAME_LENGTH) : fallback;
}

function publicGrant(record) {
  return {
    key: record.key,
    displayName: record.displayName,
    tier: record.tier,
    grantedAt: record.grantedAt,
    lastUsedAt: record.lastUsedAt,
    source: record.source,
  };
}

function publicDenied(record) {
  return {
    key: record.key,
    displayName: record.displayName,
    deniedAt: record.deniedAt,
  };
}

/**
 * Durable per-app Computer Use grants ("always allow") and the user's denied
 * list. Only the Host Gate reads and writes it; the renderer sees the
 * `list()` projection. Records hold an identity key, a display name, the
 * tier at grant time, the signer binding and timestamps — no task, no
 * window title, no content. Hard-deny apps never reach this store.
 */
function createComputerUseGrantStore({
  filePath = null,
  platform = process.platform,
  now = () => Date.now(),
  onError = () => {},
} = {}) {
  const grants = new Map();
  const denied = new Map();
  let loaded = false;

  function validGrant(item) {
    if (
      typeof item?.key !== 'string'
      || !item.key
      || item.key.length > MAX_KEY_LENGTH
      || !PLATFORMS.has(item.platform)
      || !TIERS.has(item.tier)
      || !Number.isFinite(item.grantedAt)
      || !Number.isFinite(item.lastUsedAt)
      || (item.signatureStatus !== null && typeof item.signatureStatus !== 'string')
      || (item.signer !== null && typeof item.signer !== 'string')
    ) {
      return null;
    }
    return {
      key: item.key,
      displayName: displayNameOf(item.displayName, item.key),
      platform: item.platform,
      tier: item.tier,
      signatureStatus: item.signatureStatus,
      signer: item.signer,
      grantedAt: item.grantedAt,
      lastUsedAt: item.lastUsedAt,
      source: SOURCES.has(item.source) ? item.source : 'dialog',
    };
  }

  function validDenied(item) {
    if (
      typeof item?.key !== 'string'
      || !item.key
      || item.key.length > MAX_KEY_LENGTH
      || !PLATFORMS.has(item.platform)
      || !Number.isFinite(item.deniedAt)
    ) {
      return null;
    }
    return {
      key: item.key,
      displayName: displayNameOf(item.displayName, item.key),
      platform: item.platform,
      deniedAt: item.deniedAt,
    };
  }

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION) return;
      for (const item of Array.isArray(parsed.grants) ? parsed.grants : []) {
        const record = validGrant(item);
        if (record) grants.set(record.key, record);
      }
      for (const item of Array.isArray(parsed.denied) ? parsed.denied : []) {
        const record = validDenied(item);
        if (record) denied.set(record.key, record);
      }
      trim();
    } catch (error) {
      onError(error);
    }
  }

  function trim() {
    if (grants.size > MAX_RECORDS) {
      const oldest = [...grants.values()]
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
        .slice(0, grants.size - MAX_RECORDS);
      for (const record of oldest) grants.delete(record.key);
    }
    if (denied.size > MAX_RECORDS) {
      const oldest = [...denied.values()]
        .sort((left, right) => left.deniedAt - right.deniedAt)
        .slice(0, denied.size - MAX_RECORDS);
      for (const record of oldest) denied.delete(record.key);
    }
  }

  function persist() {
    if (!filePath) return true;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({
        version: STORE_VERSION,
        grants: [...grants.values()],
        denied: [...denied.values()],
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function keyOf(entry) {
    if (typeof entry?.key === 'string' && entry.key.trim()) {
      const key = entry.key.trim().toLowerCase();
      return key.length <= MAX_KEY_LENGTH ? key : null;
    }
    return grantIdentityKey(entry);
  }

  /** The remembered grant for this identity when the key and signer match; touches `lastUsedAt`. */
  function remembered(identity) {
    load();
    const key = grantIdentityKey(identity);
    const record = key ? grants.get(key) : null;
    if (!record || record.platform !== platform) return null;
    const signature = grantSignature(identity);
    if (
      record.signatureStatus !== signature.signatureStatus
      || record.signer !== signature.signer
    ) {
      return null;
    }
    record.lastUsedAt = now();
    persist();
    return Object.freeze(publicGrant(record));
  }

  function isDenied(identity) {
    load();
    const key = keyOf(identity);
    const record = key ? denied.get(key) : null;
    return Boolean(record && record.platform === platform);
  }

  function grant(identity, { tier, source = 'dialog' } = {}) {
    load();
    const key = grantIdentityKey(identity);
    if (!key) throw new Error('Computer Use grant identity is unavailable');
    if (!TIERS.has(tier)) throw new Error(`Computer Use grant tier is invalid: ${tier}`);
    const at = now();
    const record = {
      key,
      displayName: displayNameOf(identity?.app_name, key),
      platform,
      tier,
      ...grantSignature(identity),
      grantedAt: at,
      lastUsedAt: at,
      source: SOURCES.has(source) ? source : 'dialog',
    };
    grants.set(key, record);
    denied.delete(key);
    trim();
    const persisted = persist();
    return Object.freeze({ ...publicGrant(record), persisted });
  }

  function revoke(entry) {
    load();
    const key = keyOf(entry);
    if (!key || !grants.delete(key)) return false;
    persist();
    return true;
  }

  /** Settings-only: put an app on (or take it off) the user's denied list; denying also revokes. */
  function setDenied(entry, isDeniedNow) {
    load();
    const key = keyOf(entry);
    if (!key) throw new Error('Computer Use grant identity is unavailable');
    if (isDeniedNow) {
      const previous = grants.get(key) ?? denied.get(key);
      denied.set(key, {
        key,
        displayName: displayNameOf(entry?.displayName ?? entry?.app_name, previous?.displayName ?? key),
        platform,
        deniedAt: now(),
      });
      grants.delete(key);
    } else {
      denied.delete(key);
    }
    trim();
    return persist();
  }

  function list() {
    load();
    return {
      grants: [...grants.values()]
        .filter((record) => record.platform === platform)
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .map(publicGrant),
      denied: [...denied.values()]
        .filter((record) => record.platform === platform)
        .sort((left, right) => right.deniedAt - left.deniedAt)
        .map(publicDenied),
    };
  }

  return Object.freeze({ remembered, isDenied, grant, revoke, setDenied, list });
}

module.exports = {
  createComputerUseGrantStore,
  grantIdentityKey,
  grantSignature,
  STORE_VERSION,
  MAX_RECORDS,
};
