//! Conversation catalog SQLite storage — P0 of the message-storage hybrid design.
//!
//! Design doc: `docs/2026-07-14-message-storage-sqlite-hybrid-{design,SPEC}.md`
//! (repo parent). One-line summary of the invariant that governs every
//! function in this file:
//!
//!   Plaintext JSONL (`{appData}/conversations/{convId}/messages.jsonl`) is
//!   ALWAYS the source of truth. This SQLite catalog is ALWAYS a disposable
//!   projection of it — delete `catalog.sqlite` at any time and the next
//!   `catalog_reconcile()` rebuilds it byte-for-byte identical from JSONL.
//!   Nothing in this file may ever write to, move, or delete a JSONL file.
//!
//! Tables:
//!   conversation_catalog — one row per conversation (title, timestamps,
//!     message_count, last_message_id, per-conv model pin, and the
//!     `source_bytes`/`source_mtime` watermark used to detect drift).
//!   catalog_sync_state   — single row (id=1) tracking whether the initial
//!     full scan-build has run, plus a monotonic `observation_sequence`
//!     bumped on every reconcile.
//!
//! The DB file lives at `{app_data_dir}/catalog.sqlite`, created lazily.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

pub struct CatalogDb {
    conn: Mutex<Connection>,
}

impl CatalogDb {
    pub fn open(path: &PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create catalog DB dir: {}", e))?;
        }
        let conn = Connection::open(path)
            .map_err(|e| format!("Failed to open catalog DB: {}", e))?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
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
        ",
    )
    .map_err(|e| format!("Failed to init catalog DB schema: {}", e))
}

// ── Row types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CatalogRow {
    pub conv_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    pub last_message_id: Option<String>,
    pub model: Option<String>,
    pub source_bytes: i64,
    pub source_mtime: Option<i64>,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncState {
    pub initial_build_complete: bool,
    pub observation_sequence: i64,
    pub schema_version: i64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct ReconcileStats {
    pub scanned_dirs: i64,
    pub upserted: i64,
    pub marked_missing: i64,
    pub corrupt_lines_skipped: i64,
}

fn row_from_sql(row: &rusqlite::Row) -> rusqlite::Result<CatalogRow> {
    Ok(CatalogRow {
        conv_id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        message_count: row.get(4)?,
        last_message_id: row.get(5)?,
        model: row.get(6)?,
        source_bytes: row.get(7)?,
        source_mtime: row.get(8)?,
        missing: row.get::<_, i64>(9)? != 0,
    })
}

const ROW_COLUMNS: &str = "conv_id, title, created_at, updated_at, message_count, last_message_id, model, source_bytes, source_mtime, missing";

// ── Core (Connection-level, unit-testable without AppHandle) ─────────────

pub fn upsert_core(conn: &Connection, row: &CatalogRow) -> Result<(), String> {
    conn.execute(
        &format!(
            "INSERT INTO conversation_catalog ({cols})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(conv_id) DO UPDATE SET
               title = excluded.title,
               created_at = excluded.created_at,
               updated_at = excluded.updated_at,
               message_count = excluded.message_count,
               last_message_id = excluded.last_message_id,
               model = COALESCE(excluded.model, conversation_catalog.model),
               source_bytes = excluded.source_bytes,
               source_mtime = excluded.source_mtime,
               missing = excluded.missing",
            cols = ROW_COLUMNS
        ),
        params![
            row.conv_id,
            row.title,
            row.created_at,
            row.updated_at,
            row.message_count,
            row.last_message_id,
            row.model,
            row.source_bytes,
            row.source_mtime,
            row.missing,
        ],
    )
    .map_err(|e| format!("catalog upsert failed: {}", e))?;
    Ok(())
}

/// Create-time upsert (fix #5): inserts the skeleton row for a brand-new
/// conversation. Uses `ON CONFLICT DO NOTHING` — if a row already exists
/// (e.g. the first append's `bump_count_core` raced ahead of this call, both
/// fired from unawaited dynamic imports on the TS side with no ordering
/// guarantee), we must NOT clobber the live `message_count`/`missing` that
/// the bump already established by overwriting them back to the create-time
/// skeleton values (message_count=0, missing=false).
///
/// This is intentionally NOT a general-purpose upsert: `catalog_reconcile`'s
/// authoritative rebuild from JSONL/index.json still goes through
/// `upsert_core`, which DOES overwrite every field because it is reporting
/// truth freshly re-derived from disk.
pub fn create_conversation_core(conn: &Connection, row: &CatalogRow) -> Result<(), String> {
    conn.execute(
        &format!(
            "INSERT INTO conversation_catalog ({cols})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(conv_id) DO NOTHING",
            cols = ROW_COLUMNS
        ),
        params![
            row.conv_id,
            row.title,
            row.created_at,
            row.updated_at,
            row.message_count,
            row.last_message_id,
            row.model,
            row.source_bytes,
            row.source_mtime,
            row.missing,
        ],
    )
    .map_err(|e| format!("catalog create_conversation failed: {}", e))?;
    Ok(())
}

pub fn get_core(conn: &Connection, conv_id: &str) -> Result<Option<CatalogRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {cols} FROM conversation_catalog WHERE conv_id = ?1",
            cols = ROW_COLUMNS
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![conv_id]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(r) => Ok(Some(row_from_sql(r).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

pub fn list_core(
    conn: &Connection,
    limit: i64,
    offset: i64,
    order_desc: bool,
) -> Result<Vec<CatalogRow>, String> {
    let order = if order_desc { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT {cols} FROM conversation_catalog
         WHERE missing = 0
         ORDER BY updated_at {order}, created_at {order}, conv_id
         LIMIT ?1 OFFSET ?2",
        cols = ROW_COLUMNS,
        order = order
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit, offset], row_from_sql)
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// Best-effort incremental count bump on message append. Upserts a stub row
/// if the conversation isn't in the catalog yet (e.g. a brand-new conversation
/// whose explicit `catalog_upsert_conversation` create-call raced with — or
/// was skipped ahead of — the first append). `source_bytes`/`source_mtime`
/// are refreshed from the real file here (not trusted from the caller) so the
/// catalog's drift-detection watermark stays in sync with every write-through
/// call, not just full reconciles — this is what keeps `catalog_reconcile`
/// from redundantly rescanning (and re-deriving the title of) conversations
/// that are just being normally appended to.
pub fn bump_count_core(
    conn: &Connection,
    conv_id: &str,
    delta: i64,
    updated_at: i64,
    last_message_id: Option<&str>,
    source_bytes: Option<i64>,
    source_mtime: Option<i64>,
) -> Result<(), String> {
    // NOTE (fix #3): the ON CONFLICT clause intentionally does NOT touch
    // `missing`. A late in-flight append can land after the conversation was
    // deleted (mark_missing_core set missing=1) — bumping the count must not
    // resurrect that soft-deleted row. `missing` only flips back to 0 via an
    // explicit reconcile that finds the JSONL/index.json genuinely present
    // again. The INSERT branch's literal `0` is the correct default for a
    // brand-new row (one that has never been marked missing).
    conn.execute(
        "INSERT INTO conversation_catalog
            (conv_id, title, created_at, updated_at, message_count, last_message_id, source_bytes, source_mtime, missing)
         VALUES (?1, '', ?2, ?2, ?3, ?4, COALESCE(?5, 0), ?6, 0)
         ON CONFLICT(conv_id) DO UPDATE SET
           message_count = message_count + ?3,
           updated_at = ?2,
           last_message_id = COALESCE(?4, last_message_id),
           source_bytes = COALESCE(?5, source_bytes),
           source_mtime = COALESCE(?6, source_mtime)",
        params![conv_id, updated_at, delta, last_message_id, source_bytes, source_mtime],
    )
    .map_err(|e| format!("catalog bump_count failed: {}", e))?;
    Ok(())
}

pub fn mark_missing_core(conn: &Connection, conv_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE conversation_catalog SET missing = 1 WHERE conv_id = ?1",
        params![conv_id],
    )
    .map_err(|e| format!("catalog mark_missing failed: {}", e))?;
    Ok(())
}

pub fn get_sync_state_core(conn: &Connection) -> Result<SyncState, String> {
    conn.query_row(
        "SELECT initial_build_complete, observation_sequence, schema_version
         FROM catalog_sync_state WHERE id = 1",
        [],
        |row| {
            Ok(SyncState {
                initial_build_complete: row.get::<_, i64>(0)? != 0,
                observation_sequence: row.get(1)?,
                schema_version: row.get(2)?,
            })
        },
    )
    .map_err(|e| format!("catalog get_sync_state failed: {}", e))
}

pub fn set_initial_build_complete_core(conn: &Connection, complete: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE catalog_sync_state SET initial_build_complete = ?1 WHERE id = 1",
        params![complete],
    )
    .map_err(|e| format!("catalog set_initial_build_complete failed: {}", e))?;
    Ok(())
}

pub fn bump_observation_sequence_core(conn: &Connection) -> Result<i64, String> {
    conn.execute(
        "UPDATE catalog_sync_state SET observation_sequence = observation_sequence + 1 WHERE id = 1",
        [],
    )
    .map_err(|e| format!("catalog bump_observation_sequence failed: {}", e))?;
    conn.query_row(
        "SELECT observation_sequence FROM catalog_sync_state WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .map_err(|e| format!("catalog bump_observation_sequence read-back failed: {}", e))
}

// ── JSONL scan (rebuildable projection derivation) ────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ScannedConversation {
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    pub last_message_id: Option<String>,
    pub source_bytes: i64,
    pub source_mtime: i64,
    pub corrupt_lines: i64,
}

fn mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Extract display text from a Message's `content` field, which on disk is
/// either a bare string or an array of content blocks (mirrors the shape
/// consumed by `stripForDisk`/`loadMessages` in conversationStorage.ts).
fn extract_text_from_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => {
            for item in items {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                        return t.to_string();
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// Strip `[Attachment: `path`]` markers the way chatStore.ts's addMessage
/// title-derivation does. Deliberately a plain substring scan rather than a
/// regex crate dependency — this is a best-effort title used only when
/// rebuilding the catalog straight from JSONL with no app-level metadata
/// available (see module doc); the authoritative title source in normal
/// operation is still the TS-side ConversationMeta.
fn strip_attachment_markers(input: &str) -> String {
    let mut result = String::new();
    let mut rest = input;
    loop {
        match rest.find("[Attachment:") {
            Some(start) => {
                result.push_str(&rest[..start]);
                match rest[start..].find(']') {
                    Some(end_rel) => {
                        let after = &rest[start + end_rel + 1..];
                        rest = after.trim_start();
                    }
                    None => {
                        // Unterminated marker — keep the trailing text verbatim.
                        result.push_str(&rest[start..]);
                        break;
                    }
                }
            }
            None => {
                result.push_str(rest);
                break;
            }
        }
    }
    result
}

fn derive_title(text: &str) -> String {
    let stripped = strip_attachment_markers(text).trim().to_string();
    if stripped.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = stripped.chars().collect();
    if chars.len() > 30 {
        let truncated: String = chars[..30].iter().collect();
        format!("{}...", truncated)
    } else {
        stripped
    }
}

/// Scan one conversation's `messages.jsonl` and derive catalog fields.
/// Read-only: never mutates `path`. Mirrors the id-dedup-keep-last and
/// per-line corrupt-line-tolerance semantics of `loadMessages` in
/// `conversationStorage.ts` so the catalog's `message_count` always matches
/// what the app would actually load into memory.
///
/// Returns `Ok(None)` if the file does not exist (caller treats the
/// conversation as missing).
pub fn scan_conversation_file(path: &Path) -> Result<Option<ScannedConversation>, String> {
    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let source_bytes = metadata.len() as i64;
    let source_mtime = mtime_ms(&metadata);

    let raw = fs::read_to_string(path).map_err(|e| format!("read {} failed: {}", path.display(), e))?;

    let mut parsed: Vec<Value> = Vec::new();
    let mut corrupt_lines = 0i64;
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v) => parsed.push(v),
            Err(_) => corrupt_lines += 1,
        }
    }

    // Dedup by id, keeping the LAST occurrence — same semantics as
    // dedupMessagesById() in conversationStorage.ts. Crucially, id-less
    // messages are NOT all kept as distinct: TS's `Map<string, number>` keyed
    // by `m.id` collapses every message whose `id` is `undefined` onto the
    // SAME map key (`undefined`), so only the last id-less message survives.
    // We mirror that by using `Option<String>` (None == "no id") as the dedup
    // key instead of only tracking `Some(id)` — treating `None` as its own
    // shared key, exactly like the JS Map behavior (fix #2).
    let mut last_index: HashMap<Option<String>, usize> = HashMap::new();
    for (i, v) in parsed.iter().enumerate() {
        let key = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
        last_index.insert(key, i);
    }
    let deduped: Vec<&Value> = parsed
        .iter()
        .enumerate()
        .filter(|(i, v)| {
            let key = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
            last_index.get(&key) == Some(i)
        })
        .map(|(_, v)| v)
        .collect();

    let message_count = deduped.len() as i64;
    let last_message_id = deduped
        .last()
        .and_then(|v| v.get("id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let created_at = deduped
        .first()
        .and_then(|v| v.get("timestamp"))
        .and_then(|x| x.as_i64())
        .unwrap_or(source_mtime);
    let updated_at = deduped
        .last()
        .and_then(|v| v.get("timestamp"))
        .and_then(|x| x.as_i64())
        .unwrap_or(source_mtime);

    let mut title = String::new();
    for v in &deduped {
        if v.get("role").and_then(|x| x.as_str()) == Some("user") {
            let text = extract_text_from_content(v.get("content"));
            if !text.is_empty() {
                let derived = derive_title(&text);
                if !derived.is_empty() {
                    title = derived;
                    break;
                }
            }
        }
    }

    Ok(Some(ScannedConversation {
        title,
        created_at,
        updated_at,
        message_count,
        last_message_id,
        source_bytes,
        source_mtime,
        corrupt_lines,
    }))
}

// ── index.json — authoritative conversation meta (fix #7) ────────────────
//
// `conversationStorage.ts` keeps ONE shared `{conversations_root}/index.json`
// (see `indexFilePath()`), shaped `{ version: 1, entries: Record<convId,
// ConversationMeta> }`. Reconcile reads it so title/model/createdAt/updatedAt
// come from the same authoritative source chatStore writes, instead of a
// second, divergent Rust-side re-derivation that can never recover
// model/createdAt from JSONL alone. The JSONL scan remains the source of
// truth for message_count/last_message_id/source_bytes/source_mtime — those
// have no index.json equivalent.

#[derive(Debug, Clone, Deserialize)]
struct IndexMetaEntry {
    #[serde(default)]
    title: String,
    #[serde(rename = "createdAt", default)]
    created_at: i64,
    #[serde(rename = "updatedAt", default)]
    updated_at: i64,
    #[serde(default)]
    model: Option<Value>,
}

impl IndexMetaEntry {
    /// Serialize `model` the same way `catalogUpsertConversation`/
    /// `catalogBumpCount` on the TS side do (`JSON.stringify(meta.model)`),
    /// so the catalog's `model` column stays a consistent JSON-text shape
    /// regardless of which write path populated it.
    fn model_json(&self) -> Option<String> {
        self.model.as_ref().and_then(|v| serde_json::to_string(v).ok())
    }
}

#[derive(Debug, Default, Deserialize)]
struct ConversationIndexFile {
    #[serde(default)]
    entries: HashMap<String, IndexMetaEntry>,
}

/// Read-only, best-effort: returns an empty map if index.json is absent or
/// unparseable (mirrors `loadIndex()`'s own fallback-to-empty behavior on the
/// TS side) — reconcile must never fail just because the index is missing.
fn read_index_entries(conversations_root: &Path) -> HashMap<String, IndexMetaEntry> {
    let path = conversations_root.join("index.json");
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<ConversationIndexFile>(&raw) {
        Ok(idx) => idx.entries,
        Err(_) => HashMap::new(),
    }
}

// ── Reconcile (startup migration + incremental rebuild, unified) ─────────
//
// One algorithm serves both P0 requirements from SPEC §2.3:
//   - "initial_build_complete = 0 → full scan-build" — the catalog table is
//     empty, so every on-disk conversation looks "changed" and gets scanned.
//   - "already complete → incremental" — most rows already match the disk
//     watermark (source_bytes/source_mtime) and are skipped; only changed or
//     newly-appeared directories get rescanned; catalog rows whose JSONL
//     disappeared are marked missing.
// There is no branch on the completion flag other than setting it at the end
// — the diff-and-upsert logic below is naturally a no-op superset of "do
// nothing" when nothing has drifted, and a full rebuild when the table (or a
// specific row) has no watermark to compare against.
//
// Split into three phases (fix #6 + #8):
//   1. `reconcile_read_existing_core` — ONE cheap SELECT under the DB lock.
//   2. `reconcile_scan_core` — pure filesystem work (dir walk, index.json
//      read, JSONL scans). Takes NO `Connection` at all, so callers can run
//      it with the DB lock fully released — a concurrent `catalog_bump_count`
//      (fired by every message append) is no longer blocked for the whole
//      directory walk.
//   3. `reconcile_apply_core` — every upsert/mark_missing from this pass in a
//      SINGLE transaction, so a full first-run migration is one commit
//      instead of one fsync per conversation.
// `reconcile_core` below just chains the three for callers (tests, and any
// single-threaded use) that don't need the lock released in between; the
// `catalog_reconcile` Tauri command calls the three phases directly so it can
// drop the lock between (1) and (3).

fn reconcile_read_existing_core(
    conn: &Connection,
) -> Result<HashMap<String, (i64, Option<i64>, bool)>, String> {
    let mut existing: HashMap<String, (i64, Option<i64>, bool)> = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT conv_id, source_bytes, source_mtime, missing FROM conversation_catalog")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, i64>(3)? != 0,
            ))
        })
        .map_err(|e| e.to_string())?;
    for r in rows {
        let (id, bytes, mtime, missing) = r.map_err(|e| e.to_string())?;
        existing.insert(id, (bytes, mtime, missing));
    }
    Ok(existing)
}

/// Pure filesystem scan — no `Connection` parameter (fix #6): computes what
/// needs to change without ever touching the DB, so it can run with the
/// catalog Mutex released. Returns the rows to upsert, the conv_ids to mark
/// missing, and the pass's stats; the caller applies them separately.
fn reconcile_scan_core(
    conversations_root: &Path,
    existing: &HashMap<String, (i64, Option<i64>, bool)>,
) -> Result<(Vec<CatalogRow>, Vec<String>, ReconcileStats), String> {
    let mut stats = ReconcileStats::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut upserts: Vec<CatalogRow> = Vec::new();
    let mut mark_missing_ids: Vec<String> = Vec::new();

    let index_entries = read_index_entries(conversations_root);

    let mut dir_ids: Vec<String> = Vec::new();
    if conversations_root.exists() {
        let entries = fs::read_dir(conversations_root)
            .map_err(|e| format!("read_dir({}) failed: {}", conversations_root.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if !path.is_dir() {
                continue; // skips index.json etc. living alongside conv dirs
            }
            if let Some(s) = path.file_name().and_then(|n| n.to_str()) {
                dir_ids.push(s.to_string());
            }
        }
    }

    // Union of on-disk conversation directories and index.json entries
    // (fix #4): a brand-new, never-messaged conversation has an index.json
    // entry but NO directory yet (the per-conv dir is only created by the
    // first JSONL append — see conversationStorage.ts's `atomicWrite`
    // "creates parent dirs as needed" comment). Walking directories alone
    // would never see such a conversation existing at all, so the trailing
    // "vanished" loop below would incorrectly mark its catalog row missing.
    let mut all_ids: HashSet<String> = dir_ids.into_iter().collect();
    all_ids.extend(index_entries.keys().cloned());

    for conv_id in all_ids {
        seen.insert(conv_id.clone());
        stats.scanned_dirs += 1;

        let jsonl = conversations_root.join(&conv_id).join("messages.jsonl");
        let disk_meta = fs::metadata(&jsonl).ok();
        let index_meta = index_entries.get(&conv_id);

        match (&disk_meta, index_meta) {
            (None, None) => {
                // Genuinely gone: neither an index.json entry nor a
                // messages.jsonl file on disk. This is the real "missing"
                // case (fix #4's complement) — only mark missing here.
                if let Some((_, _, missing)) = existing.get(&conv_id) {
                    if !missing {
                        mark_missing_ids.push(conv_id.clone());
                        stats.marked_missing += 1;
                    }
                }
            }
            (None, Some(meta)) => {
                // index.json knows about this conversation but there's no
                // messages.jsonl yet — a valid, never-messaged conversation
                // (fix #4). Keep it visible with message_count 0, NOT missing.
                let row = CatalogRow {
                    conv_id: conv_id.clone(),
                    title: meta.title.clone(),
                    created_at: meta.created_at,
                    updated_at: meta.updated_at,
                    message_count: 0,
                    last_message_id: None,
                    model: meta.model_json(),
                    source_bytes: 0,
                    source_mtime: None,
                    missing: false,
                };
                upserts.push(row);
                stats.upserted += 1;
            }
            (Some(m), _) => {
                let disk_bytes = m.len() as i64;
                let disk_mtime = mtime_ms(m);
                let needs_scan = match existing.get(&conv_id) {
                    Some((ebytes, emtime, emissing)) => {
                        *emissing || *ebytes != disk_bytes || *emtime != Some(disk_mtime)
                    }
                    None => true,
                };
                if !needs_scan {
                    continue;
                }

                if let Some(scanned) = scan_conversation_file(&jsonl)? {
                    stats.corrupt_lines_skipped += scanned.corrupt_lines;
                    // index.json is authoritative for title/model/createdAt/
                    // updatedAt when present (fix #7); the JSONL-derived
                    // values are only a fallback for conversations with no
                    // index.json entry (e.g. pre-P0 data / an index rebuild
                    // gap), matching the module's original scan-only design.
                    let (title, created_at, updated_at, model) = match index_meta {
                        Some(meta) => (
                            meta.title.clone(),
                            meta.created_at,
                            meta.updated_at,
                            meta.model_json(),
                        ),
                        None => (scanned.title.clone(), scanned.created_at, scanned.updated_at, None),
                    };
                    let row = CatalogRow {
                        conv_id: conv_id.clone(),
                        title,
                        created_at,
                        updated_at,
                        message_count: scanned.message_count,
                        last_message_id: scanned.last_message_id,
                        model, // None preserves the existing model via COALESCE in upsert_core
                        source_bytes: scanned.source_bytes,
                        source_mtime: Some(scanned.source_mtime),
                        missing: false,
                    };
                    upserts.push(row);
                    stats.upserted += 1;
                }
            }
        }
    }

    for (conv_id, (_, _, missing)) in existing.iter() {
        if !missing && !seen.contains(conv_id) {
            mark_missing_ids.push(conv_id.clone());
            stats.marked_missing += 1;
        }
    }

    Ok((upserts, mark_missing_ids, stats))
}

/// Apply every upsert/mark_missing computed by `reconcile_scan_core` in a
/// SINGLE transaction (fix #8) — a first-run full migration over N
/// conversations is one commit/fsync, not N.
fn reconcile_apply_core(
    conn: &Connection,
    upserts: &[CatalogRow],
    mark_missing_ids: &[String],
) -> Result<(), String> {
    // `unchecked_transaction` (rather than `transaction`, which needs `&mut
    // Connection`) because callers only ever hold a `&Connection` here (e.g.
    // a `MutexGuard` deref'd immutably by the rest of this module's `&Connection`-
    // typed helpers) — safe because the whole call is made while holding the
    // single connection's Mutex, so there is no concurrent use of this
    // Connection to race with.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for row in upserts {
        upsert_core(&tx, row)?;
    }
    for conv_id in mark_missing_ids {
        mark_missing_core(&tx, conv_id)?;
    }
    bump_observation_sequence_core(&tx)?;
    set_initial_build_complete_core(&tx, true)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Convenience wrapper chaining all three phases on a single `Connection` —
/// used by unit tests and any single-threaded caller. The `catalog_reconcile`
/// Tauri command does NOT use this: it calls the three phases directly so it
/// can release the DB lock between the read and the apply phase (fix #6).
/// `#[cfg(test)]`-only: nothing in the non-test build calls it anymore.
#[cfg(test)]
pub fn reconcile_core(conn: &Connection, conversations_root: &Path) -> Result<ReconcileStats, String> {
    let existing = reconcile_read_existing_core(conn)?;
    let (upserts, mark_missing_ids, stats) = reconcile_scan_core(conversations_root, &existing)?;
    reconcile_apply_core(conn, &upserts, &mark_missing_ids)?;
    Ok(stats)
}

// ── Tauri commands ─────────────────────────────────────────────────────

fn get_db(app: &AppHandle) -> Result<&CatalogDb, String> {
    app.try_state::<CatalogDb>()
        .ok_or_else(|| "Catalog DB not initialized".to_string())
        .map(|s| s.inner())
}

/// Conversation-create write-through. Uses `create_conversation_core` (fix
/// #5), NOT `upsert_core` — this call only ever carries create-time defaults
/// (message_count=0, missing=false) and must never clobber a live row that a
/// concurrent `catalog_bump_count` already established.
#[tauri::command]
pub fn catalog_upsert_conversation(app: AppHandle, row: CatalogRow) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    create_conversation_core(&conn, &row)
}

#[tauri::command]
pub fn catalog_get_conversation(app: AppHandle, conv_id: String) -> Result<Option<CatalogRow>, String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_core(&conn, &conv_id)
}

#[tauri::command]
pub fn catalog_list_conversations(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
    order: Option<String>,
) -> Result<Vec<CatalogRow>, String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_desc = order.as_deref() != Some("asc");
    list_core(&conn, limit.unwrap_or(200), offset.unwrap_or(0), order_desc)
}

#[tauri::command]
pub fn catalog_bump_count(
    app: AppHandle,
    conv_id: String,
    delta: i64,
    updated_at: i64,
    last_message_id: Option<String>,
    conversations_root: String,
) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let jsonl = Path::new(&conversations_root).join(&conv_id).join("messages.jsonl");
    let (source_bytes, source_mtime) = match fs::metadata(&jsonl) {
        Ok(m) => (Some(m.len() as i64), Some(mtime_ms(&m))),
        Err(_) => (None, None),
    };
    bump_count_core(
        &conn,
        &conv_id,
        delta,
        updated_at,
        last_message_id.as_deref(),
        source_bytes,
        source_mtime,
    )
}

#[tauri::command]
pub fn catalog_mark_missing(app: AppHandle, conv_id: String) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    mark_missing_core(&conn, &conv_id)
}

#[tauri::command]
pub fn catalog_get_sync_state(app: AppHandle) -> Result<SyncState, String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_sync_state_core(&conn)
}

#[tauri::command]
pub fn catalog_set_initial_build_complete(app: AppHandle, complete: bool) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    set_initial_build_complete_core(&conn, complete)
}

#[tauri::command]
pub fn catalog_bump_observation_sequence(app: AppHandle) -> Result<i64, String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    bump_observation_sequence_core(&conn)
}

/// Startup reconcile / rebuild entry point. Safe to call unconditionally on
/// every app launch — see `reconcile_core` doc for why the same code path
/// serves both the first-run full migration and later incremental repairs.
#[tauri::command]
pub fn catalog_reconcile(app: AppHandle, conversations_root: String) -> Result<ReconcileStats, String> {
    let db = get_db(&app)?;
    let root = Path::new(&conversations_root);

    // Fix #6: do NOT hold the single connection Mutex across the whole
    // directory walk + JSONL/index.json reads below — a concurrent
    // `catalog_bump_count` (fired by every message append) would otherwise
    // stall until this entire reconcile finished. Lock only for the cheap
    // existing-rows SELECT...
    let existing = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        reconcile_read_existing_core(&conn)?
    };

    // ...do all filesystem work with the lock released...
    let (upserts, mark_missing_ids, stats) = reconcile_scan_core(root, &existing)?;

    // ...and re-acquire only to apply every write in one transaction (fix #8).
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        reconcile_apply_core(&conn, &upserts, &mark_missing_ids)?;
    }

    Ok(stats)
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;
    use tempfile::tempdir;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn write_jsonl(dir: &Path, conv_id: &str, lines: &[&str]) -> PathBuf {
        let conv_dir = dir.join(conv_id);
        stdfs::create_dir_all(&conv_dir).unwrap();
        let path = conv_dir.join("messages.jsonl");
        let content = if lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", lines.join("\n"))
        };
        stdfs::write(&path, content).unwrap();
        path
    }

    fn msg(id: &str, role: &str, text: &str, ts: i64) -> String {
        format!(
            r#"{{"id":"{id}","role":"{role}","content":"{text}","timestamp":{ts}}}"#,
            id = id,
            role = role,
            text = text,
            ts = ts
        )
    }

    // ── 1. Rebuild equivalence ────────────────────────────────────────

    #[test]
    fn rebuild_equivalence_drop_and_rescan_produces_identical_rows() {
        let root = tempdir().unwrap();
        write_jsonl(
            root.path(),
            "conv-a",
            &[&msg("m1", "user", "hello", 1000), &msg("m2", "assistant", "hi", 2000)],
        );
        write_jsonl(
            root.path(),
            "conv-b",
            &[&msg("m1", "user", "second conv", 500)],
        );

        let conn1 = open_test_db();
        reconcile_core(&conn1, root.path()).unwrap();
        let mut rows1 = list_core(&conn1, 100, 0, true).unwrap();
        rows1.sort_by(|a, b| a.conv_id.cmp(&b.conv_id));

        // Simulate "delete catalog.sqlite" — fresh DB, same JSONL on disk.
        let conn2 = open_test_db();
        reconcile_core(&conn2, root.path()).unwrap();
        let mut rows2 = list_core(&conn2, 100, 0, true).unwrap();
        rows2.sort_by(|a, b| a.conv_id.cmp(&b.conv_id));

        assert_eq!(rows1.len(), 2);
        assert_eq!(rows1, rows2, "rebuilt catalog must be byte-for-byte identical");
    }

    // ── 2. Migration safety ───────────────────────────────────────────

    #[test]
    fn scan_handles_empty_file() {
        let root = tempdir().unwrap();
        let path = write_jsonl(root.path(), "empty-conv", &[]);
        let before = stdfs::read(&path).unwrap();

        let scanned = scan_conversation_file(&path).unwrap().unwrap();
        assert_eq!(scanned.message_count, 0);
        assert_eq!(scanned.last_message_id, None);
        assert_eq!(scanned.corrupt_lines, 0);

        let after = stdfs::read(&path).unwrap();
        assert_eq!(before, after, "scan must never modify JSONL bytes");
    }

    #[test]
    fn scan_skips_corrupt_line_gracefully_and_never_touches_jsonl() {
        let root = tempdir().unwrap();
        let path = write_jsonl(
            root.path(),
            "corrupt-conv",
            &[&msg("m1", "user", "ok line", 100), "{not valid json", &msg("m2", "assistant", "reply", 200)],
        );
        let before = stdfs::read(&path).unwrap();

        let scanned = scan_conversation_file(&path).unwrap().unwrap();
        assert_eq!(scanned.message_count, 2, "corrupt line must be skipped, not counted");
        assert_eq!(scanned.corrupt_lines, 1);
        assert_eq!(scanned.last_message_id, Some("m2".to_string()));

        let after = stdfs::read(&path).unwrap();
        assert_eq!(before, after, "scan must never modify JSONL bytes, even with a corrupt line present");
    }

    #[test]
    fn scan_handles_large_conversation_and_leaves_bytes_unchanged() {
        let root = tempdir().unwrap();
        let lines: Vec<String> = (0..5000)
            .map(|i| msg(&format!("m{i}"), if i % 2 == 0 { "user" } else { "assistant" }, "x", 1000 + i as i64))
            .collect();
        let line_refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let path = write_jsonl(root.path(), "large-conv", &line_refs);
        let before = stdfs::read(&path).unwrap();

        let scanned = scan_conversation_file(&path).unwrap().unwrap();
        assert_eq!(scanned.message_count, 5000);
        assert_eq!(scanned.last_message_id, Some("m4999".to_string()));

        let after = stdfs::read(&path).unwrap();
        assert_eq!(before, after, "scan of a large conversation must never modify JSONL bytes");
    }

    #[test]
    fn migration_scan_build_derives_correct_catalog_from_mixed_fixtures() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "empty-conv", &[]);
        write_jsonl(
            root.path(),
            "corrupt-conv",
            &[&msg("m1", "user", "hello there", 100), "garbage{{{", &msg("m2", "assistant", "hi", 200)],
        );
        let conn = open_test_db();
        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.scanned_dirs, 2);
        assert_eq!(stats.corrupt_lines_skipped, 1);

        let empty_row = get_core(&conn, "empty-conv").unwrap().unwrap();
        assert_eq!(empty_row.message_count, 0);

        let corrupt_row = get_core(&conn, "corrupt-conv").unwrap().unwrap();
        assert_eq!(corrupt_row.message_count, 2);
        assert_eq!(corrupt_row.title, "hello there");

        let sync_state = get_sync_state_core(&conn).unwrap();
        assert!(sync_state.initial_build_complete);
    }

    // ── 3. Write-through consistency ──────────────────────────────────

    #[test]
    fn bump_count_n_times_matches_appended_count_and_last_id() {
        let conn = open_test_db();
        for i in 0..10 {
            let id = format!("m{i}");
            bump_count_core(&conn, "conv-x", 1, 1000 + i, Some(&id), Some(100 + i), Some(2000 + i)).unwrap();
        }
        let row = get_core(&conn, "conv-x").unwrap().unwrap();
        assert_eq!(row.message_count, 10);
        assert_eq!(row.last_message_id, Some("m9".to_string()));
        assert_eq!(row.updated_at, 1009);
    }

    #[test]
    fn bump_count_preserves_model_when_not_provided() {
        let conn = open_test_db();
        let row = CatalogRow {
            conv_id: "conv-m".to_string(),
            title: "t".to_string(),
            created_at: 1,
            updated_at: 1,
            message_count: 0,
            last_message_id: None,
            model: Some("anthropic/claude".to_string()),
            source_bytes: 0,
            source_mtime: None,
            missing: false,
        };
        upsert_core(&conn, &row).unwrap();
        bump_count_core(&conn, "conv-m", 1, 2, Some("m1"), None, None).unwrap();
        let after = get_core(&conn, "conv-m").unwrap().unwrap();
        assert_eq!(after.model, Some("anthropic/claude".to_string()), "model must survive a bump_count that doesn't know about it");
        assert_eq!(after.message_count, 1);
    }

    // ── 4. Incremental reconcile ───────────────────────────────────────

    #[test]
    fn incremental_reconcile_only_rescans_changed_conversation() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-a", &[&msg("m1", "user", "a", 100)]);
        write_jsonl(root.path(), "conv-b", &[&msg("m1", "user", "b", 100)]);

        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();
        let a_before = get_core(&conn, "conv-a").unwrap().unwrap();
        let b_before = get_core(&conn, "conv-b").unwrap().unwrap();
        assert_eq!(a_before.message_count, 1);

        // Modify only conv-a's JSONL.
        write_jsonl(
            root.path(),
            "conv-a",
            &[&msg("m1", "user", "a", 100), &msg("m2", "assistant", "reply", 200)],
        );

        let stats = reconcile_core(&conn, root.path()).unwrap();
        let a_after = get_core(&conn, "conv-a").unwrap().unwrap();
        let b_after = get_core(&conn, "conv-b").unwrap().unwrap();

        assert_eq!(a_after.message_count, 2, "changed conversation must be rescanned");
        assert_eq!(b_after, b_before, "unchanged conversation's row must be untouched");
        assert_eq!(stats.upserted, 1, "only the changed conversation should be re-upserted");
    }

    #[test]
    fn incremental_reconcile_marks_missing_when_jsonl_deleted() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-a", &[&msg("m1", "user", "a", 100)]);
        write_jsonl(root.path(), "conv-b", &[&msg("m1", "user", "b", 100)]);

        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();

        // Delete conv-b's whole directory (simulates deleteConversationFiles).
        stdfs::remove_dir_all(root.path().join("conv-b")).unwrap();

        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.marked_missing, 1);

        let b_row = get_core(&conn, "conv-b").unwrap().unwrap();
        assert!(b_row.missing);

        // list_core excludes missing rows.
        let listed = list_core(&conn, 100, 0, true).unwrap();
        assert!(listed.iter().all(|r| r.conv_id != "conv-b"));
        assert!(listed.iter().any(|r| r.conv_id == "conv-a"));
    }

    #[test]
    fn mark_missing_via_command_path_then_reconcile_does_not_resurrect() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-a", &[&msg("m1", "user", "a", 100)]);
        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();

        mark_missing_core(&conn, "conv-a").unwrap();
        stdfs::remove_dir_all(root.path().join("conv-a")).unwrap();

        // Reconcile again — conv-a's dir is gone, already missing=1, must stay missing
        // and must not be double-counted as newly marked.
        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.marked_missing, 0, "already-missing row must not be re-marked");
        let row = get_core(&conn, "conv-a").unwrap().unwrap();
        assert!(row.missing);
    }

    // ── 5. id-dedup keep-last (matches loadMessages semantics) ─────────

    #[test]
    fn dedup_keeps_last_occurrence_of_duplicate_id() {
        let root = tempdir().unwrap();
        let path = write_jsonl(
            root.path(),
            "dup-conv",
            &[
                &msg("m1", "user", "first version", 100),
                &msg("m2", "assistant", "reply", 200),
                &msg("m1", "user", "edited version", 300), // duplicate id, later in file
            ],
        );
        let scanned = scan_conversation_file(&path).unwrap().unwrap();
        assert_eq!(scanned.message_count, 2, "duplicate id must collapse to one entry");
        // last_message_id is the id of the LAST line in file order after dedup
        // filtering preserves original position order; m1's kept occurrence is
        // at index 2 (last), so it becomes the tail of the deduped sequence.
        assert_eq!(scanned.last_message_id, Some("m1".to_string()));
        // Dedup keeps each id's LAST occurrence, so m1 survives at its later
        // position ("edited version"), not its earlier one — same as
        // dedupMessagesById() in conversationStorage.ts. The deduped sequence
        // is [m2 (assistant, "reply"), m1 (user, "edited version")], so the
        // forward scan for the first user-role message lands on the edited text.
        assert_eq!(scanned.title, "edited version", "title must reflect the surviving (last) occurrence of the duplicate id, matching loadMessages' dedup-keep-last semantics");
    }

    // ── Rust-only extras: sync state + row shape sanity ────────────────

    #[test]
    fn sync_state_starts_incomplete_and_reconcile_sets_it_complete() {
        let conn = open_test_db();
        let before = get_sync_state_core(&conn).unwrap();
        assert!(!before.initial_build_complete);
        assert_eq!(before.observation_sequence, 0);

        let root = tempdir().unwrap();
        reconcile_core(&conn, root.path()).unwrap();

        let after = get_sync_state_core(&conn).unwrap();
        assert!(after.initial_build_complete);
        assert_eq!(after.observation_sequence, 1);
    }

    #[test]
    fn upsert_then_get_round_trips_all_fields() {
        let conn = open_test_db();
        let row = CatalogRow {
            conv_id: "conv-rt".to_string(),
            title: "Round Trip".to_string(),
            created_at: 10,
            updated_at: 20,
            message_count: 3,
            last_message_id: Some("m3".to_string()),
            model: Some(r#"{"providerId":"anthropic","modelId":"claude"}"#.to_string()),
            source_bytes: 42,
            source_mtime: Some(99),
            missing: false,
        };
        upsert_core(&conn, &row).unwrap();
        let fetched = get_core(&conn, "conv-rt").unwrap().unwrap();
        assert_eq!(fetched, row);
    }

    #[test]
    fn list_orders_by_updated_at_desc_by_default() {
        let conn = open_test_db();
        for (id, updated_at) in [("a", 100), ("b", 300), ("c", 200)] {
            upsert_core(
                &conn,
                &CatalogRow {
                    conv_id: id.to_string(),
                    title: id.to_string(),
                    created_at: updated_at,
                    updated_at,
                    message_count: 1,
                    last_message_id: None,
                    model: None,
                    source_bytes: 0,
                    source_mtime: None,
                    missing: false,
                },
            )
            .unwrap();
        }
        let rows = list_core(&conn, 100, 0, true).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.conv_id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    // ── 6. Fix #2 — id-less dedup parity with TS's dedupMessagesById ──

    #[test]
    fn dedup_collapses_all_idless_messages_into_one_matching_ts_semantics() {
        let root = tempdir().unwrap();
        // 3 id-less lines + 2 lines with (distinct) ids. TS's dedupMessagesById
        // keys a JS `Map` by `m.id`; every id-less message has `m.id ===
        // undefined`, and Map collapses same-key inserts, so all 3 id-less
        // lines collapse onto ONE surviving entry (the last), just like two
        // messages that share an explicit duplicate id would. Expected count:
        // 1 (surviving id-less) + 2 (unique ids) = 3, not 5.
        let path = write_jsonl(
            root.path(),
            "idless-conv",
            &[
                r#"{"role":"user","content":"no id 1","timestamp":100}"#,
                r#"{"role":"assistant","content":"no id 2","timestamp":200}"#,
                &msg("m1", "user", "has id one", 300),
                r#"{"role":"user","content":"no id 3","timestamp":400}"#,
                &msg("m2", "assistant", "has id two", 500),
            ],
        );
        let scanned = scan_conversation_file(&path).unwrap().unwrap();
        assert_eq!(
            scanned.message_count, 3,
            "id-less messages must collapse to a single surviving entry (TS Map-key-collision-on-undefined parity), not be kept as 3 distinct entries"
        );
    }

    // ── 7. Fix #3 — bump_count must not resurrect a soft-deleted row ──

    #[test]
    fn bump_count_after_mark_missing_does_not_resurrect_the_row() {
        let conn = open_test_db();
        upsert_core(
            &conn,
            &CatalogRow {
                conv_id: "conv-deleted".to_string(),
                title: "gone".to_string(),
                created_at: 1,
                updated_at: 1,
                message_count: 1,
                last_message_id: Some("m1".to_string()),
                model: None,
                source_bytes: 0,
                source_mtime: None,
                missing: false,
            },
        )
        .unwrap();
        mark_missing_core(&conn, "conv-deleted").unwrap();
        assert!(get_core(&conn, "conv-deleted").unwrap().unwrap().missing);

        // A late in-flight append lands after the conversation was deleted.
        bump_count_core(&conn, "conv-deleted", 1, 999, Some("m2"), Some(10), Some(2000)).unwrap();

        let row = get_core(&conn, "conv-deleted").unwrap().unwrap();
        assert!(row.missing, "bump_count must NOT resurrect a soft-deleted (missing=1) row");
        assert_eq!(row.message_count, 2, "the count itself still advances — only `missing` must stay pinned");
    }

    // ── 8. Fix #5 — create-time upsert must not clobber a live count ──

    #[test]
    fn create_conversation_inserts_skeleton_row_when_absent() {
        let conn = open_test_db();
        let row = CatalogRow {
            conv_id: "conv-new".to_string(),
            title: "".to_string(),
            created_at: 1,
            updated_at: 1,
            message_count: 0,
            last_message_id: None,
            model: None,
            source_bytes: 0,
            source_mtime: None,
            missing: false,
        };
        create_conversation_core(&conn, &row).unwrap();
        let fetched = get_core(&conn, "conv-new").unwrap().unwrap();
        assert_eq!(fetched.message_count, 0);
    }

    #[test]
    fn create_conversation_after_bump_does_not_clobber_live_count() {
        let conn = open_test_db();
        // First append's bump lands first (the race described in fix #5).
        bump_count_core(&conn, "conv-race", 1, 100, Some("m1"), Some(50), Some(1000)).unwrap();
        assert_eq!(get_core(&conn, "conv-race").unwrap().unwrap().message_count, 1);

        // The create-call (message_count: 0 skeleton) arrives second.
        let create_row = CatalogRow {
            conv_id: "conv-race".to_string(),
            title: "".to_string(),
            created_at: 100,
            updated_at: 100,
            message_count: 0,
            last_message_id: None,
            model: None,
            source_bytes: 0,
            source_mtime: None,
            missing: false,
        };
        create_conversation_core(&conn, &create_row).unwrap();

        let after = get_core(&conn, "conv-race").unwrap().unwrap();
        assert_eq!(
            after.message_count, 1,
            "create-time upsert must not clobber a live message_count already established by bump_count"
        );
    }

    // ── 9. Fix #7 + #4 — index.json authoritative meta, no-jsonl not missing ──

    fn write_index_json(root: &Path, entries: &[(&str, &str, i64, i64, Option<&str>)]) {
        let mut entries_json = String::from("{");
        for (i, (id, title, created_at, updated_at, model)) in entries.iter().enumerate() {
            if i > 0 {
                entries_json.push(',');
            }
            let model_field = match model {
                Some(m) => format!(r#","model":{m}"#),
                None => String::new(),
            };
            entries_json.push_str(&format!(
                r#""{id}":{{"id":"{id}","title":"{title}","createdAt":{created_at},"updatedAt":{updated_at}{model_field}}}"#
            ));
        }
        entries_json.push('}');
        let content = format!(r#"{{"version":1,"entries":{entries_json}}}"#);
        stdfs::write(root.join("index.json"), content).unwrap();
    }

    #[test]
    fn reconcile_derives_title_model_created_at_from_index_json() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-a", &[&msg("m1", "user", "raw jsonl title", 100)]);
        write_index_json(
            root.path(),
            &[(
                "conv-a",
                "Authoritative Title",
                42,
                100,
                Some(r#"{"providerId":"anthropic","modelId":"claude"}"#),
            )],
        );

        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();
        let row = get_core(&conn, "conv-a").unwrap().unwrap();

        assert_eq!(row.title, "Authoritative Title", "title must come from index.json, not the JSONL-derived fallback");
        assert_eq!(row.created_at, 42, "createdAt must come from index.json (Rust can't recover it from JSONL scan alone)");
        assert_eq!(row.updated_at, 100);
        // Compare parsed JSON, not raw text: serde_json::Value serializes
        // object keys in BTreeMap (alphabetical) order, which need not match
        // the literal field order in the test fixture string.
        let model_value: Value = serde_json::from_str(row.model.as_deref().unwrap()).unwrap();
        assert_eq!(
            model_value,
            serde_json::json!({"providerId": "anthropic", "modelId": "claude"}),
            "model must be recovered from index.json"
        );
    }

    #[test]
    fn reconcile_falls_back_to_scanned_title_when_index_json_absent() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-a", &[&msg("m1", "user", "hello there", 100)]);
        // No index.json written at all.
        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();
        let row = get_core(&conn, "conv-a").unwrap().unwrap();
        assert_eq!(row.title, "hello there", "with no index.json, the Rust-derived fallback title must still work");
    }

    #[test]
    fn reconcile_does_not_mark_missing_a_conversation_with_index_json_but_no_jsonl_yet() {
        let root = tempdir().unwrap();
        stdfs::create_dir_all(root.path()).unwrap();
        // conv-empty has an index.json entry but has never had a message
        // appended — no directory, no messages.jsonl (fix #4).
        write_index_json(root.path(), &[("conv-empty", "New conversation", 10, 10, None)]);

        let conn = open_test_db();
        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.marked_missing, 0);

        let row = get_core(&conn, "conv-empty").unwrap().unwrap();
        assert!(!row.missing, "a conversation with an index.json entry but no messages.jsonl yet must stay visible, not missing");
        assert_eq!(row.message_count, 0);
        assert_eq!(row.title, "New conversation");

        let listed = list_core(&conn, 100, 0, true).unwrap();
        assert!(listed.iter().any(|r| r.conv_id == "conv-empty"), "it must show up in the visible list");
    }

    #[test]
    fn reconcile_marks_missing_a_conversation_with_neither_index_json_nor_jsonl() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-a", &[&msg("m1", "user", "a", 100)]);
        write_index_json(root.path(), &[("conv-a", "A", 100, 100, None)]);

        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();

        // Simulate a conversation the catalog knew about that has now vanished
        // entirely from both index.json and disk (a real, full delete).
        upsert_core(
            &conn,
            &CatalogRow {
                conv_id: "conv-ghost".to_string(),
                title: "ghost".to_string(),
                created_at: 1,
                updated_at: 1,
                message_count: 1,
                last_message_id: None,
                model: None,
                source_bytes: 1,
                source_mtime: Some(1),
                missing: false,
            },
        )
        .unwrap();

        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.marked_missing, 1);
        let ghost = get_core(&conn, "conv-ghost").unwrap().unwrap();
        assert!(ghost.missing, "a conv-id absent from BOTH index.json and disk must be marked missing");

        // conv-a (has both index.json entry and jsonl) must remain untouched.
        let a = get_core(&conn, "conv-a").unwrap().unwrap();
        assert!(!a.missing);
    }

    #[test]
    fn reconcile_marks_missing_a_directory_with_no_jsonl_and_no_index_entry() {
        let root = tempdir().unwrap();
        // A conversation directory exists (e.g. a stray `outputs/`-only leftover)
        // but has no messages.jsonl inside it and no index.json entry at all —
        // exercises the "(None, None)" candidate branch directly.
        let conv_dir = root.path().join("conv-orphan");
        stdfs::create_dir_all(&conv_dir).unwrap();

        let conn = open_test_db();
        upsert_core(
            &conn,
            &CatalogRow {
                conv_id: "conv-orphan".to_string(),
                title: "orphan".to_string(),
                created_at: 1,
                updated_at: 1,
                message_count: 3,
                last_message_id: None,
                model: None,
                source_bytes: 10,
                source_mtime: Some(10),
                missing: false,
            },
        )
        .unwrap();

        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.marked_missing, 1);
        assert!(get_core(&conn, "conv-orphan").unwrap().unwrap().missing);
    }

    // ── 10. Fix #6 — reconcile must not hold the DB Mutex across the scan ──

    #[test]
    fn reconcile_via_catalog_db_releases_lock_during_filesystem_scan() {
        use std::sync::mpsc;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let root = tempdir().unwrap();
        for i in 0..300 {
            write_jsonl(root.path(), &format!("conv-{i}"), &[&msg("m1", "user", "hi", 100)]);
        }

        let db_path = root.path().join("catalog.sqlite");
        let db = Arc::new(CatalogDb::open(&db_path).unwrap());

        let (tx, rx) = mpsc::channel::<()>();
        let db_for_reconcile = Arc::clone(&db);
        let conversations_root = root.path().to_path_buf();
        let reconcile_handle = std::thread::spawn(move || {
            let existing = {
                let conn = db_for_reconcile.conn.lock().unwrap();
                reconcile_read_existing_core(&conn).unwrap()
            };
            // Signal: the lock has been released; the (lock-free) filesystem
            // scan is about to start.
            tx.send(()).unwrap();
            let (upserts, mark_missing_ids, stats) =
                reconcile_scan_core(&conversations_root, &existing).unwrap();
            {
                let conn = db_for_reconcile.conn.lock().unwrap();
                reconcile_apply_core(&conn, &upserts, &mark_missing_ids).unwrap();
            }
            stats
        });

        rx.recv_timeout(Duration::from_secs(5))
            .expect("reconcile thread should signal that it entered the scan phase");

        // At this instant the (fixed) reconcile thread holds no lock — it is
        // mid filesystem-scan. Acquiring the Mutex here must be near-instant.
        // Before fix #6, reconcile held the lock for its ENTIRE call (read +
        // scan + apply), so this acquisition would block until the 300-dir
        // scan and the write transaction both finished.
        let acquire_started = Instant::now();
        {
            let _conn = db.conn.lock().unwrap();
        }
        let acquire_elapsed = acquire_started.elapsed();

        let stats = reconcile_handle.join().unwrap();
        assert_eq!(stats.scanned_dirs, 300);
        assert!(
            acquire_elapsed < Duration::from_millis(200),
            "lock acquisition during reconcile's scan phase took {acquire_elapsed:?} — the DB Mutex must be released during the filesystem walk (fix #6)"
        );
    }

    // ── 11. Fix #8 — batch every write of a reconcile pass into one commit ──

    #[test]
    fn reconcile_apply_core_batches_all_writes_into_a_single_commit() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let conn = open_test_db();
        let commit_count = Arc::new(AtomicUsize::new(0));
        {
            let counter = Arc::clone(&commit_count);
            conn.commit_hook(Some(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                false // false = allow the commit to proceed
            }));
        }

        let upserts: Vec<CatalogRow> = (0..20)
            .map(|i| CatalogRow {
                conv_id: format!("conv-{i}"),
                title: format!("t{i}"),
                created_at: i,
                updated_at: i,
                message_count: 1,
                last_message_id: Some(format!("m{i}")),
                model: None,
                source_bytes: 0,
                source_mtime: None,
                missing: false,
            })
            .collect();
        let mark_missing_ids = vec!["nonexistent-conv".to_string()];

        reconcile_apply_core(&conn, &upserts, &mark_missing_ids).unwrap();

        assert_eq!(
            commit_count.load(Ordering::SeqCst),
            1,
            "a batch of 20 upserts + 1 mark_missing must land in exactly ONE commit (fix #8), not one commit per write"
        );

        for i in 0..20 {
            assert!(get_core(&conn, &format!("conv-{i}")).unwrap().is_some());
        }
    }
}
