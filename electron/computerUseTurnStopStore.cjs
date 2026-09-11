'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 256;

function hashTurnKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function normalizeReason(reason) {
  const value = String(reason || 'stopped')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return value || 'stopped';
}

/**
 * Durable, content-free stop markers for Computer Use turns.
 *
 * Only a SHA-256 digest of conversationId + loopId is persisted. A marker is
 * deliberately not cleared by normal task cleanup: renderer/sidecar/helper
 * restarts must not make the same stopped turn runnable again. A new loopId is
 * the recovery boundary.
 */
function createComputerUseTurnStopStore({
  filePath = null,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  onError = () => {},
} = {}) {
  const records = new Map();
  let loaded = false;

  function prune() {
    const current = now();
    for (const [digest, record] of records) {
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= current) {
        records.delete(digest);
      }
    }
    if (records.size <= MAX_RECORDS) return;
    const oldest = [...records.entries()]
      .sort((left, right) => left[1].stoppedAt - right[1].stoppedAt)
      .slice(0, records.size - MAX_RECORDS);
    for (const [digest] of oldest) records.delete(digest);
  }

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.records)) return;
      for (const item of parsed.records) {
        if (
          typeof item?.digest !== 'string'
          || !/^[a-f0-9]{64}$/.test(item.digest)
          || typeof item?.reason !== 'string'
          || !Number.isFinite(item?.stoppedAt)
          || !Number.isFinite(item?.expiresAt)
        ) continue;
        records.set(item.digest, {
          reason: normalizeReason(item.reason),
          stoppedAt: item.stoppedAt,
          expiresAt: item.expiresAt,
        });
      }
      prune();
    } catch (error) {
      onError(error);
    }
  }

  function persist() {
    if (!filePath) return true;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({
        version: STORE_VERSION,
        records: [...records.entries()].map(([digest, record]) => ({ digest, ...record })),
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function get(key) {
    load();
    prune();
    const record = records.get(hashTurnKey(key));
    return record ? Object.freeze({ ...record }) : null;
  }

  function stop(key, reason = 'stopped') {
    load();
    const stoppedAt = now();
    const record = {
      reason: normalizeReason(reason),
      stoppedAt,
      expiresAt: stoppedAt + ttlMs,
    };
    records.set(hashTurnKey(key), record);
    prune();
    const persisted = persist();
    return Object.freeze({ ...record, persisted });
  }

  function snapshot() {
    load();
    prune();
    return [...records.values()].map((record) => ({ ...record }));
  }

  return Object.freeze({ get, stop, snapshot });
}

module.exports = {
  createComputerUseTurnStopStore,
  hashTurnKey,
  normalizeReason,
  STORE_VERSION,
  DEFAULT_TTL_MS,
  MAX_RECORDS,
};
