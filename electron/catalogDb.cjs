/**
 * Electron main-side port of the conversation catalog SQLite storage
 * (Phase 2 slice F1b), backed by Node's built-in `node:sqlite` (Electron 43
 * bundles Node 24.18, which ships `node:sqlite` with `DatabaseSync` — no
 * better-sqlite3, no native rebuild). Rust source of truth:
 * `src-tauri/src/catalog_db.rs` — every function here is a line-for-line
 * port of its `*_core` counterpart there; see that file's module doc for the
 * invariant this whole module obeys:
 *
 *   Plaintext JSONL (`{conversationsRoot}/{convId}/messages.jsonl`) is ALWAYS
 *   the source of truth. `catalog.sqlite` is ALWAYS a disposable projection
 *   of it — delete the file at any time and the next `catalog_reconcile`
 *   rebuilds it byte-for-byte identical from JSONL. Nothing here may ever
 *   write to, move, or delete a JSONL file.
 *
 * ## node:sqlite deviations from rusqlite (behavior preserved, syntax adapted)
 * - Binding style: positional `?`/`?N` (numbered placeholders), matching
 *   rusqlite's `params![]` + `?1`/`?2`-style SQL used in `bump_count_core`.
 *   Verified node:sqlite supports numbered placeholder REUSE (`?2` appearing
 *   twice in one statement, bound once) exactly like SQLite's native numbered
 *   parameters — so `bump_count_core` below binds the SAME 6-value array
 *   Rust's `params![conv_id, updated_at, delta, last_message_id, source_bytes,
 *   source_mtime]` does, not a manually-duplicated array.
 * - `undefined` does NOT auto-coerce to SQL NULL (node:sqlite throws
 *   "Provided value cannot be bound to SQLite parameter N" on undefined,
 *   unlike rusqlite's `Option<T>::None` → NULL). Every nullable field is
 *   explicitly `?? null`-coalesced before binding.
 * - Transactions: `DatabaseSync` has no `.transaction()` helper (unlike
 *   better-sqlite3) — `reconcile_apply_core`/`reindex_apply_core` use manual
 *   `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK`, verified to work identically
 *   to rusqlite's `unchecked_transaction()`.
 * - FTS5 `tokenize='trigram'` and the `snippet()`/`bm25()` aux functions
 *   against an aliased FROM (`conversation_fts f`) work identically to
 *   rusqlite/sqlite3 — verified empirically (3-char+ CJK MATCH hits, 2-char
 *   CJK MATCH returns zero, same trigram-inherent limitation as Rust, which
 *   is why `search_core` falls back to a LIKE scan under 3 chars there too).
 * - Rows come back as `Object.create(null)` instances (no Object prototype) —
 *   fine for property access and JSON serialization, but never `instanceof
 *   Object`; `rowFromSql` rebuilds a plain object anyway (for the
 *   `missing` int→bool conversion), so this is a non-issue.
 *
 * No triggers are used (matches Rust: `conversation_fts` is a plain,
 * non-content-linked FTS5 table — every write is an explicit delete-then-
 * insert via `fts_upsert_core`, never a content-table trigger).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { abuAppDataDir } = require('./appEnv.cjs');

/** Sentinel returned when `cmd` isn't a catalog command. */
const CATALOG_MISS = Symbol('catalog-dispatch-miss');

const ROW_COLUMNS =
  'conv_id, title, created_at, updated_at, message_count, last_message_id, model, source_bytes, source_mtime, missing';

// ── Lazy singleton DB handle (cached for process lifetime) ────────────────

let dbHandle = null;

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS conversation_catalog (
        conv_id         TEXT PRIMARY KEY,
        title           TEXT NOT NULL DEFAULT '',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        message_count   INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT,
        model           TEXT,
        source_bytes    INTEGER NOT NULL DEFAULT 0,
        source_mtime    INTEGER,
        missing         INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS catalog_updated_idx
        ON conversation_catalog (updated_at DESC, created_at DESC, conv_id)
        WHERE missing = 0;

    CREATE TABLE IF NOT EXISTS catalog_sync_state (
        id                     INTEGER PRIMARY KEY CHECK (id = 1),
        initial_build_complete INTEGER NOT NULL DEFAULT 0,
        observation_sequence   INTEGER NOT NULL DEFAULT 0,
        schema_version         INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO catalog_sync_state (id, initial_build_complete, observation_sequence, schema_version)
        VALUES (1, 0, 0, 1);

    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
        conv_id UNINDEXED,
        title,
        body,
        tokenize = 'trigram'
    );
  `);
}

/** @param {import('electron').App} app */
function getDb(app) {
  if (dbHandle) return dbHandle;
  const dir = abuAppDataDir(app);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'catalog.sqlite');
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  dbHandle = db;
  return db;
}

// ── Row shape helpers ──────────────────────────────────────────────────────

function rowFromSql(r) {
  return {
    conv_id: r.conv_id,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
    message_count: r.message_count,
    last_message_id: r.last_message_id,
    model: r.model,
    source_bytes: r.source_bytes,
    source_mtime: r.source_mtime,
    missing: r.missing !== 0,
  };
}

// ── Core (mirrors catalog_db.rs's `*_core` functions) ─────────────────────

function upsertCore(db, row) {
  db.prepare(
    `INSERT INTO conversation_catalog (${ROW_COLUMNS})
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(conv_id) DO UPDATE SET
       title = excluded.title,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       message_count = excluded.message_count,
       last_message_id = excluded.last_message_id,
       model = COALESCE(excluded.model, conversation_catalog.model),
       source_bytes = excluded.source_bytes,
       source_mtime = excluded.source_mtime,
       missing = excluded.missing`,
  ).run(
    row.conv_id,
    row.title,
    row.created_at,
    row.updated_at,
    row.message_count,
    row.last_message_id ?? null,
    row.model ?? null,
    row.source_bytes,
    row.source_mtime ?? null,
    row.missing ? 1 : 0,
  );
}

/** Create-time upsert: `ON CONFLICT DO NOTHING` — never clobbers a live row a
 * concurrent bump_count already established (mirrors `create_conversation_core`). */
function createConversationCore(db, row) {
  db.prepare(
    `INSERT INTO conversation_catalog (${ROW_COLUMNS})
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(conv_id) DO NOTHING`,
  ).run(
    row.conv_id,
    row.title,
    row.created_at,
    row.updated_at,
    row.message_count,
    row.last_message_id ?? null,
    row.model ?? null,
    row.source_bytes,
    row.source_mtime ?? null,
    row.missing ? 1 : 0,
  );
}

function getCore(db, convId) {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM conversation_catalog WHERE conv_id = ?`).get(convId);
  return row ? rowFromSql(row) : null;
}

function listCore(db, limit, offset, orderDesc) {
  const order = orderDesc ? 'DESC' : 'ASC';
  const rows = db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM conversation_catalog
       WHERE missing = 0
       ORDER BY updated_at ${order}, created_at ${order}, conv_id
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
  return rows.map(rowFromSql);
}

/** Mirrors `bump_count_core`'s numbered-placeholder SQL exactly — `?2` (updated_at)
 * and `?4`/`?5`/`?6` each appear twice; node:sqlite supports numbered-placeholder
 * reuse, so this binds the SAME 6-value array Rust's `params![]` does. */
function bumpCountCore(db, convId, delta, updatedAt, lastMessageId, sourceBytes, sourceMtime) {
  db.prepare(
    `INSERT INTO conversation_catalog
        (conv_id, title, created_at, updated_at, message_count, last_message_id, source_bytes, source_mtime, missing)
     VALUES (?1, '', ?2, ?2, ?3, ?4, COALESCE(?5, 0), ?6, 0)
     ON CONFLICT(conv_id) DO UPDATE SET
       message_count = message_count + ?3,
       updated_at = ?2,
       last_message_id = COALESCE(?4, last_message_id),
       source_bytes = COALESCE(?5, source_bytes),
       source_mtime = COALESCE(?6, source_mtime)`,
  ).run(convId, updatedAt, delta, lastMessageId ?? null, sourceBytes ?? null, sourceMtime ?? null);
}

function ftsDeleteCore(db, convId) {
  db.prepare('DELETE FROM conversation_fts WHERE conv_id = ?').run(convId);
}

/** Soft-delete: flips `missing=1` AND drops the FTS row (fix parity: a
 * soft-deleted conversation must not keep showing up in search). */
function markMissingCore(db, convId) {
  db.prepare('UPDATE conversation_catalog SET missing = 1 WHERE conv_id = ?').run(convId);
  ftsDeleteCore(db, convId);
}

function getSyncStateCore(db) {
  const row = db
    .prepare('SELECT initial_build_complete, observation_sequence, schema_version FROM catalog_sync_state WHERE id = 1')
    .get();
  return {
    initial_build_complete: row.initial_build_complete !== 0,
    observation_sequence: row.observation_sequence,
    schema_version: row.schema_version,
  };
}

function setInitialBuildCompleteCore(db, complete) {
  db.prepare('UPDATE catalog_sync_state SET initial_build_complete = ? WHERE id = 1').run(complete ? 1 : 0);
}

function bumpObservationSequenceCore(db) {
  db.exec('UPDATE catalog_sync_state SET observation_sequence = observation_sequence + 1 WHERE id = 1');
  return db.prepare('SELECT observation_sequence FROM catalog_sync_state WHERE id = 1').get().observation_sequence;
}

/** `may_exist=false` skips the DELETE (brand-new conv_id during the initial
 * full-scan build) — see fts_upsert_core's doc in catalog_db.rs for why this
 * avoids an O(N^2) full-table-scan DELETE (conv_id is UNINDEXED). */
function ftsUpsertCore(db, convId, title, body, mayExist) {
  if (mayExist) {
    db.prepare('DELETE FROM conversation_fts WHERE conv_id = ?').run(convId);
  }
  db.prepare('INSERT INTO conversation_fts (conv_id, title, body) VALUES (?, ?, ?)').run(convId, title, body);
}

// ── Search (mirrors search_core / search_like_core) ────────────────────────

function sanitizeMatchQuery(query) {
  return `"${query.replace(/"/g, '""')}"`;
}

function escapeLikePattern(query) {
  let out = '';
  for (const c of query) {
    if (c === '\\') out += '\\\\';
    else if (c === '%') out += '\\%';
    else if (c === '_') out += '\\_';
    else out += c;
  }
  return out;
}

/** ASCII-only lowercasing, matching Rust's `to_ascii_lowercase()`. */
function asciiLower(c) {
  return c.length === 1 && c >= 'A' && c <= 'Z' ? c.toLowerCase() : c;
}

function findCharSubsliceCi(haystack, needleLower) {
  if (needleLower.length === 0 || needleLower.length > haystack.length) return null;
  for (let i = 0; i <= haystack.length - needleLower.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLower.length; j++) {
      if (asciiLower(haystack[i + j]) !== needleLower[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return null;
}

/** Builds the STX/ETX (``/``)-delimited snippet for the LIKE
 * fallback path, mirroring `build_like_snippet` (same sentinels
 * `renderMarkedText` — src/utils/searchHighlight.tsx — expects). Operates on
 * `Array.from(str)` (code-point array) for UTF-8/surrogate-pair safety, same
 * as Rust's `Vec<char>`. */
function buildLikeSnippet(body, query) {
  const WINDOW = 32;
  const bodyChars = Array.from(body);
  const queryLower = Array.from(query).map(asciiLower);

  const startIdx = findCharSubsliceCi(bodyChars, queryLower);
  if (startIdx === null) {
    const end = Math.min(WINDOW, bodyChars.length);
    return bodyChars.slice(0, end).join('');
  }
  const endIdx = startIdx + queryLower.length;
  const windowStart = Math.max(0, startIdx - WINDOW);
  const windowEnd = Math.min(bodyChars.length, endIdx + WINDOW);

  let out = '';
  if (windowStart > 0) out += '…';
  out += bodyChars.slice(windowStart, startIdx).join('');
  out += '';
  out += bodyChars.slice(startIdx, endIdx).join('');
  out += '';
  out += bodyChars.slice(endIdx, windowEnd).join('');
  if (windowEnd < bodyChars.length) out += '…';
  return out;
}

function searchLikeCore(db, query, limit) {
  const pattern = `%${escapeLikePattern(query)}%`;
  const rows = db
    .prepare(
      `SELECT f.conv_id, c.title, f.body
       FROM conversation_fts f
       JOIN conversation_catalog c ON c.conv_id = f.conv_id
       WHERE c.missing = 0 AND f.body LIKE ? ESCAPE '\\'
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(pattern, limit);
  return rows.map((r) => ({
    conv_id: r.conv_id,
    title: r.title,
    snippet: buildLikeSnippet(r.body, query),
    rank: 0.0,
  }));
}

function searchCore(db, query, limit) {
  const trimmed = query.trim();
  const charCount = Array.from(trimmed).length;
  if (charCount === 0) return [];
  if (charCount < 3) return searchLikeCore(db, trimmed, limit);

  const matchQuery = sanitizeMatchQuery(trimmed);
  const rows = db
    .prepare(
      `SELECT f.conv_id, c.title,
              snippet(conversation_fts, 2, '', '', '…', 32) AS snippet,
              bm25(conversation_fts, 0.0, 5.0, 1.0) AS rank
       FROM conversation_fts f
       JOIN conversation_catalog c ON c.conv_id = f.conv_id
       WHERE conversation_fts MATCH ? AND c.missing = 0
       ORDER BY rank
       LIMIT ?`,
    )
    .all(matchQuery, limit);
  return rows.map((r) => ({ conv_id: r.conv_id, title: r.title, snippet: r.snippet, rank: r.rank }));
}

// ── JSONL scan (mirrors scan_conversation_file) ────────────────────────────

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && item.type === 'text' && typeof item.text === 'string') return item.text;
    }
    return '';
  }
  return '';
}

function stripAttachmentMarkers(input) {
  let result = '';
  let rest = input;
  for (;;) {
    const start = rest.indexOf('[Attachment:');
    if (start === -1) {
      result += rest;
      break;
    }
    result += rest.slice(0, start);
    const endRel = rest.slice(start).indexOf(']');
    if (endRel === -1) {
      result += rest.slice(start);
      break;
    }
    rest = rest.slice(start + endRel + 1).replace(/^\s+/, '');
  }
  return result;
}

function deriveTitle(text) {
  const stripped = stripAttachmentMarkers(text).trim();
  if (!stripped) return '';
  const chars = Array.from(stripped);
  if (chars.length > 30) {
    return chars.slice(0, 30).join('') + '...';
  }
  return stripped;
}

/** Read-only scan of one conversation's messages.jsonl. Returns `null` if the
 * file doesn't exist (mirrors `scan_conversation_file`'s `Ok(None)`). Never
 * mutates `jsonlPath`. Id-dedup keeps the LAST occurrence, with all id-less
 * messages collapsing onto ONE shared key (JS `Map` supports `undefined` as a
 * real, single, colliding key — exactly the semantics `dedupMessagesById()`
 * in conversationStorage.ts relies on, and what the Rust port explicitly
 * mirrors via `Option<String>`). */
function scanConversationFile(jsonlPath) {
  let stat;
  try {
    stat = fs.statSync(jsonlPath);
  } catch {
    return null;
  }
  const sourceBytes = stat.size;
  const sourceMtime = Math.floor(stat.mtimeMs);

  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const parsed = [];
  let corruptLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      corruptLines++;
    }
  }

  const lastIndex = new Map();
  parsed.forEach((v, i) => {
    const key = typeof v.id === 'string' ? v.id : undefined;
    lastIndex.set(key, i);
  });
  const deduped = parsed.filter((v, i) => {
    const key = typeof v.id === 'string' ? v.id : undefined;
    return lastIndex.get(key) === i;
  });

  const messageCount = deduped.length;
  const lastIdRaw = deduped.length ? deduped[deduped.length - 1].id : undefined;
  const lastMessageId = typeof lastIdRaw === 'string' ? lastIdRaw : null;
  const firstTs = deduped.length ? deduped[0].timestamp : undefined;
  const createdAt = typeof firstTs === 'number' ? firstTs : sourceMtime;
  const lastTs = deduped.length ? deduped[deduped.length - 1].timestamp : undefined;
  const updatedAt = typeof lastTs === 'number' ? lastTs : sourceMtime;

  let title = '';
  for (const v of deduped) {
    if (v.role === 'user') {
      const text = extractTextFromContent(v.content);
      if (text) {
        const derived = deriveTitle(text);
        if (derived) {
          title = derived;
          break;
        }
      }
    }
  }

  const bodyLines = [];
  for (const v of deduped) {
    if (v.isSystem === true) continue;
    if (typeof v.id === 'string' && v.id.startsWith('compact-boundary-')) continue;
    const role = typeof v.role === 'string' ? v.role : '';
    const text = extractTextFromContent(v.content);
    bodyLines.push(`${role}: ${text}`);
  }
  const body = bodyLines.join('\n');

  return {
    title,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messageCount,
    last_message_id: lastMessageId,
    source_bytes: sourceBytes,
    source_mtime: sourceMtime,
    corrupt_lines: corruptLines,
    body,
  };
}

// ── index.json — authoritative conversation meta ──────────────────────────

/** Read-only, best-effort: `{}` if index.json is absent/unparseable, mirroring
 * `read_index_entries`'s own fallback-to-empty. Note the on-disk field names
 * are camelCase (`createdAt`/`updatedAt`) — that's the real shape
 * conversationStorage.ts's `ConversationMeta` writes, which is why the Rust
 * struct `#[serde(rename)]`s them; no rename is needed here since we read the
 * same JSON keys directly. */
function readIndexEntries(conversationsRoot) {
  const p = path.join(conversationsRoot, 'index.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
      ? parsed.entries
      : {};
  } catch {
    return {};
  }
}

/** Mirrors `IndexMetaEntry::model_json` — serializes `model` back to a JSON
 * string exactly like `catalogUpsertConversation`/`catalogBumpCount` do on
 * the TS side, so the catalog's `model` column stays consistent regardless of
 * write path. `null`/absent → `null` (Option<Value>::None parity). */
function modelJsonFromIndexEntry(entry) {
  if (entry.model === undefined || entry.model === null) return null;
  return JSON.stringify(entry.model);
}

/** Mirrors `build_conversation_row`. Returns `null` when the conversation is
 * genuinely gone (no JSONL AND no index.json entry). `diskMeta` is the
 * caller's already-taken `fs.statSync` result (or `null`). */
function buildConversationRow(convId, jsonlPath, diskMeta, indexMeta) {
  if (!diskMeta && !indexMeta) return null;

  if (!diskMeta && indexMeta) {
    const row = {
      conv_id: convId,
      title: indexMeta.title ?? '',
      created_at: indexMeta.createdAt ?? 0,
      updated_at: indexMeta.updatedAt ?? 0,
      message_count: 0,
      last_message_id: null,
      model: modelJsonFromIndexEntry(indexMeta),
      source_bytes: 0,
      source_mtime: null,
      missing: false,
    };
    return { row, body: '', corrupt_lines: 0 };
  }

  // diskMeta present.
  const scanned = scanConversationFile(jsonlPath);
  if (!scanned) return null; // race: file vanished between stat and read

  let title, createdAt, updatedAt, model;
  if (indexMeta) {
    title = indexMeta.title ?? '';
    createdAt = indexMeta.createdAt ?? 0;
    updatedAt = indexMeta.updatedAt ?? 0;
    model = modelJsonFromIndexEntry(indexMeta);
  } else {
    title = scanned.title;
    createdAt = scanned.created_at;
    updatedAt = scanned.updated_at;
    model = null; // preserves existing model via COALESCE in upsert_core
  }

  const row = {
    conv_id: convId,
    title,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: scanned.message_count,
    last_message_id: scanned.last_message_id,
    model,
    source_bytes: scanned.source_bytes,
    source_mtime: scanned.source_mtime,
    missing: false,
  };
  return { row, body: scanned.body, corrupt_lines: scanned.corrupt_lines };
}

// ── Reconcile (mirrors reconcile_read_existing_core / _scan_core / _apply_core) ─

function reconcileReadExistingCore(db) {
  const existing = new Map();
  for (const r of db.prepare('SELECT conv_id, source_bytes, source_mtime, missing, title FROM conversation_catalog').all()) {
    existing.set(r.conv_id, { bytes: r.source_bytes, mtime: r.source_mtime, missing: r.missing !== 0, title: r.title });
  }
  const existingFtsIds = new Set();
  for (const r of db.prepare('SELECT conv_id FROM conversation_fts').all()) {
    existingFtsIds.add(r.conv_id);
  }
  return { existing, existingFtsIds };
}

/** Pure filesystem scan — no db handle touched, mirroring the Rust fix that
 * lets the DB "lock" (irrelevant in single-threaded Node, kept for parity of
 * shape) be released across the directory walk. */
function reconcileScanCore(conversationsRoot, existing, existingFtsIds) {
  const stats = { scanned_dirs: 0, upserted: 0, marked_missing: 0, corrupt_lines_skipped: 0 };
  const seen = new Set();
  const upserts = [];
  const markMissingIds = [];

  const indexEntries = readIndexEntries(conversationsRoot);

  const dirIds = [];
  if (fs.existsSync(conversationsRoot)) {
    for (const ent of fs.readdirSync(conversationsRoot, { withFileTypes: true })) {
      if (ent.isDirectory()) dirIds.push(ent.name);
    }
  }

  const allIds = new Set(dirIds);
  for (const k of Object.keys(indexEntries)) allIds.add(k);

  for (const convId of allIds) {
    seen.add(convId);
    stats.scanned_dirs++;

    const jsonl = path.join(conversationsRoot, convId, 'messages.jsonl');
    let diskMeta = null;
    try {
      diskMeta = fs.statSync(jsonl);
    } catch {
      diskMeta = null;
    }
    const indexMeta = indexEntries[convId];

    if (!diskMeta && !indexMeta) {
      const ex = existing.get(convId);
      if (ex && !ex.missing) {
        markMissingIds.push(convId);
        stats.marked_missing++;
      }
      continue;
    }

    if (!diskMeta && indexMeta) {
      const result = buildConversationRow(convId, jsonl, null, indexMeta);
      if (result) {
        upserts.push([result.row, result.body]);
        stats.upserted++;
      }
      continue;
    }

    // diskMeta present.
    const diskBytes = diskMeta.size;
    const diskMtime = Math.floor(diskMeta.mtimeMs);
    const ex = existing.get(convId);
    let needsScan;
    if (ex) {
      const metaTitle = indexMeta ? indexMeta.title ?? '' : null;
      const titleChanged = indexMeta ? metaTitle !== ex.title : false;
      needsScan = ex.missing || ex.bytes !== diskBytes || ex.mtime !== diskMtime || !existingFtsIds.has(convId) || titleChanged;
    } else {
      needsScan = true;
    }
    if (!needsScan) continue;

    const result = buildConversationRow(convId, jsonl, diskMeta, indexMeta);
    if (result) {
      stats.corrupt_lines_skipped += result.corrupt_lines;
      upserts.push([result.row, result.body]);
      stats.upserted++;
    }
  }

  for (const [convId, ex] of existing) {
    if (!ex.missing && !seen.has(convId)) {
      markMissingIds.push(convId);
      stats.marked_missing++;
    }
  }

  return { upserts, markMissingIds, stats };
}

/** Applies every upsert/mark_missing in a SINGLE transaction (manual
 * BEGIN/COMMIT/ROLLBACK — DatabaseSync has no `.transaction()` helper). */
function reconcileApplyCore(db, upserts, markMissingIds, existingFtsIds) {
  db.exec('BEGIN');
  try {
    for (const [row, body] of upserts) {
      upsertCore(db, row);
      if (body) {
        const mayExist = existingFtsIds.has(row.conv_id);
        ftsUpsertCore(db, row.conv_id, row.title, body, mayExist);
      }
    }
    for (const convId of markMissingIds) {
      markMissingCore(db, convId);
    }
    bumpObservationSequenceCore(db);
    setInitialBuildCompleteCore(db, true);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Single-conversation reindex (mirrors reindex_scan_core / _apply_core) ──

function reindexScanCore(convId, conversationsRoot) {
  const jsonl = path.join(conversationsRoot, convId, 'messages.jsonl');
  let diskMeta = null;
  try {
    diskMeta = fs.statSync(jsonl);
  } catch {
    diskMeta = null;
  }
  const indexEntries = readIndexEntries(conversationsRoot);
  const indexMeta = indexEntries[convId];
  return buildConversationRow(convId, jsonl, diskMeta, indexMeta);
}

function reindexApplyCore(db, result) {
  db.exec('BEGIN');
  try {
    if (result) {
      upsertCore(db, result.row);
      if (result.body) {
        ftsUpsertCore(db, result.row.conv_id, result.row.title, result.body, true);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Dispatch (mirrors the #[tauri::command] entry points) ─────────────────

/**
 * @param {import('electron').App} app
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
function catalogDispatch(app, cmd, args) {
  const a = args || {};

  switch (cmd) {
    case 'catalog_upsert_conversation': {
      // NOTE (parity with Rust): despite the name, the Tauri command
      // `catalog_upsert_conversation` calls `create_conversation_core`
      // (ON CONFLICT DO NOTHING), NOT `upsert_core` — it only ever carries
      // create-time defaults and must never clobber a live row a concurrent
      // bump_count already established. See catalog_db.rs's doc on
      // `create_conversation_core` for the full rationale.
      const db = getDb(app);
      createConversationCore(db, a.row);
      return null;
    }

    case 'catalog_get_conversation': {
      const db = getDb(app);
      return getCore(db, a.convId);
    }

    case 'catalog_list_conversations': {
      const db = getDb(app);
      const orderDesc = a.order !== 'asc';
      return listCore(db, a.limit ?? 200, a.offset ?? 0, orderDesc);
    }

    case 'catalog_bump_count': {
      const db = getDb(app);
      const jsonl = path.join(String(a.conversationsRoot), String(a.convId), 'messages.jsonl');
      let sourceBytes = null;
      let sourceMtime = null;
      try {
        const st = fs.statSync(jsonl);
        sourceBytes = st.size;
        sourceMtime = Math.floor(st.mtimeMs);
      } catch {
        /* ENOENT etc. — Rust's Err(_) => (None, None) */
      }
      bumpCountCore(db, a.convId, a.delta, a.updatedAt, a.lastMessageId ?? null, sourceBytes, sourceMtime);
      return null;
    }

    case 'catalog_mark_missing': {
      const db = getDb(app);
      markMissingCore(db, a.convId);
      return null;
    }

    case 'catalog_get_sync_state': {
      const db = getDb(app);
      return getSyncStateCore(db);
    }

    case 'catalog_set_initial_build_complete': {
      const db = getDb(app);
      setInitialBuildCompleteCore(db, !!a.complete);
      return null;
    }

    case 'catalog_bump_observation_sequence': {
      const db = getDb(app);
      return bumpObservationSequenceCore(db);
    }

    case 'catalog_reconcile': {
      const db = getDb(app);
      const root = String(a.conversationsRoot);
      const { existing, existingFtsIds } = reconcileReadExistingCore(db);
      const { upserts, markMissingIds, stats } = reconcileScanCore(root, existing, existingFtsIds);
      reconcileApplyCore(db, upserts, markMissingIds, existingFtsIds);
      return stats;
    }

    case 'catalog_search': {
      const db = getDb(app);
      return searchCore(db, a.query, a.limit ?? 50);
    }

    case 'catalog_reindex_conversation': {
      const db = getDb(app);
      const result = reindexScanCore(a.convId, String(a.conversationsRoot));
      reindexApplyCore(db, result);
      return null;
    }

    default:
      return CATALOG_MISS;
  }
}

module.exports = {
  catalogDispatch,
  CATALOG_MISS,
  // Exported for the headless verify harness (electron/spike/f1bVerify.cjs).
  _internal: {
    getDb,
    upsertCore,
    createConversationCore,
    getCore,
    listCore,
    bumpCountCore,
    markMissingCore,
    getSyncStateCore,
    setInitialBuildCompleteCore,
    bumpObservationSequenceCore,
    ftsUpsertCore,
    ftsDeleteCore,
    searchCore,
    scanConversationFile,
    buildConversationRow,
    reconcileReadExistingCore,
    reconcileScanCore,
    reconcileApplyCore,
    reindexScanCore,
    reindexApplyCore,
  },
};
