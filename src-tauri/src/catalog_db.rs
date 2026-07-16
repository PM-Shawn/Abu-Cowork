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

        -- Conversation-level full-text search (message-storage hybrid P2).
        -- Design doc: docs/2026-07-15-fts5-conversation-search-SPEC.md.
        -- A rebuildable projection, same invariant as conversation_catalog:
        -- catalog_reconcile repopulates it from JSONL, never authoritative.
        -- tokenize='trigram' gives substring matching (incl. CJK) without a
        -- real tokenizer; the trigram MATCH path only works for queries
        -- >=3 chars, so search_core falls back to a manual LIKE scan for
        -- shorter queries (see search_core / search_like_core).
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
            conv_id UNINDEXED,
            title,
            body,
            tokenize = 'trigram'
        );
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

/// Soft-delete: flips `missing = 1` on the catalog row AND drops the
/// conversation's FTS row (fix: a soft-deleted conversation must not keep
/// showing up in search results). Single choke point so every caller —
/// the `catalog_mark_missing` command and `reconcile_apply_core`'s vanished-
/// conversation sweep — gets this for free without a second call site.
pub fn mark_missing_core(conn: &Connection, conv_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE conversation_catalog SET missing = 1 WHERE conv_id = ?1",
        params![conv_id],
    )
    .map_err(|e| format!("catalog mark_missing failed: {}", e))?;
    fts_delete_core(conn, conv_id)?;
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

// ── FTS5 conversation search (message-storage hybrid P2) ─────────────────
//
// `conversation_fts` is a rebuildable projection exactly like
// `conversation_catalog`: never the source of truth, always repopulated from
// JSONL by `reconcile_*`. FTS5 has no UPSERT, so every write is delete-then-
// insert. See docs/2026-07-15-fts5-conversation-search-SPEC.md.

/// `may_exist` (fix #2): pass `false` only when the caller already knows
/// `conv_id` has no existing `conversation_fts` row (e.g. every conversation
/// during the very first reconcile build, tracked via `existing_fts_ids`) —
/// this skips the DELETE and goes straight to INSERT. The DELETE targets
/// `conv_id`, which is UNINDEXED, so it's a full-table scan; doing it
/// unconditionally for every brand-new conversation during the initial
/// full-scan build made that pass O(N^2) over a table that's growing by one
/// row per iteration. When in doubt, pass `true` — DELETE-then-INSERT is
/// always correct, just not always necessary.
pub fn fts_upsert_core(conn: &Connection, conv_id: &str, title: &str, body: &str, may_exist: bool) -> Result<(), String> {
    if may_exist {
        conn.execute(
            "DELETE FROM conversation_fts WHERE conv_id = ?1",
            params![conv_id],
        )
        .map_err(|e| format!("fts delete-before-insert failed: {}", e))?;
    }
    conn.execute(
        "INSERT INTO conversation_fts (conv_id, title, body) VALUES (?1, ?2, ?3)",
        params![conv_id, title, body],
    )
    .map_err(|e| format!("fts insert failed: {}", e))?;
    Ok(())
}

pub fn fts_delete_core(conn: &Connection, conv_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM conversation_fts WHERE conv_id = ?1",
        params![conv_id],
    )
    .map_err(|e| format!("fts delete failed: {}", e))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchHit {
    pub conv_id: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
}

/// Query sanitization (critical): user input is treated as a literal
/// substring, NOT FTS5 query syntax — otherwise stray `"`/`AND`/`OR`/`*`/`:`
/// in a search box would either error out or silently do something the user
/// didn't type. Doubling embedded `"` then wrapping the whole query in `"`
/// makes FTS5 parse it as a single phrase; under the trigram tokenizer a
/// phrase search is equivalent to substring matching.
fn sanitize_match_query(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

/// Escapes the LIKE metacharacters `%`, `_`, and the escape character `\`
/// itself, so a pattern built from raw user input matches literally —
/// mirroring `sanitize_match_query`'s literal-substring guarantee for the
/// trigram MATCH path, just for `LIKE ... ESCAPE '\'` instead of FTS5 MATCH
/// syntax.
fn escape_like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len());
    for c in query.chars() {
        match c {
            '\\' => escaped.push_str("\\\\"),
            '%' => escaped.push_str("\\%"),
            '_' => escaped.push_str("\\_"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// Finds the first index (in `char` units) at which `needle_lower` matches
/// `haystack` case-insensitively (ASCII-only, matching LIKE's default
/// collation). Pure char-slice comparison — no byte offsets involved, so
/// callers stay UTF-8-boundary-safe automatically.
///
/// `needle_lower` must already be lowercased by the caller. Each candidate
/// window of `haystack` is lowercased on the fly (one char at a time,
/// discarded immediately) rather than up front — this lets callers avoid
/// allocating a lowercased copy of the *entire* haystack just to find one
/// match, which matters when haystack is a long conversation body and this
/// runs per search hit.
fn find_char_subslice_ci(haystack: &[char], needle_lower: &[char]) -> Option<usize> {
    if needle_lower.is_empty() || needle_lower.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle_lower.len()).position(|w| {
        w.iter()
            .zip(needle_lower)
            .all(|(h, n)| h.to_ascii_lowercase() == *n)
    })
}

/// Builds a highlight snippet for the LIKE fallback path (1-2 char queries),
/// since `snippet()` only works alongside an FTS5 MATCH query. Mirrors the
/// trigram path's `snippet()` shape: a ~32-char window on each side of the
/// match, `…` truncation markers, and the same STX/ETX (`\u{2}`/`\u{3}`)
/// highlight sentinels `renderMarkedText` (src/utils/searchHighlight.tsx)
/// expects.
///
/// All indexing operates on `Vec<char>` (never raw byte offsets), so a
/// window boundary landing mid-CJK-run can't split a multi-byte character.
/// Matching is ASCII-case-insensitive only (matching SQLite's default LIKE
/// behavior) via `to_ascii_lowercase()`, which is guaranteed 1-char-to-1-char
/// and so never desyncs indices.
///
/// Perf note: `body_chars` (the char-indexed body) is unavoidable — the ±32
/// window below is sliced by char index for UTF-8 safety. But the match
/// search itself does NOT lowercase a second full copy of the body first;
/// `find_char_subslice_ci` lowercases each candidate window on the fly and
/// discards it immediately. Skipping that second whole-body allocation
/// matters here because this runs once per search hit (up to `LIMIT`, i.e.
/// up to 50 times per keystroke), and conversation bodies can be long.
fn build_like_snippet(body: &str, query: &str) -> String {
    const WINDOW: usize = 32;
    let body_chars: Vec<char> = body.chars().collect();
    let query_lower: Vec<char> = query.chars().map(|c| c.to_ascii_lowercase()).collect();

    let start_idx = match find_char_subslice_ci(&body_chars, &query_lower) {
        Some(i) => i,
        None => {
            // Defensive fallback: shouldn't happen since the LIKE clause
            // already matched this row, but never panic — return a leading
            // window of the body instead.
            let end = WINDOW.min(body_chars.len());
            return body_chars[..end].iter().collect();
        }
    };
    let end_idx = start_idx + query_lower.len();
    let window_start = start_idx.saturating_sub(WINDOW);
    let window_end = (end_idx + WINDOW).min(body_chars.len());

    let mut out = String::new();
    if window_start > 0 {
        out.push('…');
    }
    out.extend(&body_chars[window_start..start_idx]);
    out.push('\u{2}');
    out.extend(&body_chars[start_idx..end_idx]);
    out.push('\u{3}');
    out.extend(&body_chars[end_idx..window_end]);
    if window_end < body_chars.len() {
        out.push('…');
    }
    out
}

/// LIKE-based fallback for 1-2 char queries, which the trigram tokenizer
/// cannot match (trigram indexes only cover 3+-char runs). Substring
/// semantics are preserved literally via `escape_like_pattern`; highlighting
/// is built manually via `build_like_snippet` since `snippet()` requires an
/// FTS5 MATCH query to work.
///
/// Perf note: unlike the trigram MATCH path (index-accelerated), this is a
/// full linear LIKE scan of every non-missing conversation's `body` column —
/// there's no index that can accelerate a 1-2 char substring search. Fine at
/// the scale of one user's local conversation history; would need
/// revisiting if that history grows very large.
///
/// Concurrency tradeoff (deliberate, not an oversight): the caller
/// (`catalog_search`) runs this whole scan while holding `db.conn`'s Mutex,
/// so a 1-2 char query can briefly delay a concurrent `catalog_bump_count`
/// (fired on every message append during a running agent turn) until the
/// scan finishes. This is accepted for V1 rather than adding a second
/// (read-only) connection, because:
///   - it's bounded on both ends: the frontend debounces search input by
///     200ms (see the `isFtsSearching` effect in `Sidebar.tsx`) and this
///     query is capped by `LIMIT`, so the scan itself is short;
///   - the actual conversation *data* write is the JSONL append
///     (`src/core/session/conversationStorage.ts`), which never touches this
///     mutex at all — `catalog_bump_count` only updates the best-effort,
///     fully re-derivable-from-JSONL catalog counters (see `reconcile_core`),
///     so a brief delay to that update is harmless, not a data-loss risk.
/// If this ever proves to matter in practice (e.g. very large histories, or
/// bump_count latency becomes user-visible), the fix is a dedicated
/// read-only search connection instead of sharing `db.conn` — not attempted
/// here to avoid over-engineering a case that's currently hypothetical.
fn search_like_core(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>, String> {
    let pattern = format!("%{}%", escape_like_pattern(query));
    let mut stmt = conn
        .prepare(
            "SELECT f.conv_id, c.title, f.body
             FROM conversation_fts f
             JOIN conversation_catalog c ON c.conv_id = f.conv_id
             WHERE c.missing = 0 AND f.body LIKE ?1 ESCAPE '\\'
             ORDER BY c.updated_at DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![pattern, limit], |row| {
            let conv_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let body: String = row.get(2)?;
            Ok((conv_id, title, body))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for r in rows {
        let (conv_id, title, body) = r.map_err(|e| e.to_string())?;
        result.push(SearchHit {
            snippet: build_like_snippet(&body, query),
            conv_id,
            title,
            rank: 0.0,
        });
    }
    Ok(result)
}

/// Search conversation titles+bodies. Queries of 1-2 *characters* (not
/// bytes, so CJK counts correctly) go through `search_like_core` — the
/// trigram tokenizer can't match anything shorter than a trigram. An empty
/// (post-trim) query short-circuits to `Ok(vec![])`. Joins back to
/// `conversation_catalog` so soft-deleted (`missing = 1`) conversations
/// never surface, and so `title` reflects the catalog's authoritative value
/// rather than whatever was last indexed into FTS.
pub fn search_core(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim();
    let char_count = trimmed.chars().count();
    if char_count == 0 {
        return Ok(Vec::new());
    }
    if char_count < 3 {
        return search_like_core(conn, trimmed, limit);
    }
    // Use `trimmed`, not `query` — the LIKE branch above already trims, and
    // the MATCH branch must too: passing the untrimmed original here would
    // wrap incidental leading/trailing whitespace inside the FTS5 phrase,
    // making the same term return different/zero results depending on
    // whitespace the user didn't intend to be part of the query
    // (code-review fix #7).
    let match_query = sanitize_match_query(trimmed);
    // Highlight delimiters are the STX/ETX control characters (`\u{2}`/`\u{3}`),
    // not literal `<mark>`/`</mark>` text — titles/message bodies routinely
    // contain literal HTML-looking text in this app (it's a coding assistant),
    // and literal `<mark>` in content would otherwise be misparsed as a
    // delimiter by the frontend (`renderMarkedText` in
    // `src/utils/searchHighlight.tsx`). Control chars never occur in normal
    // text, so they're safe, unambiguous sentinels.
    let mut stmt = conn
        .prepare(
            "SELECT f.conv_id, c.title,
                    snippet(conversation_fts, 2, '\u{2}', '\u{3}', '…', 32) AS snippet,
                    bm25(conversation_fts, 0.0, 5.0, 1.0) AS rank
             FROM conversation_fts f
             JOIN conversation_catalog c ON c.conv_id = f.conv_id
             WHERE conversation_fts MATCH ?1 AND c.missing = 0
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_query, limit], |row| {
            Ok(SearchHit {
                conv_id: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                rank: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r.map_err(|e| e.to_string())?);
    }
    Ok(result)
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
    /// Concatenated `role: text` per deduped message (newline-joined), fed
    /// into `conversation_fts` by reconcile. System messages and
    /// `compact-boundary-*` marker messages are excluded — same noise
    /// filtering as the send-side path — so they don't pollute search hits.
    pub body: String,
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

    // Build the FTS body: `role: text` per deduped message, newline-joined.
    // Skip system messages and compact-boundary marker messages — mirrors the
    // send-side noise filtering so neither pollutes search results.
    let mut body_lines: Vec<String> = Vec::with_capacity(deduped.len());
    for v in &deduped {
        let is_system = v.get("isSystem").and_then(|x| x.as_bool()).unwrap_or(false);
        if is_system {
            continue;
        }
        let is_marker = v
            .get("id")
            .and_then(|x| x.as_str())
            .map(|s| s.starts_with("compact-boundary-"))
            .unwrap_or(false);
        if is_marker {
            continue;
        }
        let role = v.get("role").and_then(|x| x.as_str()).unwrap_or("");
        let text = extract_text_from_content(v.get("content"));
        body_lines.push(format!("{}: {}", role, text));
    }
    let body = body_lines.join("\n");

    Ok(Some(ScannedConversation {
        title,
        created_at,
        updated_at,
        message_count,
        last_message_id,
        source_bytes,
        source_mtime,
        corrupt_lines,
        body,
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

/// Returns the existing catalog watermarks, plus the set of conv_ids that
/// currently have an FTS row. The FTS-presence set lets `reconcile_scan_core`
/// force a rescan (and thus an `fts_upsert_core`) for a conversation whose
/// catalog watermark is unchanged but whose `conversation_fts` row was lost
/// (table dropped/corrupted/manually cleared) — otherwise the byte/mtime-diff
/// check alone would never notice, and the FTS index couldn't self-heal
/// without also wiping the whole catalog. Both are cheap SELECTs done in the
/// same short-lived lock acquisition as the original watermark read (fix #6
/// still holds: no `Connection` is threaded into the scan phase).
fn reconcile_read_existing_core(
    conn: &Connection,
) -> Result<(HashMap<String, (i64, Option<i64>, bool, String)>, HashSet<String>), String> {
    // The tuple's trailing `String` is the catalog row's current title (fix
    // #5): `reconcile_scan_core` compares it against index.json's title to
    // detect a rename and force a re-index even when the JSONL watermark
    // (bytes/mtime) hasn't moved.
    let mut existing: HashMap<String, (i64, Option<i64>, bool, String)> = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT conv_id, source_bytes, source_mtime, missing, title FROM conversation_catalog")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, i64>(3)? != 0,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for r in rows {
        let (id, bytes, mtime, missing, title) = r.map_err(|e| e.to_string())?;
        existing.insert(id, (bytes, mtime, missing, title));
    }

    // Fix #4: the delete-then-insert invariant (see module doc + fts_upsert_core)
    // guarantees at most one conversation_fts row per conv_id, so DISTINCT here
    // is a needless sort/temp-btree over a full scan — plain SELECT is enough.
    let mut existing_fts_ids: HashSet<String> = HashSet::new();
    let mut fts_stmt = conn
        .prepare("SELECT conv_id FROM conversation_fts")
        .map_err(|e| e.to_string())?;
    let fts_rows = fts_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for r in fts_rows {
        existing_fts_ids.insert(r.map_err(|e| e.to_string())?);
    }

    Ok((existing, existing_fts_ids))
}

/// Result of deriving one conversation's catalog row + FTS body from its
/// JSONL file (and optional index.json entry). Shared by `reconcile_scan_core`
/// (per-directory loop, startup/incremental rebuild) and `reindex_one_core`
/// (turn-end / rename write-through, message-storage hybrid P2) so the
/// title/body precedence logic — index.json wins when present, JSONL-derived
/// scan is the fallback — has exactly one implementation.
struct ConversationIndexResult {
    row: CatalogRow,
    body: String,
    corrupt_lines: i64,
}

/// Derive the catalog row + FTS body for ONE conversation from its JSONL file
/// and (optional) index.json entry. `disk_meta` is the caller's already-taken
/// `fs::metadata` of the JSONL path (avoids a redundant stat when the caller
/// already has it, e.g. reconcile_scan_core's directory walk).
///
/// Returns `Ok(None)` when the conversation is genuinely gone — no JSONL AND
/// no index.json entry. Callers that need "mark missing" semantics
/// (reconcile's vanished-conversation sweep) implement that themselves from
/// their own `existing` watermark map; a live single-conversation reindex
/// (`reindex_one_core`) just no-ops in that case, since marking missing is
/// delete's job, not reindex's.
fn build_conversation_row(
    conv_id: &str,
    jsonl: &Path,
    disk_meta: Option<&fs::Metadata>,
    index_meta: Option<&IndexMetaEntry>,
) -> Result<Option<ConversationIndexResult>, String> {
    match (disk_meta, index_meta) {
        (None, None) => Ok(None),
        (None, Some(meta)) => {
            // index.json knows about this conversation but there's no
            // messages.jsonl yet — a valid, never-messaged conversation
            // (fix #4). Keep it visible with message_count 0, NOT missing,
            // and no FTS body (nothing to index yet).
            let row = CatalogRow {
                conv_id: conv_id.to_string(),
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
            Ok(Some(ConversationIndexResult {
                row,
                body: String::new(),
                corrupt_lines: 0,
            }))
        }
        (Some(_), _) => {
            let scanned = match scan_conversation_file(jsonl)? {
                Some(s) => s,
                // Race: file vanished between the caller's metadata() and our
                // read. Treat like "genuinely gone" for this call — the next
                // reconcile pass (which re-stats fresh) will reconcile it.
                None => return Ok(None),
            };
            // index.json is authoritative for title/model/createdAt/updatedAt
            // when present (fix #7); the JSONL-derived values are only a
            // fallback for conversations with no index.json entry.
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
                conv_id: conv_id.to_string(),
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
            Ok(Some(ConversationIndexResult {
                row,
                body: scanned.body,
                corrupt_lines: scanned.corrupt_lines,
            }))
        }
    }
}

/// Pure filesystem scan — no `Connection` parameter (fix #6): computes what
/// needs to change without ever touching the DB, so it can run with the
/// catalog Mutex released. Returns the rows to upsert, the conv_ids to mark
/// missing, and the pass's stats; the caller applies them separately.
fn reconcile_scan_core(
    conversations_root: &Path,
    existing: &HashMap<String, (i64, Option<i64>, bool, String)>,
    existing_fts_ids: &HashSet<String>,
) -> Result<(Vec<(CatalogRow, String)>, Vec<String>, ReconcileStats), String> {
    let mut stats = ReconcileStats::default();
    let mut seen: HashSet<String> = HashSet::new();
    // Each upsert carries its FTS body alongside the CatalogRow — body isn't
    // a catalog column, it only feeds `fts_upsert_core` in reconcile_apply_core.
    let mut upserts: Vec<(CatalogRow, String)> = Vec::new();
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
                if let Some((_, _, missing, _)) = existing.get(&conv_id) {
                    if !missing {
                        mark_missing_ids.push(conv_id.clone());
                        stats.marked_missing += 1;
                    }
                }
            }
            (None, Some(_meta)) => {
                // index.json knows about this conversation but there's no
                // messages.jsonl yet — a valid, never-messaged conversation
                // (fix #4). Keep it visible with message_count 0, NOT missing.
                if let Some(result) = build_conversation_row(&conv_id, &jsonl, None, index_meta)? {
                    upserts.push((result.row, result.body));
                    stats.upserted += 1;
                }
            }
            (Some(m), _) => {
                let disk_bytes = m.len() as i64;
                let disk_mtime = mtime_ms(m);
                let needs_scan = match existing.get(&conv_id) {
                    Some((ebytes, emtime, emissing, etitle)) => {
                        // Fix #5: index.json is authoritative for title (see
                        // below). If it disagrees with what's currently in the
                        // catalog row, the conversation was renamed. A rename
                        // only touches index.json — messages.jsonl bytes/mtime
                        // are untouched — so without this check needs_scan
                        // would stay false forever and the FTS `title` column
                        // would keep serving the stale title across every
                        // future reconcile, even past app restarts.
                        let title_changed = index_meta
                            .map(|meta| meta.title != *etitle)
                            .unwrap_or(false);
                        // The `!existing_fts_ids.contains(...)` arm lets a
                        // dropped/cleared conversation_fts table self-heal on
                        // the next reconcile even when the catalog watermark
                        // itself hasn't changed (see reconcile_read_existing_core).
                        *emissing
                            || *ebytes != disk_bytes
                            || *emtime != Some(disk_mtime)
                            || !existing_fts_ids.contains(&conv_id)
                            || title_changed
                    }
                    None => true,
                };
                if !needs_scan {
                    continue;
                }

                if let Some(result) = build_conversation_row(&conv_id, &jsonl, Some(m), index_meta)? {
                    stats.corrupt_lines_skipped += result.corrupt_lines;
                    upserts.push((result.row, result.body));
                    stats.upserted += 1;
                }
            }
        }
    }

    for (conv_id, (_, _, missing, _)) in existing.iter() {
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
    upserts: &[(CatalogRow, String)],
    mark_missing_ids: &[String],
    existing_fts_ids: &HashSet<String>,
) -> Result<(), String> {
    // `unchecked_transaction` (rather than `transaction`, which needs `&mut
    // Connection`) because callers only ever hold a `&Connection` here (e.g.
    // a `MutexGuard` deref'd immutably by the rest of this module's `&Connection`-
    // typed helpers) — safe because the whole call is made while holding the
    // single connection's Mutex, so there is no concurrent use of this
    // Connection to race with.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (row, body) in upserts {
        upsert_core(&tx, row)?;
        // Fix #3: an empty body (a never-messaged conversation — index.json
        // entry but no messages.jsonl yet) is never matchable under the
        // trigram tokenizer, so skip the FTS write entirely instead of
        // unconditionally re-inserting an empty row every reconcile pass.
        if !body.is_empty() {
            // Fix #2: only DELETE-then-INSERT when this conv_id might already
            // have an FTS row (tracked in existing_fts_ids, read once before
            // the scan). A brand-new conversation can go straight to INSERT,
            // avoiding an UNINDEXED-column full-table-scan DELETE for every
            // row during the O(N) initial build.
            let may_exist = existing_fts_ids.contains(&row.conv_id);
            fts_upsert_core(&tx, &row.conv_id, &row.title, body, may_exist)?;
        }
    }
    for conv_id in mark_missing_ids {
        // mark_missing_core also drops the FTS row (soft-delete => out of search).
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
    let (existing, existing_fts_ids) = reconcile_read_existing_core(conn)?;
    let (upserts, mark_missing_ids, stats) = reconcile_scan_core(conversations_root, &existing, &existing_fts_ids)?;
    reconcile_apply_core(conn, &upserts, &mark_missing_ids, &existing_fts_ids)?;
    Ok(stats)
}

// ── Single-conversation reindex (message-storage hybrid P2: live freshness) ─
//
// `reconcile_*` above only runs at startup, so a conversation the user JUST
// chatted in isn't searchable until the next app restart. `reindex_one_core`
// re-indexes exactly ONE conversation the same way reconcile would — reusing
// `build_conversation_row` so title/body precedence never has a second
// implementation — and is called write-through at turn-end and on rename
// (see `catalogReindexConversation` on the TS side). It also incidentally
// fixes the P1.5 catalog `message_count` drift, since `upsert_core` re-derives
// every field (including message_count) fresh from the JSONL scan, same as a
// full reconcile would.
//
// Split into scan/apply (fix #1, mirrors reconcile's fix #6):
//   1. `reindex_scan_core` — pure filesystem work (index.json read + full
//      `messages.jsonl` scan). Takes NO `Connection`, so the DB Mutex can be
//      released for the whole read — this runs on the hot per-turn-end /
//      per-rename path, so without the split it would block a concurrent
//      `catalog_search` (sidebar) or `catalog_bump_count` (every message
//      append) for as long as the JSONL read takes.
//   2. `reindex_apply_core` — the upsert/FTS write, run inside a short-lived
//      transaction under the lock.
// `reindex_one_core` below just chains the two for callers (tests, and any
// single-threaded use) that don't need the lock released in between; the
// `catalog_reindex_conversation` Tauri command calls the two phases directly
// so it can scan before ever touching `db.conn.lock()`.

/// Pure filesystem scan — no `Connection` parameter (fix #1): computes the
/// catalog row + FTS body for ONE conversation without ever touching the DB,
/// so `catalog_reindex_conversation` can run it with the catalog Mutex
/// released. Returns `None` when the conversation is genuinely gone (see
/// `build_conversation_row`).
fn reindex_scan_core(
    conv_id: &str,
    conversations_root: &Path,
) -> Result<Option<ConversationIndexResult>, String> {
    let jsonl = conversations_root.join(conv_id).join("messages.jsonl");
    let disk_meta = fs::metadata(&jsonl).ok();
    let index_entries = read_index_entries(conversations_root);
    let index_meta = index_entries.get(conv_id);
    build_conversation_row(conv_id, &jsonl, disk_meta.as_ref(), index_meta)
}

/// Apply one `reindex_scan_core` result under the DB lock — the
/// single-conversation counterpart of `reconcile_apply_core`'s per-row upsert.
/// `result == None` means genuinely gone (no JSONL, no index.json entry).
/// Deliberately NOT calling mark_missing_core here — that is delete's job
/// (catalog_mark_missing / reconcile's vanished-conversation sweep), not
/// reindex's. A live reindex racing a delete should just no-op.
fn reindex_apply_core(
    conn: &Connection,
    result: Option<&ConversationIndexResult>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(ConversationIndexResult { row, body, .. }) = result {
        upsert_core(&tx, row)?;
        // Empty body (never-messaged conversation) is never matchable under
        // the trigram tokenizer — skip the FTS write, same as reconcile's
        // fix #3. `may_exist=true`: unlike the initial full-scan build, a
        // live single-conversation reindex has no cheap way to know whether
        // an FTS row already exists, and DELETE-then-INSERT is always
        // correct, just not always necessary (see fts_upsert_core doc).
        if !body.is_empty() {
            fts_upsert_core(&tx, &row.conv_id, &row.title, body, true)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Convenience wrapper chaining scan+apply on a single `Connection` — used by
/// unit tests and any single-threaded caller that doesn't need the lock
/// released in between. The `catalog_reindex_conversation` Tauri command does
/// NOT use this: it calls `reindex_scan_core` (lock-free) then
/// `reindex_apply_core` (locked) directly so the DB Mutex is released during
/// the JSONL/index.json filesystem read (fix #1). `#[cfg(test)]`-only:
/// nothing in the non-test build calls it anymore (mirrors `reconcile_core`
/// above).
#[cfg(test)]
pub fn reindex_one_core(conn: &Connection, conv_id: &str, conversations_root: &Path) -> Result<(), String> {
    let result = reindex_scan_core(conv_id, conversations_root)?;
    reindex_apply_core(conn, result.as_ref())
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
    let (existing, existing_fts_ids) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        reconcile_read_existing_core(&conn)?
    };

    // ...do all filesystem work with the lock released...
    let (upserts, mark_missing_ids, stats) = reconcile_scan_core(root, &existing, &existing_fts_ids)?;

    // ...and re-acquire only to apply every write in one transaction (fix #8).
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        reconcile_apply_core(&conn, &upserts, &mark_missing_ids, &existing_fts_ids)?;
    }

    Ok(stats)
}

/// Conversation full-text search entry point (message-storage hybrid P2).
/// `limit` defaults to 50. See `search_core` for sanitization/short-circuit
/// behavior.
#[tauri::command]
pub fn catalog_search(app: AppHandle, query: String, limit: Option<i64>) -> Result<Vec<SearchHit>, String> {
    let db = get_db(&app)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    search_core(&conn, &query, limit.unwrap_or(50))
}

/// Live-freshness reindex entry point (message-storage hybrid P2). Re-indexes
/// exactly one conversation (catalog row + FTS row) straight from its JSONL +
/// index.json, so a conversation is searchable immediately at turn-end /
/// rename instead of only after the next startup `catalog_reconcile`. See
/// `reindex_one_core` for the no-crash/no-mark-missing behavior on a
/// missing/never-messaged conversation.
///
/// Fix #1: do NOT hold the single connection Mutex across the filesystem scan
/// (index.json parse + full `messages.jsonl` read) below — this command fires
/// on the hot per-turn-end/per-rename path, so without releasing the lock a
/// concurrent `catalog_search` (sidebar) or `catalog_bump_count` (every
/// message append) would stall for the whole scan. Mirrors reconcile's fix #6.
#[tauri::command]
pub fn catalog_reindex_conversation(app: AppHandle, conv_id: String, conversations_root: String) -> Result<(), String> {
    let db = get_db(&app)?;
    let root = Path::new(&conversations_root);

    // Scan the filesystem with the lock NOT held...
    let result = reindex_scan_core(&conv_id, root)?;

    // ...and re-acquire only to apply the upsert/FTS write.
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    reindex_apply_core(&conn, result.as_ref())
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
            let (existing, existing_fts_ids) = {
                let conn = db_for_reconcile.conn.lock().unwrap();
                reconcile_read_existing_core(&conn).unwrap()
            };
            // Signal: the lock has been released; the (lock-free) filesystem
            // scan is about to start.
            tx.send(()).unwrap();
            let (upserts, mark_missing_ids, stats) =
                reconcile_scan_core(&conversations_root, &existing, &existing_fts_ids).unwrap();
            {
                let conn = db_for_reconcile.conn.lock().unwrap();
                reconcile_apply_core(&conn, &upserts, &mark_missing_ids, &existing_fts_ids).unwrap();
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

        let upserts: Vec<(CatalogRow, String)> = (0..20)
            .map(|i| {
                (
                    CatalogRow {
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
                    },
                    String::new(),
                )
            })
            .collect();
        let mark_missing_ids = vec!["nonexistent-conv".to_string()];

        reconcile_apply_core(&conn, &upserts, &mark_missing_ids, &HashSet::new()).unwrap();

        assert_eq!(
            commit_count.load(Ordering::SeqCst),
            1,
            "a batch of 20 upserts + 1 mark_missing must land in exactly ONE commit (fix #8), not one commit per write"
        );

        for i in 0..20 {
            assert!(get_core(&conn, &format!("conv-{i}")).unwrap().is_some());
        }
    }

    // ── 12. FTS5 conversation search (message-storage hybrid P2) ───────

    fn insert_catalog_row(conn: &Connection, conv_id: &str, title: &str) {
        upsert_core(
            conn,
            &CatalogRow {
                conv_id: conv_id.to_string(),
                title: title.to_string(),
                created_at: 1,
                updated_at: 1,
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

    #[test]
    fn fts_search_finds_matching_conversation_with_highlighted_snippet() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-1", "Conversation One");
        insert_catalog_row(&conn, "conv-2", "Conversation Two");
        fts_upsert_core(&conn, "conv-1", "Conversation One", "user: let's discuss the widget rollout plan", true).unwrap();
        fts_upsert_core(&conn, "conv-2", "Conversation Two", "user: totally unrelated content", true).unwrap();

        let hits = search_core(&conn, "widget rollout", 50).unwrap();
        assert_eq!(hits.len(), 1, "only conv-1's body matches");
        assert_eq!(hits[0].conv_id, "conv-1");
        assert!(!hits[0].snippet.is_empty());
        // Highlight markers are STX/ETX sentinel control chars, not literal
        // `<mark>` text — see the comment on `search_core`'s snippet() call.
        assert!(
            hits[0].snippet.contains('\u{2}') && hits[0].snippet.contains('\u{3}'),
            "snippet must contain STX/ETX highlight sentinels, got: {:?}",
            hits[0].snippet
        );
    }

    #[test]
    fn fts_search_match_path_is_whitespace_insensitive() {
        // code-review fix #7: search_core's 3+-char MATCH branch used to pass
        // the untrimmed `query` to sanitize_match_query while the <3-char LIKE
        // branch correctly used `trimmed` — so the same term surrounded by
        // incidental leading/trailing whitespace returned different (often
        // zero) results depending on the untrimmed original. Both branches
        // must now agree: a query with surrounding whitespace must return the
        // exact same hits as the trimmed query.
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-1", "Conversation One");
        fts_upsert_core(&conn, "conv-1", "Conversation One", "user: let's discuss the widget rollout plan", true).unwrap();

        let hits_trimmed = search_core(&conn, "widget rollout", 50).unwrap();
        let hits_padded = search_core(&conn, "  widget rollout  ", 50).unwrap();

        assert_eq!(hits_trimmed.len(), 1, "trimmed query must match");
        assert_eq!(
            hits_padded.len(),
            1,
            "query with surrounding whitespace must match identically to the trimmed query, got: {:?}",
            hits_padded
        );
        assert_eq!(hits_trimmed[0].conv_id, hits_padded[0].conv_id);
    }

    #[test]
    fn fts_search_cjk_trigram_hits_and_short_query_falls_back_to_like() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-cjk", "重构消息存储架构讨论");
        fts_upsert_core(&conn, "conv-cjk", "重构消息存储架构讨论", "user: 我们来聊聊重构消息存储架构的方案", true).unwrap();

        let hits = search_core(&conn, "消息存储", 50).unwrap();
        assert_eq!(hits.len(), 1, "a >=3-char CJK substring must hit via the trigram tokenizer");
        assert_eq!(hits[0].conv_id, "conv-cjk");

        // A <3-char query must no longer short-circuit to empty — it should
        // fall back to the LIKE scan and still find the conversation (counted
        // by chars not bytes, since "消息" is 2 chars / 6 bytes).
        let short_hits = search_core(&conn, "消息", 50).unwrap();
        assert_eq!(
            short_hits.len(),
            1,
            "a <3-char CJK query must find the conversation via the LIKE fallback"
        );
        assert_eq!(short_hits[0].conv_id, "conv-cjk");
    }

    // ── 15. Short-query (<3 char) LIKE fallback (search naturally at any length) ──

    #[test]
    fn fts_search_one_char_cjk_query_finds_body_match_with_highlighted_snippet() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-tax", "财务讨论");
        fts_upsert_core(&conn, "conv-tax", "财务讨论", "user: 今年的税率上调了不少", true).unwrap();

        let hits = search_core(&conn, "税", 50).unwrap();
        assert_eq!(hits.len(), 1, "a 1-char CJK query must find a conversation whose BODY contains it");
        assert_eq!(hits[0].conv_id, "conv-tax");
        assert!(
            hits[0].snippet.contains('\u{2}') && hits[0].snippet.contains('\u{3}'),
            "the LIKE-path snippet must still wrap the match in STX/ETX sentinels, got: {:?}",
            hits[0].snippet
        );
        // The matched char itself must sit between the sentinels.
        let stx = hits[0].snippet.find('\u{2}').unwrap();
        let etx = hits[0].snippet.find('\u{3}').unwrap();
        assert_eq!(&hits[0].snippet[stx + '\u{2}'.len_utf8()..etx], "税");
    }

    #[test]
    fn fts_search_two_char_query_finds_body_match() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-ab", "Some Conversation");
        fts_upsert_core(&conn, "conv-ab", "Some Conversation", "user: the ab test results are in", true).unwrap();

        let hits = search_core(&conn, "ab", 50).unwrap();
        assert_eq!(hits.len(), 1, "a 2-char query must find a conversation whose body contains it");
        assert_eq!(hits[0].conv_id, "conv-ab");
    }

    #[test]
    fn fts_search_like_metachars_are_treated_literally() {
        let conn = open_test_db();
        // conv-pct's body contains the literal substring "a%"; conv-other's
        // body contains a bare 'a' but NOT "a%" immediately after it. A
        // correctly-escaped LIKE query for "a%" must match only conv-pct —
        // an unescaped implementation would treat '%' as a wildcard and
        // (since any string with a bare 'a' satisfies "%a%%") incorrectly
        // match conv-other too.
        insert_catalog_row(&conn, "conv-pct", "Discount Talk");
        fts_upsert_core(&conn, "conv-pct", "Discount Talk", "user: let's give a% discount today", true).unwrap();
        insert_catalog_row(&conn, "conv-other", "Other Conversation");
        fts_upsert_core(&conn, "conv-other", "Other Conversation", "user: totally unrelated content here", true).unwrap();

        let hits = search_core(&conn, "a%", 50).unwrap();
        assert_eq!(hits.len(), 1, "a literal '%' in the query must not act as a wildcard: {:?}", hits.iter().map(|h| &h.conv_id).collect::<Vec<_>>());
        assert_eq!(hits[0].conv_id, "conv-pct");

        // Likewise "_" is a LIKE single-char wildcard and must be literal.
        // conv-underscore's body contains "o_" literally; conv-other has
        // plenty of bare 'o's but none immediately followed by '_'.
        insert_catalog_row(&conn, "conv-underscore", "Underscore Talk");
        fts_upsert_core(&conn, "conv-underscore", "Underscore Talk", "user: the variable is named fo_bar", true).unwrap();
        let underscore_hits = search_core(&conn, "o_", 50).unwrap();
        assert_eq!(
            underscore_hits.len(),
            1,
            "a literal '_' in the query must not act as a single-char wildcard: {:?}",
            underscore_hits.iter().map(|h| &h.conv_id).collect::<Vec<_>>()
        );
        assert_eq!(underscore_hits[0].conv_id, "conv-underscore");
    }

    #[test]
    fn fts_search_short_query_utf8_boundary_safety_mid_cjk_run() {
        let conn = open_test_db();
        // A body that is a long, unbroken run of CJK characters around the
        // match, so a naive byte-offset +/-32 window would very likely land
        // mid-character. char-based windowing must never panic and must
        // always produce valid UTF-8.
        let padding_before: String = "重构消息存储架构讨论一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥".repeat(3);
        let padding_after: String = "长会话稳健性大修计划审批排队中止桌宠观测部署实验功能开关创作工作台版本历史差异视图".repeat(3);
        let body = format!("user: {padding_before}税{padding_after}");
        insert_catalog_row(&conn, "conv-boundary", "Boundary Test");
        fts_upsert_core(&conn, "conv-boundary", "Boundary Test", &body, true).unwrap();

        let hits = search_core(&conn, "税", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conv_id, "conv-boundary");
        // If this constructed an invalid byte offset mid-character, either
        // the code would have panicked already, or `hits[0].snippet` would
        // fail basic sanity checks below.
        assert!(hits[0].snippet.contains('税'));
        assert!(hits[0].snippet.starts_with('…'), "a mid-body match must have a leading truncation marker");
        assert!(hits[0].snippet.ends_with('…'), "a mid-body match must have a trailing truncation marker");
    }

    #[test]
    fn build_like_snippet_window_and_case_insensitive_match_unchanged_on_long_body() {
        // Regression test for the perf optimization that removed the second
        // full-body-lowercase `Vec<char>` allocation from `build_like_snippet`
        // (now `find_char_subslice_ci` lowercases each candidate window on
        // the fly instead). Exercises a body long enough that the ±32-char
        // window sits mid-string on both sides, and a query whose case
        // doesn't match the body (case-insensitive match) — asserting the
        // exact same window/sentinel/truncation output as before the change.
        let before = "a".repeat(100);
        let after = "b".repeat(100);
        let body = format!("{before}NEEDLE{after}");

        let snippet = build_like_snippet(&body, "needle");

        assert!(snippet.starts_with('…'), "100 chars precede the match, so the window must be left-truncated");
        assert!(snippet.ends_with('…'), "100 chars follow the match, so the window must be right-truncated");
        assert!(
            snippet.contains("\u{2}NEEDLE\u{3}"),
            "matched text must keep its original casing, wrapped verbatim in STX/ETX sentinels, got: {:?}",
            snippet
        );
        let stx = snippet.find('\u{2}').unwrap();
        let etx = snippet.find('\u{3}').unwrap();
        let before_window = &snippet['…'.len_utf8()..stx];
        let after_window = &snippet[etx + '\u{3}'.len_utf8()..snippet.len() - '…'.len_utf8()];
        assert_eq!(before_window, "a".repeat(32), "exactly 32 chars of left context expected");
        assert_eq!(after_window, "b".repeat(32), "exactly 32 chars of right context expected");
    }

    #[test]
    fn fts_rebuild_from_jsonl_via_reconcile() {
        let root = tempdir().unwrap();
        write_jsonl(
            root.path(),
            "conv-rebuild",
            &[&msg("m1", "user", "the quarterly roadmap review notes", 100)],
        );
        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();

        // Sanity: searchable right after the first reconcile.
        assert_eq!(search_core(&conn, "roadmap review", 50).unwrap().len(), 1);

        // Simulate the FTS projection being lost/corrupted while the catalog
        // table (and its on-disk watermark) is untouched — the JSONL file
        // itself never changes.
        conn.execute("DELETE FROM conversation_fts", []).unwrap();
        assert!(search_core(&conn, "roadmap review", 50).unwrap().is_empty());

        // Reconcile again — it must notice the missing FTS row (even though
        // the catalog watermark hasn't drifted) and rebuild it from JSONL.
        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.upserted, 1, "the FTS-less conversation must be rescanned to self-heal its FTS row");
        let hits = search_core(&conn, "roadmap review", 50).unwrap();
        assert_eq!(hits.len(), 1, "reconcile must rebuild the FTS row from JSONL after the FTS table is emptied");
        assert_eq!(hits[0].conv_id, "conv-rebuild");
    }

    #[test]
    fn fts_soft_delete_removes_conversation_from_search_results() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-del", "Conversation To Delete");
        fts_upsert_core(&conn, "conv-del", "Conversation To Delete", "user: some searchable phrase here", true).unwrap();
        assert_eq!(search_core(&conn, "searchable phrase", 50).unwrap().len(), 1);

        mark_missing_core(&conn, "conv-del").unwrap();

        let hits = search_core(&conn, "searchable phrase", 50).unwrap();
        assert!(hits.is_empty(), "a soft-deleted (missing=1) conversation must not appear in search results");
    }

    #[test]
    fn fts_search_sanitizes_query_and_never_errors_on_fts5_syntax() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-x", "Some Conversation");
        fts_upsert_core(&conn, "conv-x", "Some Conversation", "user: plain body text here", true).unwrap();

        // A literal double quote and FTS5 boolean-operator-looking input must
        // not be interpreted as FTS5 query syntax — both must return Ok
        // (possibly empty), never an Err, proving injection is neutralized.
        let quote_result = search_core(&conn, "a\"b", 50);
        assert!(quote_result.is_ok(), "a query containing a double-quote must not error: {:?}", quote_result.err());

        let operator_result = search_core(&conn, "foo OR bar", 50);
        assert!(operator_result.is_ok(), "a query containing FTS5 operators must not error: {:?}", operator_result.err());
    }

    // ── 13. Fix #1 — bm25 title boost ranks a title match above a body-only match ──

    #[test]
    fn fts_search_ranks_title_match_above_body_only_match() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-title-hit", "Quarterly Budget Review");
        insert_catalog_row(&conn, "conv-body-hit", "Unrelated Conversation");

        // conv-title-hit matches the query in its TITLE; its body is short
        // and otherwise unrelated to the query.
        fts_upsert_core(&conn, "conv-title-hit", "Quarterly Budget Review", "user: let's sync tomorrow", true).unwrap();

        // conv-body-hit matches the query only once, deep inside a long,
        // otherwise-unrelated BODY; its title is completely unrelated. Under
        // the old buggy weighting (bm25(fts, 5.0, 1.0) — 5.0 landing on the
        // UNINDEXED conv_id column and 1.0 on title) title got no real boost
        // over body, so a long body match could out-rank a title match. Fix
        // #1's bm25(fts, 0.0, 5.0, 1.0) puts the boost on title (5.0) vs body
        // (1.0), so the title match must win.
        let long_body = format!(
            "user: {}quarterly budget review appears once in a much longer unrelated passage{}",
            "padding text ".repeat(40),
            " more padding text".repeat(40)
        );
        fts_upsert_core(&conn, "conv-body-hit", "Unrelated Conversation", &long_body, true).unwrap();

        let hits = search_core(&conn, "quarterly budget review", 50).unwrap();
        assert_eq!(hits.len(), 2, "both conversations must match (one via title, one via body)");
        assert_eq!(
            hits[0].conv_id, "conv-title-hit",
            "the TITLE match must rank first under the boosted bm25 weights (fix #1); got order {:?}",
            hits.iter().map(|h| (&h.conv_id, h.rank)).collect::<Vec<_>>()
        );
        assert_eq!(hits[1].conv_id, "conv-body-hit");
    }

    // ── 14. Fix #2 — initial-build inserts skip the O(N^2) delete-before-insert ──

    #[test]
    fn fts_upsert_core_may_exist_false_skips_delete_and_still_inserts_correctly() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-fresh", "Fresh Conversation");
        // may_exist=false is the fast path used for brand-new conversations
        // during the initial reconcile build (fix #2): it must go straight to
        // INSERT without a DELETE, and still produce a correct, searchable row.
        fts_upsert_core(&conn, "conv-fresh", "Fresh Conversation", "user: brand new content here", false).unwrap();

        let hits = search_core(&conn, "brand new content", 50).unwrap();
        assert_eq!(hits.len(), 1, "the may_exist=false insert-only path must still produce a searchable row");
        assert_eq!(hits[0].conv_id, "conv-fresh");

        // Sanity: exactly one row — no phantom duplicate from skipping the DELETE.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation_fts WHERE conv_id = 'conv-fresh'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "may_exist=false must not leave behind a duplicate row when none existed before");
    }

    #[test]
    fn reconcile_initial_build_indexes_many_new_conversations_via_insert_only_path() {
        let root = tempdir().unwrap();
        for i in 0..5 {
            write_jsonl(
                root.path(),
                &format!("conv-{i}"),
                &[&msg("m1", "user", &format!("unique topic {i} content"), 100)],
            );
        }
        let conn = open_test_db();
        // First-ever reconcile: existing_fts_ids is empty for every
        // conversation, so every fts_upsert_core call inside
        // reconcile_apply_core takes the insert-only (may_exist=false) path
        // (fix #2) instead of an UNINDEXED-column full-table-scan DELETE per
        // row. This must still produce correct, independently searchable rows.
        reconcile_core(&conn, root.path()).unwrap();
        for i in 0..5 {
            let hits = search_core(&conn, &format!("unique topic {i}"), 50).unwrap();
            assert_eq!(hits.len(), 1, "conv-{i} must be searchable after the insert-only initial build");
            assert_eq!(hits[0].conv_id, format!("conv-{i}"));
        }
    }

    // ── 15. Fix #3 — never-messaged conversations don't churn the FTS table ──

    #[test]
    fn never_messaged_conversation_produces_no_fts_row_and_no_per_pass_churn() {
        let root = tempdir().unwrap();
        stdfs::create_dir_all(root.path()).unwrap();
        // conv-never has an index.json entry but has never had a message
        // appended — no directory, no messages.jsonl (same fixture shape as
        // fix #4's existing coverage).
        write_index_json(root.path(), &[("conv-never", "Never messaged", 10, 10, None)]);

        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation_fts WHERE conv_id = 'conv-never'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "fix #3: a never-messaged conversation (empty body) must produce no FTS row at all");

        // A second reconcile pass over the same, unchanged disk state must
        // not create one either (no per-pass churn).
        reconcile_core(&conn, root.path()).unwrap();
        let count_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation_fts WHERE conv_id = 'conv-never'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_after, 0, "a second reconcile pass over an unchanged never-messaged conversation must still produce no FTS row");

        // The catalog row itself must still be visible and correct.
        let row = get_core(&conn, "conv-never").unwrap().unwrap();
        assert!(!row.missing);
        assert_eq!(row.title, "Never messaged");
    }

    // ── 16. Fix #4 — conversation_fts never has duplicate conv_id rows ──

    #[test]
    fn conversation_fts_never_has_duplicate_conv_id_rows() {
        let conn = open_test_db();
        insert_catalog_row(&conn, "conv-dup", "Conv");
        fts_upsert_core(&conn, "conv-dup", "Conv", "user: first body", true).unwrap();
        fts_upsert_core(&conn, "conv-dup", "Conv", "user: second body replacing first", true).unwrap();

        // The delete-then-insert invariant guarantees at most one FTS row per
        // conv_id — this is exactly the invariant that makes
        // reconcile_read_existing_core's plain `SELECT conv_id` (no DISTINCT,
        // fix #4) safe: DISTINCT would be defending against duplicates that
        // can never occur.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation_fts WHERE conv_id = 'conv-dup'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "at most one conversation_fts row must ever exist per conv_id");
    }

    // ── 17. Fix #5 — a rename (index.json title change) re-indexes the FTS title ──

    #[test]
    fn reconcile_reindexes_fts_title_when_index_json_title_changes_without_touching_jsonl() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-rename", &[&msg("m1", "user", "original message body text", 100)]);
        write_index_json(root.path(), &[("conv-rename", "Title A", 100, 100, None)]);

        let conn = open_test_db();
        reconcile_core(&conn, root.path()).unwrap();

        assert_eq!(get_core(&conn, "conv-rename").unwrap().unwrap().title, "Title A");
        let hits_a = search_core(&conn, "Title A", 50).unwrap();
        assert_eq!(hits_a.len(), 1, "the original title must be searchable before the rename");

        // Rename: only index.json changes. messages.jsonl bytes/mtime are
        // deliberately left untouched — this is the exact scenario that used
        // to leave the FTS `title` column stuck on the old value forever.
        write_index_json(root.path(), &[("conv-rename", "Title B", 100, 100, None)]);

        let stats = reconcile_core(&conn, root.path()).unwrap();
        assert_eq!(stats.upserted, 1, "fix #5: a title-only rename must force a re-index even though the JSONL is byte-for-byte unchanged");

        assert_eq!(get_core(&conn, "conv-rename").unwrap().unwrap().title, "Title B", "catalog title must reflect the rename");

        let hits_b = search_core(&conn, "Title B", 50).unwrap();
        assert_eq!(hits_b.len(), 1, "searching the NEW title must hit after reconcile");
        assert_eq!(hits_b[0].conv_id, "conv-rename");

        let hits_a_after = search_core(&conn, "Title A", 50).unwrap();
        assert!(hits_a_after.is_empty(), "searching the OLD title must no longer hit by title after the rename+reconcile");
    }

    // ── 18. reindex_one_core — live freshness write-through (message-storage hybrid P2) ──

    #[test]
    fn reindex_one_core_indexes_a_single_conversation_catalog_row_and_fts_row() {
        let root = tempdir().unwrap();
        write_jsonl(
            root.path(),
            "conv-live",
            &[&msg("m1", "user", "let's plan the widget launch", 100)],
        );
        write_index_json(root.path(), &[("conv-live", "Widget Launch Plan", 100, 100, None)]);

        let conn = open_test_db();
        // No startup reconcile has run — this proves reindex_one_core alone
        // (the turn-end write-through path) is sufficient to make a brand
        // new conversation searchable without waiting for the next restart.
        reindex_one_core(&conn, "conv-live", root.path()).unwrap();

        let row = get_core(&conn, "conv-live").unwrap().unwrap();
        assert_eq!(row.title, "Widget Launch Plan", "title must come from index.json");
        assert_eq!(row.message_count, 1);
        assert!(!row.missing);

        let hits = search_core(&conn, "widget launch", 50).unwrap();
        assert_eq!(hits.len(), 1, "the conversation must be searchable immediately, no restart/reconcile required");
        assert_eq!(hits[0].conv_id, "conv-live");
    }

    #[test]
    fn reindex_one_core_picks_up_appended_text_and_updated_message_count() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-append", &[&msg("m1", "user", "initial message", 100)]);
        write_index_json(root.path(), &[("conv-append", "Append Test", 100, 100, None)]);

        let conn = open_test_db();
        reindex_one_core(&conn, "conv-append", root.path()).unwrap();
        assert_eq!(get_core(&conn, "conv-append").unwrap().unwrap().message_count, 1);
        assert!(search_core(&conn, "brand new followup text", 50).unwrap().is_empty());

        // Simulate a new turn: JSONL gains a message, index.json's updatedAt moves.
        write_jsonl(
            root.path(),
            "conv-append",
            &[
                &msg("m1", "user", "initial message", 100),
                &msg("m2", "assistant", "here is brand new followup text", 200),
            ],
        );
        write_index_json(root.path(), &[("conv-append", "Append Test", 100, 200, None)]);

        reindex_one_core(&conn, "conv-append", root.path()).unwrap();

        let row = get_core(&conn, "conv-append").unwrap().unwrap();
        assert_eq!(row.message_count, 2, "message_count must be re-derived fresh from the JSONL scan (also fixes P1.5 count drift)");
        assert_eq!(row.updated_at, 200);

        let hits = search_core(&conn, "brand new followup text", 50).unwrap();
        assert_eq!(hits.len(), 1, "newly appended text must be searchable after reindex");
        assert_eq!(hits[0].conv_id, "conv-append");
    }

    #[test]
    fn reindex_one_core_reflects_a_rename_from_index_json() {
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-rn", &[&msg("m1", "user", "some conversation content", 100)]);
        write_index_json(root.path(), &[("conv-rn", "Old Title", 100, 100, None)]);

        let conn = open_test_db();
        reindex_one_core(&conn, "conv-rn", root.path()).unwrap();
        assert_eq!(get_core(&conn, "conv-rn").unwrap().unwrap().title, "Old Title");
        assert_eq!(search_core(&conn, "Old Title", 50).unwrap().len(), 1);

        // Rename: only index.json's title changes (matches renameConversation's
        // write-through — messages.jsonl is untouched).
        write_index_json(root.path(), &[("conv-rn", "New Title", 100, 100, None)]);
        reindex_one_core(&conn, "conv-rn", root.path()).unwrap();

        assert_eq!(get_core(&conn, "conv-rn").unwrap().unwrap().title, "New Title", "catalog title must reflect the rename immediately");
        let hits_new = search_core(&conn, "New Title", 50).unwrap();
        assert_eq!(hits_new.len(), 1, "new title must be searchable immediately after reindex, no restart required");
        assert_eq!(hits_new[0].conv_id, "conv-rn");

        let hits_old = search_core(&conn, "Old Title", 50).unwrap();
        assert!(hits_old.is_empty(), "old title must no longer be searchable after the rename+reindex");
    }

    #[test]
    fn reindex_one_core_no_ops_on_a_conversation_with_no_jsonl_and_no_index_entry() {
        let root = tempdir().unwrap();
        let conn = open_test_db();
        // Neither messages.jsonl nor an index.json entry exists for this id —
        // e.g. a stale/already-deleted conv_id reaching a late write-through
        // call. Must not crash, must not create a phantom row.
        reindex_one_core(&conn, "conv-ghost", root.path()).unwrap();
        assert!(get_core(&conn, "conv-ghost").unwrap().is_none(), "no row should be created for a conversation with no JSONL and no index.json entry");
    }

    #[test]
    fn reindex_one_core_handles_never_messaged_conversation_without_writing_fts() {
        let root = tempdir().unwrap();
        // index.json entry exists but messages.jsonl was never created (brand
        // new conversation before the first message is sent).
        write_index_json(root.path(), &[("conv-empty-new", "Fresh Chat", 100, 100, None)]);

        let conn = open_test_db();
        reindex_one_core(&conn, "conv-empty-new", root.path()).unwrap();

        let row = get_core(&conn, "conv-empty-new").unwrap().unwrap();
        assert_eq!(row.message_count, 0);
        assert!(!row.missing, "a never-messaged conversation must stay visible, not missing");

        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation_fts WHERE conv_id = 'conv-empty-new'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts_count, 0, "an empty body must never produce an FTS row (nothing to match under the trigram tokenizer)");
    }

    #[test]
    fn reindex_one_core_does_not_mark_missing_when_conversation_vanishes() {
        // reindex_one_core must never call mark_missing_core — that is
        // delete's job. A conversation that already has a catalog+FTS row
        // and then vanishes (dir removed) mid-reindex must simply be left
        // alone (stale row), not soft-deleted, since a delete's own explicit
        // catalog_mark_missing call is the only path allowed to do that.
        let root = tempdir().unwrap();
        write_jsonl(root.path(), "conv-vanish", &[&msg("m1", "user", "will vanish soon", 100)]);
        write_index_json(root.path(), &[("conv-vanish", "Vanishing", 100, 100, None)]);

        let conn = open_test_db();
        reindex_one_core(&conn, "conv-vanish", root.path()).unwrap();
        assert!(!get_core(&conn, "conv-vanish").unwrap().unwrap().missing);

        // Directory and index.json entry both disappear (simulates a delete
        // racing a queued reindex).
        stdfs::remove_dir_all(root.path().join("conv-vanish")).unwrap();
        stdfs::write(root.path().join("index.json"), r#"{"version":1,"entries":{}}"#).unwrap();

        reindex_one_core(&conn, "conv-vanish", root.path()).unwrap();

        let row = get_core(&conn, "conv-vanish").unwrap().unwrap();
        assert!(!row.missing, "reindex_one_core must never mark a row missing — that stays delete's exclusive responsibility");
    }

    // ── 19. Fix #1 — reindex must not hold the DB Mutex across the scan ────

    #[test]
    fn catalog_reindex_conversation_releases_lock_during_filesystem_scan() {
        // Mirrors test #10 (`reconcile_via_catalog_db_releases_lock_during_
        // filesystem_scan`) but for the live single-conversation reindex path
        // (turn-end / rename write-through) — this is the hot path that fix
        // #1 addresses: it must scan the JSONL file with the DB Mutex
        // released, not hold it across the whole read like reconcile used to
        // before fix #6.
        use std::sync::mpsc;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let root = tempdir().unwrap();
        // One conversation with a large JSONL so the scan takes measurable time.
        let lines: Vec<String> = (0..20_000)
            .map(|i| msg(&format!("m{i}"), "user", "padding text so the scan takes measurable time", i as i64))
            .collect();
        let line_refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_jsonl(root.path(), "conv-big", &line_refs);
        write_index_json(root.path(), &[("conv-big", "Big Conversation", 100, 100, None)]);

        let db_path = root.path().join("catalog.sqlite");
        let db = Arc::new(CatalogDb::open(&db_path).unwrap());

        let (tx, rx) = mpsc::channel::<()>();
        let db_for_reindex = Arc::clone(&db);
        let conversations_root = root.path().to_path_buf();
        let reindex_handle = std::thread::spawn(move || {
            // Signal right before the lock-free scan starts — mirrors the
            // production command's sequencing (scan first, lock only to apply).
            tx.send(()).unwrap();
            let result = reindex_scan_core("conv-big", &conversations_root).unwrap();
            let conn = db_for_reindex.conn.lock().unwrap();
            reindex_apply_core(&conn, result.as_ref()).unwrap();
        });

        rx.recv_timeout(Duration::from_secs(5))
            .expect("reindex thread should signal that it entered the scan phase");

        // At this instant the (fixed) reindex thread holds no lock — it is
        // mid filesystem-scan. Acquiring the Mutex here must be near-instant.
        // Before fix #1, catalog_reindex_conversation locked db.conn BEFORE
        // calling into the scan, so this acquisition would block until the
        // whole 20k-line JSONL scan (and the write transaction) finished.
        let acquire_started = Instant::now();
        {
            let _conn = db.conn.lock().unwrap();
        }
        let acquire_elapsed = acquire_started.elapsed();

        reindex_handle.join().unwrap();

        assert!(
            get_core(&db.conn.lock().unwrap(), "conv-big").unwrap().is_some(),
            "the split scan/apply must still land the row"
        );
        assert!(
            acquire_elapsed < Duration::from_millis(200),
            "lock acquisition during reindex's scan phase took {acquire_elapsed:?} — the DB Mutex must be released during the filesystem scan (fix #1)"
        );
    }
}
