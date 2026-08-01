/**
 * Electron main-side port of the Notice System SQLite storage (Phase 2
 * slice F1b), backed by Node's built-in `node:sqlite` (`DatabaseSync`). Rust
 * source of truth: `src-tauri/src/notice_db.rs` — every function here is a
 * direct port. Tables:
 *   notice_audit — every Gate decision for analytics + feedback learning
 *   notice_inbox — L2 notices queued when Gate returns queue_inbox
 *
 * The DB file lives at `{abuAppDataDir}/notice.sqlite`, created lazily on
 * first command and cached for process lifetime (mirrors catalogDb.cjs's
 * pattern — see that file's header for the node:sqlite deviation notes:
 * numbered-placeholder reuse, `undefined` not auto-coercing to NULL, no
 * `.transaction()` helper).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { abuAppDataDir } = require('./appEnv.cjs');

/** Sentinel returned when `cmd` isn't a notice command. */
const NOTICE_MISS = Symbol('notice-dispatch-miss');

let dbHandle = null;

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS notice_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_id   TEXT NOT NULL,
        type        TEXT NOT NULL,
        tier        TEXT NOT NULL,
        source      TEXT NOT NULL,
        decision    TEXT NOT NULL,
        reason      TEXT,
        delivered_to TEXT NOT NULL DEFAULT '[]',
        timestamp   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON notice_audit(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_type      ON notice_audit(type, timestamp);

    CREATE TABLE IF NOT EXISTS notice_inbox (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_id       TEXT UNIQUE NOT NULL,
        notice_json     TEXT NOT NULL,
        tier            TEXT NOT NULL,
        queued_at       INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        delivered       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_expires ON notice_inbox(expires_at);
  `);
}

/** @param {import('electron').App} app */
function getDb(app) {
  if (dbHandle) return dbHandle;
  const dir = abuAppDataDir(app);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'notice.sqlite');
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  dbHandle = db;
  return db;
}

// ── Audit ───────────────────────────────────────────────────────────────

function mapAuditRow(r) {
  let deliveredTo;
  try {
    deliveredTo = JSON.parse(r.delivered_to);
  } catch {
    deliveredTo = [];
  }
  return {
    id: r.id,
    notice_id: r.notice_id,
    type: r.type,
    tier: r.tier,
    source: r.source,
    decision: r.decision,
    reason: r.reason,
    delivered_to: Array.isArray(deliveredTo) ? deliveredTo : [],
    timestamp: r.timestamp,
  };
}

function auditInsert(db, entry) {
  const deliveredJson = JSON.stringify(entry.delivered_to ?? []);
  db.prepare(
    `INSERT INTO notice_audit (notice_id, type, tier, source, decision, reason, delivered_to, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.notice_id,
    entry.type,
    entry.tier,
    entry.source,
    entry.decision,
    entry.reason ?? null,
    deliveredJson,
    entry.timestamp,
  );
}

function auditQuery(db, since, until, noticeType, limit) {
  const lim = limit ?? 100;
  let rows;
  if (noticeType != null) {
    rows = db
      .prepare(
        `SELECT id, notice_id, type, tier, source, decision, reason, delivered_to, timestamp
         FROM notice_audit
         WHERE timestamp >= ? AND timestamp <= ? AND type = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(since, until, noticeType, lim);
  } else {
    rows = db
      .prepare(
        `SELECT id, notice_id, type, tier, source, decision, reason, delivered_to, timestamp
         FROM notice_audit
         WHERE timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(since, until, lim);
  }
  return rows.map(mapAuditRow);
}

function auditAggregate(db, since, until) {
  const rows = db
    .prepare(
      `SELECT decision, COUNT(*) AS cnt FROM notice_audit
       WHERE timestamp >= ? AND timestamp <= ?
       GROUP BY decision`,
    )
    .all(since, until);
  // Rust returns Vec<(String, i64)> — serde serializes each tuple as a
  // 2-element JSON array, matching the frontend's `[string, number][]`.
  return rows.map((r) => [r.decision, r.cnt]);
}

// ── Inbox ───────────────────────────────────────────────────────────────

function mapInboxRow(r) {
  return {
    id: r.id,
    notice_id: r.notice_id,
    notice_json: r.notice_json,
    tier: r.tier,
    queued_at: r.queued_at,
    expires_at: r.expires_at,
    delivered: r.delivered !== 0,
  };
}

function inboxInsert(db, entry) {
  db.prepare(
    `INSERT OR IGNORE INTO notice_inbox (notice_id, notice_json, tier, queued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(entry.notice_id, entry.notice_json, entry.tier, entry.queued_at, entry.expires_at);
}

function inboxPending(db, now) {
  const rows = db
    .prepare(
      `SELECT id, notice_id, notice_json, tier, queued_at, expires_at, delivered
       FROM notice_inbox
       WHERE delivered = 0 AND expires_at > ?
       ORDER BY queued_at ASC`,
    )
    .all(now);
  return rows.map(mapInboxRow);
}

function inboxMarkDelivered(db, noticeId) {
  db.prepare('UPDATE notice_inbox SET delivered = 1 WHERE notice_id = ?').run(noticeId);
}

function inboxCleanup(db, now) {
  const result = db.prepare('DELETE FROM notice_inbox WHERE expires_at <= ? OR delivered = 1').run(now);
  return result.changes;
}

// ── Dispatch (mirrors the #[tauri::command] entry points) ─────────────────

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
function noticeDispatch(app, cmd, args) {
  const a = args || {};

  switch (cmd) {
    case 'notice_audit_insert': {
      const db = getDb(app);
      auditInsert(db, a.entry);
      return null;
    }

    case 'notice_audit_query': {
      const db = getDb(app);
      return auditQuery(db, a.since, a.until, a.noticeType ?? null, a.limit);
    }

    case 'notice_audit_aggregate': {
      const db = getDb(app);
      return auditAggregate(db, a.since, a.until);
    }

    case 'notice_inbox_insert': {
      const db = getDb(app);
      inboxInsert(db, a.entry);
      return null;
    }

    case 'notice_inbox_pending': {
      const db = getDb(app);
      return inboxPending(db, a.now);
    }

    case 'notice_inbox_mark_delivered': {
      const db = getDb(app);
      inboxMarkDelivered(db, a.noticeId);
      return null;
    }

    case 'notice_inbox_cleanup': {
      const db = getDb(app);
      return inboxCleanup(db, a.now);
    }

    default:
      return NOTICE_MISS;
  }
}

module.exports = {
  noticeDispatch,
  NOTICE_MISS,
  // Exported for the headless verify harness (electron/spike/f1bVerify.cjs).
  _internal: {
    getDb,
    auditInsert,
    auditQuery,
    auditAggregate,
    inboxInsert,
    inboxPending,
    inboxMarkDelivered,
    inboxCleanup,
  },
};
