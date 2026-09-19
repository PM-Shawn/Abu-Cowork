/**
 * Conversation storage, as the renderer sees it.
 *
 * The writing itself lives in `conversationWriter.ts`; this file owns one
 * instance of it, wired with the renderer's file primitives
 * (`conversationFsRenderer.ts`) and all three capabilities — the renderer is
 * the only tier that instantiates a writer in this build, so it holds the
 * version sweep, the daily index backup and `index.json`. Every export below is
 * that instance's method under the name its callers already use.
 *
 * The SQLite catalog and full-text search functions stay here: they are
 * main-process commands about a projection of the files, not writes to them.
 *
 * In the Node sidecar this whole file is replaced at bundle time by
 * `sidecar/src/shims/conversationStorageRun.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { runtimeErrorType, traceRuntimeEvent } from '@/core/observability/runtimeTrace';
import { findToolResultImageSnapshot, refreshOutputManifest } from './outputSnapshots';
import { APP_VERSION } from '@/utils/version';
import { acceptConversationPermissionMode } from './conversationPermissionMode';
import { rendererConversationFs } from './conversationFsRenderer';
import {
  createConversationWriter,
  type ConversationIndex,
  type ConversationMeta,
} from './conversationWriter';
import type { PermissionMode } from '../permissions/permissionMode';
import type { Message } from '@/types';

export type { ConversationMeta } from './conversationWriter';

const writer = createConversationWriter({
  fs: rendererConversationFs,
  env: {
    appDataDir: () => appDataDir(),
    appVersion: APP_VERSION,
    now: () => Date.now(),
    randomSuffix: () => Math.random().toString(36).substring(2, 8),
    trace: (event, attributes) => traceRuntimeEvent(`renderer.${event}`, attributes),
    errorType: runtimeErrorType,
    // Called through, not read here: `outputSnapshots` is reached the first
    // time a write needs it, the way this module has always reached it.
    outputManifest: {
      refresh: (convId) => refreshOutputManifest(convId),
      findToolResultImageSnapshot: (convId, toolCallId) => findToolResultImageSnapshot(convId, toolCallId),
    },
    catalogBumpCount: (convId, delta, updatedAt, lastMessageId) => catalogBumpCount(convId, delta, updatedAt, lastMessageId),
  },
  // The renderer is the only tier that instantiates a writer, so it holds every one-per-install job.
  capabilities: { versionSweep: true, dailyBackup: true, indexWriter: true },
});

// ════════════════════════════════════════════════════════════
// Write queue and ledger watermark
// ════════════════════════════════════════════════════════════

/**
 * Force-flush all pending writes. Call before app exit or crash recovery.
 */
export async function flushWrites(): Promise<void> {
  await writer.flushWrites();
}

/**
 * Flush the write queue and report the ledger's size in bytes — the offset up
 * to which every line is durable and complete, which is what makes it usable
 * as a cut point by a reader in another process (`decodeLedgerPrefix` in
 * `ledgerReader.ts`).
 */
export async function flushAndGetLedgerWatermark(convId: string): Promise<number> {
  return writer.flushAndGetLedgerWatermark(convId);
}

// ════════════════════════════════════════════════════════════
// Stream snapshot
// ════════════════════════════════════════════════════════════

/**
 * Record an in-flight revision without touching the ledger.
 *
 * Use this for anything that fires on a timer or per tool result while a turn
 * is still running. Use `replaceMessageById` at the checkpoints where the
 * state is worth a permanent line.
 */
export async function snapshotMessageRevision(convId: string, message: Message): Promise<void> {
  await writer.snapshotMessageRevision(convId, message);
}

/**
 * Promote one conversation's buffered revisions into its ledger and drop them
 * from the snapshot; every other conversation's buffer is left alone.
 */
export async function promoteStreamSnapshots(convId: string): Promise<number> {
  return writer.promoteStreamSnapshots(convId);
}

/**
 * Whether this conversation holds a revision that is not a ledger line yet.
 *
 * Read-only: a dispatch taking its history point (`ledgerHistoryPoint.ts`)
 * asks after the watermark, because a frame that lands during the promotion
 * arms a revision the watermark it just took cannot cover.
 */
export function hasArmedStreamSnapshot(convId: string): boolean {
  return writer.hasArmedStreamSnapshot(convId);
}

/**
 * Promote every buffered revision into the ledger and drop the snapshot files.
 * Called on shutdown so a snapshot never outlives the session that wrote it.
 */
export async function flushStreamSnapshots(): Promise<void> {
  await writer.flushStreamSnapshots();
}

/**
 * Check whether a message id has already taken the disk-append path — i.e.
 * mirrors the exact dedup condition `appendMessage` uses to decide whether to
 * fire its `catalogBumpCount(+1)`.
 */
export function isMessageWrittenToDisk(id: string): boolean {
  return writer.isMessageWrittenToDisk(id);
}

// ════════════════════════════════════════════════════════════
// Index management
// ════════════════════════════════════════════════════════════

export async function loadIndex(): Promise<ConversationIndex> {
  return writer.loadIndex();
}

export function getIndexEntries(): Record<string, ConversationMeta> {
  return writer.getIndexEntries();
}

/**
 * Replace a conversation's row. The row passes the same rule as a row read
 * from disk: an entry can reach this writer without passing the reader (the
 * store keeps a localStorage row that has no disk row yet), and a permission
 * mode this build does not accept must not become durable that way.
 */
export async function updateIndexEntry(meta: ConversationMeta): Promise<void> {
  await writer.updateIndexEntry(meta);
}

export async function removeIndexEntry(convId: string): Promise<void> {
  await writer.removeIndexEntry(convId);
}

export async function flushIndex(): Promise<void> {
  await writer.flushIndex();
}

// ════════════════════════════════════════════════════════════
// SQLite conversation catalog — write-through (message-storage P0)
// ════════════════════════════════════════════════════════════
//
// The catalog is a REBUILDABLE PROJECTION of the JSONL files (see
// docs/2026-07-14-message-storage-sqlite-hybrid-*). JSONL is always the
// source of truth. Every write-through call below is BEST-EFFORT: it must
// never throw into the JSONL write path, and any failure is swallowed —
// startup `catalog_reconcile()` is the safety net that repairs drift by
// re-scanning JSONL. Never write user data only to the catalog.

/** Absolute path to the conversations root dir. Set by the writer's first use. */
function conversationsRoot(): string {
  return writer.conversationsRoot();
}

/**
 * Best-effort: bump the catalog's message_count for a conversation by
 * `delta` (positive on append, negative on delete — the Rust side just adds
 * whatever signed delta it's given). Passes the conversations root so Rust
 * can re-read the JSONL's byte/mtime watermark (keeping incremental
 * reconcile from redundantly rescanning). Swallows all errors — the catalog
 * is disposable.
 *
 * Exported for chatStore's `deleteMessagesFrom` — the sole delete primitive
 * as of plan stage 3 — which calls this with a negative delta ONLY when
 * `appendTruncateEvent` reports nothing durable to truncate (a pure
 * in-memory ghost); the durable case runs `catalogReindexConversation`
 * instead, which derives an exact count from the folded ledger rather than
 * an approximate nudge. See that call site for why the fallback nudge is a
 * display-level adjustment, not a JSONL rewrite.
 */
export async function catalogBumpCount(
  convId: string,
  delta: number,
  updatedAt: number,
  lastMessageId: string | null,
): Promise<void> {
  try {
    await invoke('catalog_bump_count', {
      convId,
      delta,
      updatedAt,
      lastMessageId,
      conversationsRoot: conversationsRoot(),
    });
  } catch {
    // Non-fatal: reconcile on next startup repairs the count from JSONL.
  }
}

/**
 * Best-effort: read the catalog's authoritative `message_count` for a
 * conversation. Returns null on any failure (missing row, IPC error, etc.) —
 * callers must treat null as "unknown, fall back to whatever in-memory count
 * they already have." The catalog is a disposable projection, never a hard
 * dependency (see module doc above).
 */
export async function catalogGetCount(convId: string): Promise<number | null> {
  try {
    const row = await invoke<{ message_count: number } | null>('catalog_get_conversation', { convId });
    return row?.message_count ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort: upsert a full catalog row for a conversation. Used on
 * conversation create (and any full metadata sync). Serialized model pin is
 * stored as JSON text so the catalog can surface it without a second lookup.
 */
export async function catalogUpsertConversation(meta: ConversationMeta): Promise<void> {
  try {
    await writer.ensureReady();
    await invoke('catalog_upsert_conversation', {
      row: {
        conv_id: meta.id,
        title: meta.title ?? '',
        created_at: meta.createdAt,
        updated_at: meta.updatedAt,
        message_count: meta.messageCount ?? 0,
        last_message_id: null,
        model: meta.model ? JSON.stringify(meta.model) : null,
        source_bytes: 0,
        source_mtime: null,
        missing: false,
      },
    });
  } catch {
    // Non-fatal: reconcile on next startup repairs the row from JSONL.
  }
}

/** Best-effort: mark a conversation's catalog row missing (soft-delete). */
export async function catalogMarkMissing(convId: string): Promise<void> {
  try {
    await invoke('catalog_mark_missing', { convId });
  } catch {
    // Non-fatal.
  }
}

/**
 * Startup reconcile / migration. Safe to call unconditionally on every launch:
 * first run does a full scan-build of the catalog from every JSONL file;
 * later runs do incremental repair (rescan only changed conversations, mark
 * missing ones). Never modifies JSONL. Fire-and-forget from the caller.
 */
export async function reconcileCatalog(): Promise<void> {
  try {
    await writer.ensureReady();
    await invoke('catalog_reconcile', { conversationsRoot: conversationsRoot() });
  } catch {
    // Non-fatal: the app still works off localStorage conversationIndex in P0.
  }
}

// ════════════════════════════════════════════════════════════
// SQLite FTS5 conversation search — write-through (message-storage P2)
// ════════════════════════════════════════════════════════════
//
// Design doc: docs/2026-07-15-fts5-conversation-search-SPEC.md. `conversation_fts`
// is a rebuildable projection, same invariant as the catalog above. Both
// wrappers below are best-effort: search returns [] on any failure, and the
// reindex write-through swallows errors — the next startup `reconcileCatalog()`
// self-heals from JSONL regardless of whether any given reindex call landed.

/** One conversation search hit. Field names match the Rust `SearchHit`
 * struct's serde output verbatim (snake_case, no rename) — see
 * `catalog_search`'s `SearchHit` in `src-tauri/src/catalog_db.rs`. Command
 * *argument* names go through Tauri's camelCase<->snake_case bridging (as
 * every other catalog invoke call in this file does), but *return* values are
 * plain serde JSON with no such bridging — the same reason
 * `catalogGetCount` above reads `row?.message_count`, not `row?.messageCount`.
 */
export interface SearchHit {
  conv_id: string;
  title: string;
  snippet: string;
  rank: number;
}

/**
 * Best-effort conversation full-text search. Returns `[]` on any failure
 * (IPC error, DB not initialized, etc.) — callers must treat that the same as
 * "no results," never as a hard error. `limit` defaults to 50 on the Rust
 * side when omitted. `search_core` picks the strategy by length: 1-2 char
 * queries use a LIKE substring fallback (the trigram tokenizer can't match
 * anything shorter), 3+ char queries use the ranked FTS5 trigram index.
 */
export async function catalogSearch(query: string, limit?: number): Promise<SearchHit[]> {
  try {
    const hits = await invoke<SearchHit[] | null>('catalog_search', { query, limit });
    // Defensive `?? []`: the Rust command always resolves an array (empty on
    // no match), but callers downstream (sidebar search results) will `.map()`
    // this — never let a null/undefined IPC quirk propagate into that.
    return hits ?? [];
  } catch {
    return [];
  }
}

/**
 * Best-effort: re-index ONE conversation's catalog row + FTS row straight
 * from its JSONL + index.json — the same derivation `catalog_reconcile` uses
 * per-conversation, just scoped to a single `convId`. Called write-through at
 * turn-end and on rename (see chatStore's `setConversationStatus` /
 * `renameConversation`) so a conversation is searchable immediately instead
 * of only after the next startup reconcile. Fire-and-forget from the caller;
 * swallows all errors — reconcile on next launch repairs any missed reindex.
 */
export async function catalogReindexConversation(convId: string): Promise<void> {
  try {
    await writer.ensureReady();
    // Drain the pending message-append write queue FIRST (fix #3).
    // `appendMessage` enqueues each JSONL line onto the 100ms-debounced
    // write queue and returns without waiting for the drain; at turn-end
    // `setConversationStatus` fires this reindex right after the final
    // message is appended, so without draining here the Rust-side
    // `reindex_one_core` can scan a `messages.jsonl` that's still missing
    // the very message this reindex is supposed to index — newest text
    // absent from FTS, `message_count` lagging by one turn.
    // `flushWrites()` is a no-op if nothing is queued (idempotent, already
    // used this way elsewhere — see `shutdownConversationStorage`).
    await writer.flushWrites();
    // Flush the in-memory index to disk NEXT. The Rust side's
    // `read_index_entries` reads `index.json` straight off disk, not TS's
    // in-memory index cache — and index writes are normally debounced up to
    // 2s. Both call sites (rename, turn-end) call `updateIndexEntry()` —
    // which updates the cache synchronously — immediately before this, so
    // without an explicit flush here the Rust-side reindex would very likely
    // read the STALE on-disk title/timestamps, defeating the entire point of
    // a live-freshness reindex. `flushIndex()` is a no-op if there's nothing
    // pending (idempotent, already used this way elsewhere in this module).
    await writer.flushIndex();
    await invoke('catalog_reindex_conversation', {
      convId,
      conversationsRoot: conversationsRoot(),
    });
  } catch {
    // Non-fatal: startup reconcile repairs the catalog/FTS row from JSONL.
  }
}

// ════════════════════════════════════════════════════════════
// Message CRUD
// ════════════════════════════════════════════════════════════

/**
 * Append a message to the conversation JSONL file.
 * Deduplicates by message ID — safe to call multiple times.
 */
export async function appendMessage(convId: string, message: Message): Promise<void> {
  await writer.appendMessage(convId, message);
}

/**
 * Append a `msg.truncate` event: the sole delete primitive as of plan stage 3
 * (`deleteMessageById` and the whole-file rewrite it did are retired). Every
 * remaining removal path — edit-and-resend, retry/regenerate rewind, capability
 * setup cleanup, ghost placeholder cleanup — expresses itself as "cut the log
 * from this message onward," which the fold (messageLedger.ts) already
 * understands.
 *
 * @param fromMessageId The first message to remove; it and everything the
 *   fold has placed after it disappear from the projection.
 * @param opts.pid The id of the last message SURVIVING the truncate (plan
 *   §3.2) — omit when truncating from the conversation's first message.
 * @param opts.removedIds Every id being cut, so their disk-side dedup state
 *   can be released.
 * @returns `false` when nothing durable existed to cut — a purely in-memory
 *   message (never durably appended, and no put still queued either).
 */
export async function appendTruncateEvent(
  convId: string,
  fromMessageId: string,
  opts: { pid?: string; removedIds: string[] },
): Promise<boolean> {
  return writer.appendTruncateEvent(convId, fromMessageId, opts);
}

/**
 * Replace a message in the JSONL file by its id.
 *
 * Since the ledger change this appends a second line carrying the same id
 * rather than rewriting the matching line in place: the fold keeps the last
 * put for an id, at that id's original position, so an append expresses a
 * revision exactly.
 */
export async function replaceMessageById(convId: string, message: Message): Promise<void> {
  await writer.replaceMessageById(convId, message);
}

/**
 * Same serialized replacement as replaceMessageById, but confirms durable
 * success. Interactive workflow state uses this variant because reporting a
 * choice as saved when the row was absent or the write failed would make crash
 * recovery lie to the user.
 */
export async function replaceMessageByIdStrict(convId: string, message: Message): Promise<void> {
  await writer.replaceMessageByIdStrict(convId, message);
}

/**
 * Persist the tail of a conversation when streaming completes or tool results
 * are added, for callers that do not know the message id they are finishing.
 * It appends a put for `message.id` like any other revision.
 */
export async function updateLastMessage(convId: string, message: Message): Promise<void> {
  await writer.updateLastMessage(convId, message);
}

/**
 * Load all messages from a conversation JSONL file.
 * Populates the dedup cache so subsequent writes skip already-persisted messages.
 */
export async function loadMessages(convId: string, options?: { strictRead?: boolean }): Promise<Message[]> {
  return writer.loadMessages(convId, options);
}

/**
 * Delete all files for a conversation (messages, outputs, results).
 * Also cleans up the legacy sessions/ path from pre-migration data.
 */
export async function deleteConversationFiles(convId: string): Promise<void> {
  await writer.deleteConversationFiles(convId);
}

// ════════════════════════════════════════════════════════════
// Conversation meta helpers
// ════════════════════════════════════════════════════════════

/**
 * Build ConversationMeta from a Conversation object.
 */
export function buildMeta(conv: {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: { length: number };
  workspacePath?: string | null;
  model?: { providerId: string; modelId: string };
  permissionMode?: PermissionMode;
  imChannelId?: string;
  imPlatform?: string;
  scheduledTaskId?: string;
  triggerId?: string;
  teamId?: string;
  projectId?: string;
  readOnly?: boolean;
  importedFrom?: { schemaVersion: number; importedAt: number };
}): ConversationMeta {
  const permissionMode = acceptConversationPermissionMode(conv.permissionMode);
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    workspacePath: conv.workspacePath,
    model: conv.model,
    imChannelId: conv.imChannelId,
    imPlatform: conv.imPlatform,
    scheduledTaskId: conv.scheduledTaskId,
    triggerId: conv.triggerId,
    teamId: conv.teamId,
    projectId: conv.projectId,
    readOnly: conv.readOnly,
    importedFrom: conv.importedFrom,
    ...(permissionMode ? { permissionMode } : {}),
  };
}

// ════════════════════════════════════════════════════════════
// Backup
// ════════════════════════════════════════════════════════════

/**
 * Create a daily backup of index.json. Keeps last 7 days.
 * Call once on app startup.
 */
export async function dailyBackup(): Promise<void> {
  await writer.dailyBackup();
}

// ════════════════════════════════════════════════════════════
// Migration helper
// ════════════════════════════════════════════════════════════

/**
 * Migrate a single conversation from in-memory to JSONL.
 * Used during v3→v4 migration.
 */
export async function migrateConversation(conv: {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  workspacePath?: string | null;
  imChannelId?: string;
  imPlatform?: string;
  scheduledTaskId?: string;
  triggerId?: string;
  projectId?: string;
}): Promise<void> {
  // Write messages
  for (const msg of conv.messages) {
    await appendMessage(conv.id, msg);
  }
  await flushWrites();

  // Update index
  await updateIndexEntry(buildMeta(conv));
  await flushIndex();
}

// ════════════════════════════════════════════════════════════
// Lifecycle
// ════════════════════════════════════════════════════════════

/**
 * Initialize the storage engine. Call once on app startup.
 * - Ensures base directory exists
 * - Loads index into memory
 * - Runs daily backup
 */
export async function initConversationStorage(): Promise<void> {
  await writer.init();
}

/**
 * Shutdown the storage engine. Call before app exit.
 * Flushes all pending writes.
 */
export async function shutdownConversationStorage(): Promise<void> {
  await writer.shutdown();
}
