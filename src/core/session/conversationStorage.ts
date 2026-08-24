/**
 * Conversation Storage — JSONL-based file system persistence.
 *
 * Replaces Zustand localStorage persistence for conversation messages.
 * Messages are stored as line-delimited JSON (one JSON object per line)
 * with append-only writes for crash safety.
 *
 * Architecture:
 *   conversations/
 *   ├── index.json              (lightweight metadata index)
 *   ├── .snapshot-sweep-version (marker: app version that last swept stale
 *   │                            stream-snapshot.json files, see part B below)
 *   ├── {convId}/
 *   │   ├── messages.jsonl      (append-only ledger of message events)
 *   │   ├── stream-snapshot.json (in-flight revisions, overwritten in place;
 *   │   │                        file-level `ledgerBytes` watermark, part A,
 *   │   │                        PLUS a per-entry `stamp` — the ledger byte
 *   │   │                        offset at capture time, RB-03 fix — so a
 *   │   │                        stale crash-leftover entry can be told apart
 *   │   │                        from one the ledger hasn't touched)
 *   │   ├── outputs/            (images, generated files)
 *   │   └── results/            (large tool results >8KB)
 *   └── ...
 *
 * Write strategy:
 *   - messages.jsonl is a fully append-only ledger (plan stage 3): a revision
 *     is a second line carrying the same id, and removal is a `msg.truncate`
 *     event line (messageLedger.ts) rather than a rewrite. `foldMessageLog`
 *     keeps the last put per id and applies truncate/tomb events strictly in
 *     the order they were written. Nothing rewrites an existing line anymore
 *     except `appendToFile`'s fallback (read+rewrite only when the native
 *     O(1) append command itself is unavailable).
 *   - WriteQueue batches writes per file (100ms debounce) and collapses queued
 *     revisions of the same message into one line; event rows (truncates)
 *     are order-sensitive and never merge across a put
 *   - UUID-based dedup prevents duplicate writes on restart
 *   - Streaming tokens stay in memory; only complete messages hit disk
 *   - The 5s crash-protection flush and per-tool-result writes go to
 *     stream-snapshot.json, NOT the ledger — see the stream snapshot section
 *     for why that budget matters
 */

import { exists, readTextFile, mkdir, remove, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { atomicWrite } from '@/utils/atomicFs';
import { foldMessageLog, createLedgerEvent, LEDGER_KIND_PUT, type LedgerLine } from './messageLedger';
import { findToolResultImageSnapshot, refreshOutputManifest } from './outputSnapshots';
import type { Message, MessageContent, SandboxRecoveryAction, ToolCall, ToolCallForContext, ToolResultContent } from '@/types';
import { APP_VERSION } from '@/utils/version';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  workspacePath?: string | null;
  model?: { providerId: string; modelId: string };  // Model pinned to this conversation (undefined = inherit global)
  imChannelId?: string;
  imPlatform?: string;
  scheduledTaskId?: string;
  triggerId?: string;
  projectId?: string;
  totalCost?: number;
  /** Imported share bundle — conversation is read-only. See Conversation.readOnly. */
  readOnly?: boolean;
  importedFrom?: {
    schemaVersion: number;
    importedAt: number;
  };
}

interface ConversationIndex {
  version: 1;
  entries: Record<string, ConversationMeta>;
}

// ════════════════════════════════════════════════════════════
// Path helpers
// ════════════════════════════════════════════════════════════

let basePath: string | null = null;

async function ensureBase(): Promise<string> {
  if (!basePath) {
    const appData = await appDataDir();
    basePath = joinPath(appData, 'conversations');
    if (!(await exists(basePath))) {
      await mkdir(basePath, { recursive: true });
    }
    await sweepStaleStreamSnapshotsOnVersionChange();
  }
  return basePath;
}

function convDir(convId: string): string {
  return joinPath(basePath!, convId);
}

function messagesPath(convId: string): string {
  return joinPath(basePath!, convId, 'messages.jsonl');
}

function indexFilePath(): string {
  return joinPath(basePath!, 'index.json');
}

// ════════════════════════════════════════════════════════════
// Per-file mutex — serializes read-modify-write against same path
// ════════════════════════════════════════════════════════════
//
// One call site still does non-atomic read-modify-write on messages.jsonl:
//   - appendToFile's fallback (from drain, when the native append is missing)
//
// replaceMessageById, updateLastMessage, and (plan stage 3) appendTruncateEvent
// are pure appends, which is why none of them take this lock — the class of
// bug described below is structurally gone for them rather than held back by
// a mutex. `deleteMessageById`, the last whole-file rewrite on a delete, was
// retired once `msg.truncate` events made every removal an append too.
//
// Without serialization two of these concurrent on the same file can
// interleave — one reads a stale snapshot and later overwrites changes
// the other just committed. Worse, if a writeTextFile's buffer crosses
// the OS write-syscall boundary, two concurrent writes can literally
// splice bytes mid-serialization, producing broken JSONL lines that
// loadMessages has to skip. Observed rate: ~12% of lines in heavy
// tool-call conversations (see Task follow-up to #15 in commit log).
//
// The fix is a FIFO promise chain per file path — every caller awaits
// the previous queued op before starting its own, so all ops on the
// same file run strictly sequentially. Different files run in parallel
// (each has its own chain), so throughput is preserved.

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize a file-mutating operation on `filePath`. Concurrent callers on
 * the same path form a FIFO queue; different paths run in parallel.
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileLocks.set(filePath, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Avoid unbounded map growth: if no newer waiter has queued behind us
    // (the map still points at this entry), drop it.
    if (fileLocks.get(filePath) === next) {
      fileLocks.delete(filePath);
    }
  }
}

// ════════════════════════════════════════════════════════════
// Write Queue — batches writes per file, 100ms debounce
// ════════════════════════════════════════════════════════════

interface PendingWrite {
  line: string;
  /**
   * The message id this line writes, when the line is a `msg.put` that a newer
   * revision of the same message is allowed to overwrite before it ever
   * reaches disk. Undefined marks an order-sensitive line (an event row, a raw
   * append) that must keep its position in the queue.
   */
  mergeKey?: string;
  settlers: { resolve: () => void; reject: (err: unknown) => void }[];
}

const writeQueues = new Map<string, PendingWrite[]>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
const DRAIN_INTERVAL_MS = 100;

/**
 * Find a queued put for `mergeKey` that can absorb a newer revision of the
 * same message.
 *
 * Scans backwards and gives up at the first order-sensitive line, because
 * folding an event (a tombstone, say) depends on where it sits relative to the
 * puts around it — collapsing a put across one would change the fold's result.
 * Merging across puts of OTHER ids is safe: a merge keeps the message at the
 * position it already claimed, and only a first put decides a position.
 */
function findMergeTarget(queue: PendingWrite[], mergeKey: string): number {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].mergeKey === mergeKey) return i;
    if (queue[i].mergeKey === undefined) return -1;
  }
  return -1;
}

/** Whether a put for `messageId` is queued for `filePath` but not yet on disk. */
function hasPendingPut(filePath: string, messageId: string): boolean {
  const queue = writeQueues.get(filePath);
  return queue ? findMergeTarget(queue, messageId) !== -1 : false;
}

/**
 * Queue one line for `filePath`.
 *
 * With a `mergeKey`, a still-queued put for the same message is overwritten in
 * place (last write wins) instead of a second line being queued. This is the
 * first half of the write-amplification budget: once a replacement is an
 * append, an unmerged queue would turn every in-flight burst of revisions
 * (tool results landing one after another) into one physical line each.
 */
function enqueueWrite(filePath: string, line: string, mergeKey?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const queue = writeQueues.get(filePath) ?? [];
    const mergeAt = mergeKey === undefined ? -1 : findMergeTarget(queue, mergeKey);
    if (mergeAt !== -1) {
      queue[mergeAt].line = line;
      queue[mergeAt].settlers.push({ resolve, reject });
    } else {
      queue.push({ line, mergeKey, settlers: [{ resolve, reject }] });
    }
    writeQueues.set(filePath, queue);
    scheduleDrain();
  });
}

function scheduleDrain(): void {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainAll();
  }, DRAIN_INTERVAL_MS);
}

/**
 * Put ids dequeued by a drain whose appendToFile has not settled yet, keyed
 * `${filePath}\n${mergeKey}`. In that window a put is in neither writeQueues
 * (hasPendingPut → false) nor writtenIds (added only after the caller's
 * enqueue promise resolves) — appendTruncateEvent's skip-guard must still
 * count it as "something durable to cut", or a truncate racing the turn-end
 * checkpoint's drain silently skips its event and the cut turn resurrects on
 * the next load (review finding #1).
 */
const inFlightPutKeys = new Set<string>();

function hasInFlightPut(filePath: string, messageId: string): boolean {
  return inFlightPutKeys.has(`${filePath}\n${messageId}`);
}

async function drainAll(): Promise<void> {
  const entries = [...writeQueues.entries()];
  writeQueues.clear();

  await Promise.allSettled(
    entries.map(async ([filePath, pending]) => {
      const data = pending.map((p) => p.line).join('');
      const flightKeys = pending
        .filter((p) => p.mergeKey !== undefined)
        .map((p) => `${filePath}\n${p.mergeKey}`);
      flightKeys.forEach((k) => inFlightPutKeys.add(k));
      try {
        await appendToFile(filePath, data);
        // Ledger byte watermark (RB-03 fix, plan §3.6 addendum): the append
        // that just landed durably grew messages.jsonl by exactly
        // `data.length` bytes (repairTornTail's rare leading-newline byte is
        // a bounded, accepted exception — see its doc comment — immaterial to
        // the >= / strictly-less-than comparisons this watermark feeds in
        // loadMessages, both the file-level shrink guard and the per-entry
        // supersede pass). Advance before claiming ids below so a snapshot
        // written moments later already reflects this append's offset.
        const watermarkConvId = convIdFromMessagesFilePath(filePath);
        if (watermarkConvId) advanceLedgerBytes(watermarkConvId, data.length);
        // Claim the ids HERE, synchronously with the drain settling — not in
        // the callers' microtask continuations — so there is no instant where
        // a durably-landed put is in neither writtenIds nor the in-flight set
        // (appendMessage's own later add is then redundant but harmless).
        pending.forEach((p) => {
          if (p.mergeKey !== undefined) writtenIds.add(p.mergeKey);
        });
        pending.forEach((p) => p.settlers.forEach((s) => s.resolve()));
      } catch (err) {
        pending.forEach((p) => p.settlers.forEach((s) => s.reject(err)));
      } finally {
        flightKeys.forEach((k) => inFlightPutKeys.delete(k));
      }
    }),
  );
}

/**
 * Paths whose on-disk tail this process has already confirmed to be newline
 * terminated. See `repairTornTail`.
 */
const tailCheckedPaths = new Set<string>();

/**
 * Prefix `data` with the newline a crashed append never got to write.
 *
 * Native append is not atomic (see `appendToFile` below), so a crash mid-write
 * can leave the file ending in a partial line. That was self-healing while
 * `replaceMessageById` rewrote the whole file — `lines.join('\n') + '\n'`
 * re-terminated the stump within seconds. In an append-only ledger nothing
 * ever rewrites, so the stump is permanent and the NEXT appended line gets
 * glued onto it: one corrupt line, two messages lost instead of one.
 *
 * Checking costs one read of the file, once per path per process, on the first
 * append only — `loadMessages` hands its own read to `noteTailFromRead` so the
 * common path does not pay even that.
 */
async function repairTornTail(filePath: string, data: string): Promise<string> {
  if (tailCheckedPaths.has(filePath)) return data;
  try {
    if (!(await exists(filePath))) {
      tailCheckedPaths.add(filePath);
      return data;
    }
    const raw = await readTextFile(filePath);
    tailCheckedPaths.add(filePath);
    if (raw.length === 0 || raw.endsWith('\n')) return data;
    return `\n${data}`;
  } catch {
    // Unreadable: leave the flag unset so a later append tries again.
    return data;
  }
}

/** Record a tail already observed by a reader, so no append has to re-read it. */
function noteTailFromRead(filePath: string, raw: string): void {
  if (raw.length === 0 || raw.endsWith('\n')) tailCheckedPaths.add(filePath);
  else tailCheckedPaths.delete(filePath);
}

/**
 * Append data to a file. Creates parent directory on first write.
 *
 * Part B1: tries the native `append_file_text` Rust command first — it opens
 * the file in OS append mode and writes only `data`, no read of existing
 * content, so cost is O(len(data)) instead of O(file size). If that command
 * is unavailable (older bundled binary mid-upgrade, unexpected Rust-side
 * failure) or throws for any other reason, we fall back to the previous
 * read + atomic-write path below, which is O(file size) but was already
 * battle-tested.
 *
 * Atomicity trade-off: the fallback's atomic writes (tempfile + fsync +
 * rename) guarantee a reader never observes a half-written file. Native
 * append does NOT have that guarantee — a crash mid-`write_all` can leave a
 * half-written last line. This is an accepted trade-off (see
 * `src-tauri/src/append_file.rs` doc comment): `loadMessages` below already
 * tolerates and skips corrupt JSONL lines, so the worst case of a crash
 * during native append is losing the one message that was mid-flight, never
 * the messages already durably on disk before the call started.
 *
 * Serialized against concurrent mutations on the same path via `withFileLock`.
 */
async function appendToFile(filePath: string, rawData: string): Promise<void> {
  return withFileLock(filePath, async () => {
    const data = await repairTornTail(filePath, rawData);
    try {
      // Native O(1) append (Part B1). Falls back to read+atomic-rewrite below
      // if the command is unavailable or fails.
      await invoke('append_file_text', { path: filePath, data });
      return;
    } catch {
      // Fall through to the read + atomic-write path. NOTE: this fallback is not
      // idempotent — if the native append durably wrote `data` but its promise
      // still rejected (IPC teardown / shutdown race), we re-append the same
      // line here, producing a DUPLICATE (not a corrupt line). loadMessages
      // dedups by id on read, so the duplicate never surfaces.
    }
    try {
      if (await exists(filePath)) {
        const current = await readTextFile(filePath);
        await atomicWrite(filePath, current + data);
      } else {
        // atomicWrite creates parent dirs as needed — no pre-mkdir required.
        await atomicWrite(filePath, data);
      }
    } catch {
      // Retry: ensure directory exists, then re-read existing content to preserve it.
      // Previous implementation wrote only `data` here, which would overwrite the
      // entire file and destroy all existing messages — a catastrophic data loss bug.
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (dir) await mkdir(dir, { recursive: true });
      let existing = '';
      try {
        if (await exists(filePath)) {
          existing = await readTextFile(filePath);
        }
      } catch {
        // If we still can't read, at least don't destroy what's there — let it throw
      }
      await atomicWrite(filePath, existing + data);
    }
  });
}

/**
 * Force-flush all pending writes. Call before app exit or crash recovery.
 */
export async function flushWrites(): Promise<void> {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  await drainAll();
}

// ════════════════════════════════════════════════════════════
// UUID dedup — prevents double-writing on restart/replay
// ════════════════════════════════════════════════════════════

const writtenIds = new Set<string>();
const writingIds = new Map<string, Promise<void>>();

/**
 * Clear the dedup cache. Call when loading messages from disk
 * to populate the set with already-persisted message IDs.
 */
function populateWrittenIds(convId: string, messages: Message[]): void {
  for (const msg of messages) {
    writtenIds.add(msg.id);
    rememberPersistedMessage(msg);
    const pid = (msg as LedgerLine).pid;
    if (typeof pid === 'string') parentIdByMessage.set(msg.id, pid);
  }
  const tail = messages[messages.length - 1];
  if (tail) lastMessageIdByConv.set(convId, tail.id);
}

// ════════════════════════════════════════════════════════════
// Ledger bookkeeping — what a revision needs that the file no longer tells us
// ════════════════════════════════════════════════════════════
//
// A replacement used to read the persisted row back before rewriting it. An
// append cannot: there is nothing to read without re-reading the whole file,
// which is exactly the O(file size) cost this change exists to remove. The two
// facts that read used to supply are tracked here instead.

/**
 * Per message, the sandbox recovery action already durable for each of its
 * tool calls. Deliberately NOT the whole persisted message — this is the only
 * field a revision must not silently regress (see
 * `preservePersistedSandboxRecoveryActions`), and keeping just it costs a
 * couple of short strings per tool call instead of a second copy of history.
 */
const persistedSandboxActions = new Map<string, Map<string, SandboxRecoveryAction>>();

/**
 * `pid` per message: the ledger tail at the moment the message was FIRST
 * written. A revision must reuse it rather than re-parent itself to whatever
 * is at the tail now (plan §3.2) — otherwise a 5 s streaming revision would
 * rewrite the chain into nonsense.
 */
const parentIdByMessage = new Map<string, string>();

/** Per conversation, the id of the last message in the folded log. */
const lastMessageIdByConv = new Map<string, string>();

/**
 * Per conversation, the byte length of `messages.jsonl` this process last
 * confirmed durable — either by reading it (`loadMessages`) or by appending
 * to it (`drainAll`). This is the ledger byte watermark (RB-03 fix, plan §3.6
 * addendum), and it feeds TWO independent guards in `loadMessages`:
 *
 *  - File-level shrink guard (plan §3.6 addendum): an append-only ledger's
 *    length can only grow, so a load that finds the file SHORTER than a
 *    stream snapshot's recorded file-level `ledgerBytes` watermark means some
 *    other process rewrote `messages.jsonl` in place between that snapshot's
 *    write and this load — the classic case being a downgrade to a
 *    pre-ledger build (which knows nothing of snapshots or `persistRev` and
 *    rewrites the whole file) followed by a re-upgrade. The whole snapshot is
 *    discarded when this fires.
 *  - Per-entry supersede pass (RB-03 fix): stamping a stream-snapshot entry
 *    with this value at capture time (see `snapshotMessageRevision`) gives
 *    `loadMessages` a byte offset it can compare against the ledger's later
 *    state for that one id — a "has anything durable happened to this id
 *    since the snapshot was taken" check — instead of blindly folding every
 *    surviving snapshot entry in as a trailing put regardless of how stale it
 *    is.
 */
const ledgerBytesByConv = new Map<string, number>();

/**
 * Extract the conversation id from a `messages.jsonl` path built by
 * `messagesPath`. Every `enqueueWrite` call in this module targets that path
 * (never `index.json` or the stream snapshot file, which use their own write
 * paths), so a drained write can always be attributed back to its
 * conversation for the byte watermark above without threading `convId`
 * through the write-queue machinery itself.
 */
function convIdFromMessagesFilePath(filePath: string): string | undefined {
  const parts = filePath.split('/');
  if (parts.length < 2 || parts[parts.length - 1] !== 'messages.jsonl') return undefined;
  return parts[parts.length - 2];
}

function advanceLedgerBytes(convId: string, delta: number): void {
  ledgerBytesByConv.set(convId, (ledgerBytesByConv.get(convId) ?? 0) + delta);
}

function rememberPersistedMessage(message: Message): void {
  if (!message.toolCalls?.length) return;
  const actions = new Map<string, SandboxRecoveryAction>();
  for (const toolCall of message.toolCalls) {
    if (toolCall.sandboxRecoveryAction != null) {
      actions.set(toolCall.id, toolCall.sandboxRecoveryAction);
    }
  }
  if (actions.size > 0) persistedSandboxActions.set(message.id, actions);
  else persistedSandboxActions.delete(message.id);
}

/**
 * Serialize one `msg.put` line.
 *
 * `lk` is left off: an absent kind IS `msg.put` (plan §3.1), so omitting it
 * keeps revision lines byte-identical in shape to the bare `Message` rows
 * every previous version wrote — nothing about a revised log looks new to an
 * older build. `pid` is written but never read (plan §3.2).
 */
async function refreshOutputManifestForToolResultImages(convId: string): Promise<boolean> {
  try {
    await refreshOutputManifest(convId);
    return true;
  } catch {
    // Temporal guard: if the cross-process manifest refresh fails, keep
    // inline bytes for this write rather than risking a dangling outputRef.
    return false;
  }
}

function serializeLedgerPut(
  convId: string,
  message: Message,
  pid: string | undefined,
  allowToolResultDehydration = true,
): string {
  const line = stripForDisk(message, convId, { allowToolResultDehydration }) as LedgerLine;
  if (pid === undefined) delete line.pid;
  else line.pid = pid;
  return JSON.stringify(line) + '\n';
}

// ════════════════════════════════════════════════════════════
// Stream snapshot — the hot revisions that must NOT enter the ledger
// ════════════════════════════════════════════════════════════
//
// Plan §3.6. Once a replacement is an append, the two highest-frequency
// writers stop being idempotent overwrites and start being physical lines:
// the 5 s crash-protection flush during streaming, and the per-tool-result
// write of the enclosing message. A ten-minute turn with N tool calls would
// append the whole (growing) message on the order of N + 120 times.
//
// So those writers go to `stream-snapshot.json` instead — one atomic
// whole-file overwrite per revision, no growth, and `loadMessages` folds it on
// top of the ledger so crash recovery still sees the newest state. The ledger
// only collects a revision at a stable checkpoint (tool batch done, turn end,
// stop), which is what keeps revision lines per turn in the single digits.

const STREAM_SNAPSHOT_FILENAME = 'stream-snapshot.json';

/**
 * One buffered revision plus the ledger byte watermark (RB-03 fix) it was
 * captured against. `stamp` is `undefined` for an entry read back from a
 * legacy (pre-fix) on-disk file — see `readStreamSnapshot` — which must keep
 * the old unconditional-merge behavior rather than being misread as "stamp
 * zero" (that would make every legacy entry look supersede-able by literally
 * any ledger content).
 */
interface StreamSnapshotEntry {
  message: Message;
  stamp?: number;
}

interface StreamSnapshotFile {
  version: 1 | 2;
  /** v1 (legacy on-disk shape, still parsed for back-compat): flat array, no per-entry stamp. */
  messages?: Message[];
  /** v2 (current writer shape): per-entry ledger byte watermark on each entry. */
  entries?: StreamSnapshotEntry[];
  /**
   * File-level ledger byte watermark (plan §3.6 addendum): the length of
   * `messages.jsonl` this process had last confirmed durable at the moment
   * this snapshot was written. `loadMessages` compares this against the
   * freshly-read ledger's actual length to detect a shrink — see
   * `ledgerBytesByConv`'s doc comment. Present on both the v1 shape (an
   * already-shipped build wrote it before the per-entry `stamp` addendum
   * existed) and the current v2 shape; absent only on the oldest snapshots
   * written before either addendum, which are merged unconditionally.
   */
  ledgerBytes?: number;
}

/** convId → messageId → newest revision not yet checkpointed into the ledger. */
const streamSnapshots = new Map<string, Map<string, StreamSnapshotEntry>>();

function streamSnapshotPath(convId: string): string {
  return joinPath(basePath!, convId, STREAM_SNAPSHOT_FILENAME);
}

async function writeStreamSnapshot(
  convId: string,
  entries: Map<string, StreamSnapshotEntry>,
): Promise<void> {
  const path = streamSnapshotPath(convId);
  try {
    if (entries.size === 0) {
      if (await exists(path)) await remove(path);
      return;
    }
    const payload: StreamSnapshotFile = {
      version: 2,
      entries: [...entries.values()],
      // Best current knowledge of the ledger's durable length (0 for a
      // conversation this process has neither loaded nor appended to yet —
      // accurate, since there is then nothing on disk to shrink below). Kept
      // alongside the per-entry `stamp`s so the file-level shrink guard
      // (plan §3.6 addendum) and the per-entry supersede pass (RB-03 fix)
      // can both run off the same on-disk payload.
      ledgerBytes: ledgerBytesByConv.get(convId) ?? 0,
    };
    await atomicWrite(path, JSON.stringify(payload));
  } catch {
    // Best-effort crash protection. The ledger checkpoint is the durable write;
    // losing a snapshot only costs the in-flight revision.
  }
}

/**
 * Record an in-flight revision without touching the ledger.
 *
 * Use this for anything that fires on a timer or per tool result while a turn
 * is still running. Use `replaceMessageById` at the checkpoints where the
 * state is worth a permanent line.
 */
export async function snapshotMessageRevision(convId: string, message: Message): Promise<void> {
  await ensureBase();
  const allowToolResultDehydration = hasInlineToolResultImages(message)
    ? await refreshOutputManifestForToolResultImages(convId)
    : true;
  const entries = streamSnapshots.get(convId) ?? new Map<string, StreamSnapshotEntry>();
  entries.set(message.id, {
    message: stripForDisk(message, convId, { allowToolResultDehydration }),
    // RB-03 fix: how much of this conversation's ledger this process had
    // confirmed durable at the moment this revision was captured. See
    // `ledgerBytesByConv`'s doc comment and `loadMessages`' snapshot-merge
    // step, which is what this stamp exists for.
    stamp: ledgerBytesByConv.get(convId) ?? 0,
  });
  streamSnapshots.set(convId, entries);
  await writeStreamSnapshot(convId, entries);
}

/**
 * Forget the snapshot entry for a message the ledger has now recorded (or that
 * has been deleted). Cheap no-op when there is nothing buffered for that id,
 * which is the common case.
 */
async function dropStreamSnapshotEntry(convId: string, messageId: string): Promise<void> {
  const entries = streamSnapshots.get(convId);
  if (!entries?.delete(messageId)) return;
  if (entries.size === 0) streamSnapshots.delete(convId);
  await writeStreamSnapshot(convId, entries);
}

interface StreamSnapshotReadResult {
  /** Per-entry map, each carrying its own RB-03 `stamp` (undefined for a legacy entry). */
  entries: Map<string, StreamSnapshotEntry>;
  /**
   * The snapshot's recorded FILE-LEVEL ledger byte watermark (plan §3.6
   * addendum), or `undefined` for a snapshot written before that field
   * existed — callers must treat `undefined` as "no watermark available" and
   * keep the pre-existing unconditional-merge behavior for entries that are
   * themselves also unstamped.
   */
  ledgerBytes?: number;
}

/**
 * Read the snapshot file back, WITHOUT re-arming the in-memory buffer — the
 * caller (`loadMessages`) must run the stale-entry guards first (the
 * file-level shrink check, then the RB-03 per-entry supersede pass) and only
 * then decide what actually gets armed, or a superseded entry would be
 * written straight back into memory before it's ever filtered.
 */
async function readStreamSnapshot(convId: string): Promise<StreamSnapshotReadResult> {
  const path = streamSnapshotPath(convId);
  try {
    if (!(await exists(path))) return { entries: new Map() };
    const parsed = JSON.parse(await readTextFile(path)) as StreamSnapshotFile;
    const ledgerBytes = typeof parsed?.ledgerBytes === 'number' ? parsed.ledgerBytes : undefined;
    const entries = new Map<string, StreamSnapshotEntry>();
    if (Array.isArray(parsed?.entries)) {
      // v2 (current) shape: per-entry watermark.
      for (const entry of parsed.entries) {
        const message = entry?.message;
        if (message && typeof message.id === 'string') {
          entries.set(message.id, {
            message,
            stamp: typeof entry.stamp === 'number' ? entry.stamp : undefined,
          });
        }
      }
    } else if (Array.isArray(parsed?.messages)) {
      // v1 (legacy) shape: no per-entry watermark, though it may still carry
      // the file-level `ledgerBytes` field (an already-shipped build wrote it
      // before the per-entry `stamp` addendum existed).
      for (const message of parsed.messages) {
        if (message && typeof message.id === 'string') {
          entries.set(message.id, { message, stamp: undefined });
        }
      }
    }
    return { entries, ledgerBytes };
  } catch {
    // A damaged snapshot must never take the conversation down with it — the
    // ledger alone is still a complete, if slightly older, history.
    return { entries: new Map() };
  }
}

/**
 * Discard a stream snapshot outright — drop the in-memory buffer and delete
 * the file — rather than merging it. Used by `loadMessages` when the ledger
 * byte watermark check (plan §3.6 addendum) finds the ledger SHORTER than the
 * snapshot's recorded watermark: append-only ledgers never shrink on their
 * own, so a shrink means a foreign or older build rewrote `messages.jsonl` in
 * place since this snapshot was taken, and the snapshot's revisions are
 * relative to a ledger tail that no longer exists. Best-effort delete — if it
 * fails, the same (still-stale) snapshot is simply re-evaluated (and again
 * discarded) on the next load.
 */
async function discardStreamSnapshot(convId: string): Promise<void> {
  streamSnapshots.delete(convId);
  const path = streamSnapshotPath(convId);
  try {
    if (await exists(path)) await remove(path);
  } catch {
    // Best-effort — see doc comment above.
  }
}

/** Marker file (inside `basePath`) recording the app version that last swept stream snapshots. */
const SNAPSHOT_SWEEP_MARKER_FILENAME = '.snapshot-sweep-version';

/**
 * One-shot, version-gated sweep: on the first `ensureBase()` call of a
 * process whose `APP_VERSION` does not match the version recorded in
 * `conversations/.snapshot-sweep-version`, delete every conversation's
 * `stream-snapshot.json`, then rewrite the marker to the current version.
 * Plan §3.6 addendum, part B.
 *
 * Why this exists alongside the ledger byte watermark (part A, above, which
 * covers both the file-level `ledgerBytes` shrink guard and the RB-03
 * per-entry `stamp` supersede pass): those checks only protect a snapshot
 * whose entries actually carry a watermark. That covers the
 * downgrade-then-reupgrade case precisely because a pre-ledger build knows
 * nothing about `stream-snapshot.json` and never touches it — it only
 * rewrites `messages.jsonl`, which is exactly what the file-level watermark
 * detects. This sweep is a coarser, independent second guard: it guarantees
 * no snapshot ever survives an app-version change at all, regardless of
 * whether it happens to carry a watermark, so a legacy snapshot from before
 * either field existed (merged unconditionally by `loadMessages`) cannot
 * outlive the version that wrote it either.
 *
 * Follows the one-shot marker-gated sweep precedent in
 * `src/core/memdir/secretSweep.ts`: a marker file gates repeat work down to
 * a single `exists()` check, and the whole function is best-effort — it must
 * never throw out of `ensureBase`'s init path. A failed sweep (unreadable
 * marker, unreadable base dir, a locked snapshot file) just leaves stale
 * snapshots in place for one more version; the next mismatched-marker launch
 * retries the same directories.
 */
async function sweepStaleStreamSnapshotsOnVersionChange(): Promise<void> {
  try {
    const markerPath = joinPath(basePath!, SNAPSHOT_SWEEP_MARKER_FILENAME);
    let markerVersion: string | null = null;
    if (await exists(markerPath)) {
      try {
        markerVersion = (await readTextFile(markerPath)).trim();
      } catch (err) {
        console.warn('[conversationStorage] snapshot sweep: failed to read marker:', err);
      }
    }
    if (markerVersion === APP_VERSION) return; // already swept for this version

    const entries = await readDir(basePath!);
    for (const entry of entries) {
      if (!entry.isDirectory) continue; // skip index.json, the marker itself, backups is outside basePath
      const snapshotPath = joinPath(basePath!, entry.name, STREAM_SNAPSHOT_FILENAME);
      try {
        if (await exists(snapshotPath)) await remove(snapshotPath);
      } catch (err) {
        console.warn(
          `[conversationStorage] snapshot sweep: failed to remove stale snapshot for "${entry.name}":`,
          err,
        );
      }
    }
    // Any in-memory buffer is for a snapshot file this pass just deleted (or
    // never wrote in this fresh process) — drop it so a later
    // `writeStreamSnapshot` doesn't resurrect a file this sweep just cleared.
    streamSnapshots.clear();

    await atomicWrite(markerPath, APP_VERSION);
  } catch (err) {
    // Must never block or throw out of ensureBase's init path — see doc
    // comment above.
    console.warn('[conversationStorage] snapshot sweep failed:', err);
  }
}

/**
 * Companion pass to `messageLedger.ts`'s `foldMessageLog`: walks the same raw
 * ledger lines in the same order and applies the same put/tomb/truncate/
 * loopDrop state transitions, but tracks each line's BYTE OFFSET into `raw`
 * instead of building `Message` objects. Deliberately NOT merged into
 * `foldMessageLog` itself — that function is pinned byte-for-byte to
 * `electron/messageLedgerFold.cjs` and `src-tauri/src/catalog_db.rs` via a
 * shared fixture file (see `messageLedger.ts`'s module doc), and byte offsets
 * are a TypeScript-only concern for the stream-snapshot supersede guard below
 * with no equivalent on the other two ports.
 *
 * Must mirror `foldMessageLog`'s survivorship decisions exactly (same
 * id-collapsing on `undefined`, same in-place-not-move-to-end put semantics,
 * same corrupt/non-object line skipping) — see `loadMessages`' snapshot-merge
 * step for why a divergence here would silently mis-classify a snapshot
 * entry as stale or as still-valid.
 */
interface LedgerOffsetInfo {
  /** id → offset of the put line that currently establishes its presence
   * (the LAST put for that id, since a revision lands in place — only set
   * for ids the ledger-only fold still contains). */
  putOffsetById: Map<string, number>;
  /** id → offset of the removal event (tomb/truncate/loopDrop) that most
   * recently removed the id, for ids the ledger-only fold does NOT currently
   * contain. A later revival put clears this entry, mirroring the fold's own
   * put-after-tomb resurrection rule (messageLedger.ts module doc). */
  removedOffsetById: Map<string, number>;
}

function computeLedgerOffsetInfo(raw: string): LedgerOffsetInfo {
  const putOffsetById = new Map<string, number>();
  const removedOffsetById = new Map<string, number>();
  let liveIds: string[] = [];
  let liveLoopIds: (string | undefined)[] = [];
  let indexOf = new Map<string, number>();

  const reindex = (): void => {
    indexOf = new Map<string, number>();
    for (let i = 0; i < liveIds.length; i++) indexOf.set(liveIds[i], i);
  };

  let offset = 0;
  for (const rawLine of raw.split('\n')) {
    // `String.prototype.split('\n')` eats exactly one '\n' between segments,
    // so re-adding it per segment reconstructs each segment's true starting
    // offset in `raw` — see this function's tests for the boundary check.
    const consumed = rawLine.length + 1;
    const lineOffset = offset;
    offset += consumed;

    if (rawLine.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const line = parsed as LedgerLine;
    const kind: string = typeof line.lk === 'string' ? line.lk : LEDGER_KIND_PUT;

    switch (kind) {
      case LEDGER_KIND_PUT: {
        if (typeof line.id !== 'string') break;
        const id = line.id;
        const at = indexOf.get(id);
        if (at === undefined) {
          indexOf.set(id, liveIds.length);
          liveIds.push(id);
          liveLoopIds.push(line.loopId);
        } else {
          liveLoopIds[at] = line.loopId; // in place — a revision, not a reorder
        }
        putOffsetById.set(id, lineOffset);
        removedOffsetById.delete(id); // put-after-removal revives it
        break;
      }
      case 'msg.tomb': {
        if (typeof line.target !== 'string') break;
        const at = indexOf.get(line.target);
        if (at === undefined) break;
        liveIds.splice(at, 1);
        liveLoopIds.splice(at, 1);
        reindex();
        putOffsetById.delete(line.target);
        removedOffsetById.set(line.target, lineOffset);
        break;
      }
      case 'msg.truncate': {
        if (typeof line.from !== 'string') break;
        const at = indexOf.get(line.from);
        if (at === undefined) break;
        const cut = liveIds.slice(at);
        liveIds.length = at;
        liveLoopIds.length = at;
        reindex();
        for (const cutId of cut) {
          putOffsetById.delete(cutId);
          removedOffsetById.set(cutId, lineOffset);
        }
        break;
      }
      case 'msg.loopDrop': {
        if (typeof line.loopId !== 'string') break;
        const dropLoopId = line.loopId;
        const keepIds: string[] = [];
        const keepLoopIds: (string | undefined)[] = [];
        const droppedIds: string[] = [];
        for (let i = 0; i < liveIds.length; i++) {
          if (liveLoopIds[i] === dropLoopId) droppedIds.push(liveIds[i]);
          else {
            keepIds.push(liveIds[i]);
            keepLoopIds.push(liveLoopIds[i]);
          }
        }
        if (droppedIds.length === 0) break;
        liveIds = keepIds;
        liveLoopIds = keepLoopIds;
        reindex();
        for (const droppedId of droppedIds) {
          putOffsetById.delete(droppedId);
          removedOffsetById.set(droppedId, lineOffset);
        }
        break;
      }
      default:
        // Unknown kind — written by a newer build. Ignored, same as the fold.
        break;
    }
  }

  return { putOffsetById, removedOffsetById };
}

/**
 * RB-03 fix: drop any stream-snapshot entry the ledger has already made
 * stale, instead of always folding every buffered revision in as a trailing
 * put. An entry is stale when, at or after the byte offset it was stamped
 * against (`entry.stamp` — see `snapshotMessageRevision`), the ledger either
 * (a) contains a newer `msg.put` for the SAME id (a durable checkpoint landed
 * and this process just never got to delete the now-superseded snapshot
 * file), or (b) was cut by a truncate/tomb/loopDrop event whose fold-time
 * effect removed that id (a stale snapshot must not revive a message the
 * user already deleted). An entry with no stamp (`undefined` — a legacy
 * on-disk file predating this fix) keeps the previous unconditional-merge
 * behavior, same as an entry the ledger has genuinely not touched since it
 * was captured (the crash-protection purpose this buffer exists for).
 *
 * `raw.length < entry.stamp` is a defensive third case: an append-only
 * ledger's length only grows, so a *current* length shorter than what this
 * entry was stamped against means something OUTSIDE this fold rewrote
 * `messages.jsonl` since capture (e.g. a downgrade-then-reupgrade across a
 * pre-ledger build, the scenario `feat/snapshot-watermark` guards at the
 * whole-file level) — per-entry, a stamp that outreaches the current ledger
 * is definitionally stale too, regardless of whether either offset check
 * above fires.
 *
 * Best-effort: when anything is dropped, the filtered set is written back to
 * disk (and the in-memory buffer re-armed from it — see `loadMessages`) so
 * the stale entry does not resurface on a future load if this call's own
 * `writeStreamSnapshot` never lands; either way the guard re-evaluates fresh
 * on every load, so a delete failure just gets filtered again next time
 * (audit RB-03 close condition: delete-failure tolerance follows free).
 */
async function filterStaleSnapshotEntries(
  convId: string,
  raw: string,
  snapshotEntries: Map<string, StreamSnapshotEntry>,
): Promise<Map<string, StreamSnapshotEntry>> {
  if (snapshotEntries.size === 0) return snapshotEntries;
  const anyStamped = [...snapshotEntries.values()].some((entry) => entry.stamp !== undefined);
  if (!anyStamped) return snapshotEntries;

  const { putOffsetById, removedOffsetById } = computeLedgerOffsetInfo(raw);
  const survivors = new Map<string, StreamSnapshotEntry>();
  const droppedIds: string[] = [];
  for (const [id, entry] of snapshotEntries) {
    if (entry.stamp === undefined) {
      survivors.set(id, entry);
      continue;
    }
    const stamp = entry.stamp;
    const putOffset = putOffsetById.get(id);
    const removedOffset = removedOffsetById.get(id);
    const stale =
      (putOffset !== undefined && putOffset >= stamp)
      || (removedOffset !== undefined && removedOffset >= stamp)
      || raw.length < stamp;
    if (stale) droppedIds.push(id);
    else survivors.set(id, entry);
  }

  if (droppedIds.length > 0) {
    console.warn(
      `[conversationStorage] loadMessages(${convId}): dropping ${droppedIds.length} stale ` +
        `stream-snapshot entr${droppedIds.length === 1 ? 'y' : 'ies'} superseded by the ledger ` +
        `(ids: ${droppedIds.join(', ')}).`,
    );
    await writeStreamSnapshot(convId, survivors);
  }
  return survivors;
}

/**
 * Promote every buffered revision into the ledger and drop the snapshot files.
 * Called on shutdown so a snapshot never outlives the session that wrote it.
 */
export async function flushStreamSnapshots(): Promise<void> {
  if (streamSnapshots.size === 0) return;
  await ensureBase();
  const promotions: { convId: string; done: Promise<unknown> }[] = [];
  for (const [convId, entries] of [...streamSnapshots.entries()]) {
    for (const { message } of entries.values()) {
      promotions.push({
        convId,
        done: (async () => {
          const allowToolResultDehydration = hasInlineToolResultImages(message)
            ? await refreshOutputManifestForToolResultImages(convId)
            : true;
          const line = serializeLedgerPut(
            convId,
            message,
            parentIdByMessage.get(message.id),
            allowToolResultDehydration,
          );
          await enqueueWrite(messagesPath(convId), line, message.id);
          writtenIds.add(message.id);
        })(),
      });
    }
    streamSnapshots.delete(convId);
  }
  await flushWrites();

  // Drop a snapshot file only AFTER its revision is durably in the ledger.
  // Removing it in parallel with the promotion leaves a crash window in which
  // neither copy exists, and a rejected promotion (disk full at exit) would
  // discard the revision outright — keeping the file lets the next launch
  // re-arm from it instead.
  const results = await Promise.allSettled(promotions.map((p) => p.done));
  const failedConvs = new Set(
    promotions.filter((_, i) => results[i].status === 'rejected').map((p) => p.convId),
  );
  await Promise.allSettled(
    [...new Set(promotions.map((p) => p.convId))]
      .filter((convId) => !failedConvs.has(convId))
      .map((convId) => writeStreamSnapshot(convId, new Map())),
  );
}

/**
 * Check whether a message id has already taken the disk-append path — i.e.
 * mirrors the exact dedup condition `appendMessage` uses to decide whether to
 * fire its `catalogBumpCount(+1)` (see `writtenIds.has` / `.add` above).
 *
 * Used by `appendTruncateEvent`'s skip guard (plan stage 3) to tell a purely
 * in-memory message (never durably appended, and no put still queued either)
 * from one that has — or will have — a physical row to cut. A streamed
 * assistant placeholder aborted before `addMessage`'s fire-and-forget
 * `appendMessage` call ever ran never had a catalog `+1` to offset, so
 * truncating it must write no ledger event at all and let chatStore's
 * approximate nudge (`bumpCatalogAfterDelete`) handle the count instead of a
 * reindex that would find nothing on disk to reconcile (code-review fix #8,
 * carried forward from the retired `deleteMessage`/`deleteMessageById` path).
 */
export function isMessageWrittenToDisk(id: string): boolean {
  return writtenIds.has(id);
}

// ════════════════════════════════════════════════════════════
// Strip for disk — reduce message size before persisting
// ════════════════════════════════════════════════════════════

/**
 * Prepare a message for disk storage:
 * - Clear image base64 data (filePath preserved for recovery)
 * - HTML/Mermaid/code blocks preserved intact
 */
function cloneToolResultContentForDisk(
  convId: string | undefined,
  toolCallId: string | undefined,
  resultContent: ToolResultContent[] | undefined,
  allowToolResultDehydration: boolean,
): ToolResultContent[] | undefined {
  if (!resultContent) return undefined;
  const imageCount = resultContent.filter((block) => block.type === 'image').length;
  const snapshot = allowToolResultDehydration && imageCount === 1 && toolCallId
    ? findToolResultImageSnapshot(convId, toolCallId)
    : null;
  return resultContent.map((block) => {
    if (block.type !== 'image') return { ...block };

    const clonedSource = { ...block.source };
    if (imageCount === 1 && block.source?.data && snapshot?.snapshotRelPath) {
      clonedSource.data = '';
      return {
        ...block,
        source: clonedSource,
        outputRef: {
          relPath: snapshot.snapshotRelPath,
          basename: snapshot.basename,
          sizeBytes: snapshot.size,
        },
      };
    }

    return {
      ...block,
      source: clonedSource,
      ...(block.outputRef ? { outputRef: { ...block.outputRef } } : {}),
    };
  });
}

function cloneToolCallsForDisk(
  convId: string | undefined,
  calls: ToolCall[] | undefined,
  allowToolResultDehydration: boolean,
): ToolCall[] | undefined {
  return calls?.map((call) => ({
    ...call,
    ...(call.resultContent
      ? { resultContent: cloneToolResultContentForDisk(convId, call.id, call.resultContent, allowToolResultDehydration) }
      : {}),
  }));
}

function cloneContextToolCallsForDisk(
  convId: string | undefined,
  calls: ToolCallForContext[] | undefined,
  allowToolResultDehydration: boolean,
): ToolCallForContext[] | undefined {
  return calls?.map((call) => ({
    ...call,
    ...(call.resultContent
      ? { resultContent: cloneToolResultContentForDisk(convId, call.id, call.resultContent, allowToolResultDehydration) }
      : {}),
  }));
}

function hasInlineToolResultImages(message: Message): boolean {
  const hasInlineImage = (call: ToolCall | ToolCallForContext): boolean =>
    !!call.resultContent?.some((block) => block.type === 'image' && !!block.source.data);
  return !!(
    message.toolCalls?.some(hasInlineImage)
    || message.toolCallsForContext?.some(hasInlineImage)
  );
}

interface StripForDiskOptions {
  allowToolResultDehydration?: boolean;
}

function stripForDisk(msg: Message, convId?: string, options: StripForDiskOptions = {}): Message {
  const stripped: Message = { ...msg };
  const allowToolResultDehydration = options.allowToolResultDehydration !== false;

  // 2. Clear user-message image base64 data (preserve filePath for recovery)
  if (Array.isArray(stripped.content)) {
    stripped.content = (stripped.content as MessageContent[]).map((block) => {
      if (block.type === 'image' && block.source?.data) {
        return {
          ...block,
          source: { ...block.source, data: '' },
        };
      }
      return block;
    });
  }

  // 3. Clear tool-result image base64 only when its PR-A snapshot definitely
  // exists. Always clone the full nested tree so a disk projection never shares
  // resultContent/image/source references with the live Zustand store.
  if (stripped.toolCalls) {
    stripped.toolCalls = cloneToolCallsForDisk(convId, stripped.toolCalls, allowToolResultDehydration);
  }
  if (stripped.toolCallsForContext) {
    stripped.toolCallsForContext = cloneContextToolCallsForDisk(
      convId,
      stripped.toolCallsForContext,
      allowToolResultDehydration,
    );
  }

  // 4. Clear streaming flags
  if (stripped.isStreaming) {
    stripped.isStreaming = false;
  }

  return stripped;
}

// ════════════════════════════════════════════════════════════
// Index management
// ════════════════════════════════════════════════════════════

let indexCache: ConversationIndex | null = null;
let indexFlushTimer: ReturnType<typeof setTimeout> | null = null;
const INDEX_FLUSH_INTERVAL_MS = 2000;

export async function loadIndex(): Promise<ConversationIndex> {
  if (indexCache) return indexCache;
  await ensureBase();
  const path = indexFilePath();
  if (await exists(path)) {
    try {
      const raw = await readTextFile(path);
      indexCache = JSON.parse(raw) as ConversationIndex;
    } catch {
      indexCache = { version: 1, entries: {} };
    }
  } else {
    indexCache = { version: 1, entries: {} };
  }
  return indexCache;
}

export function getIndexEntries(): Record<string, ConversationMeta> {
  return indexCache?.entries ?? {};
}

export async function updateIndexEntry(meta: ConversationMeta): Promise<void> {
  const index = await loadIndex();
  index.entries[meta.id] = meta;
  scheduleIndexFlush();
}

export async function removeIndexEntry(convId: string): Promise<void> {
  const index = await loadIndex();
  delete index.entries[convId];
  scheduleIndexFlush();
}

function scheduleIndexFlush(): void {
  if (indexFlushTimer) return;
  indexFlushTimer = setTimeout(async () => {
    indexFlushTimer = null;
    await flushIndex();
  }, INDEX_FLUSH_INTERVAL_MS);
}

export async function flushIndex(): Promise<void> {
  if (indexFlushTimer) {
    clearTimeout(indexFlushTimer);
    indexFlushTimer = null;
  }
  if (!indexCache) return;
  await ensureBase();
  await atomicWrite(indexFilePath(), JSON.stringify(indexCache, null, 2));
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

/** Absolute path to the conversations root dir. Set by ensureBase(). */
function conversationsRoot(): string {
  return basePath!;
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
    await ensureBase();
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
    await ensureBase();
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
    await ensureBase();
    // Drain the pending message-append write queue FIRST (fix #3).
    // `appendMessage` enqueues each JSONL line onto the 100ms-debounced
    // `enqueueWrite`/`drainAll` queue and returns without waiting for the
    // drain; at turn-end `setConversationStatus` fires this reindex right
    // after the final message is appended, so without draining here the
    // Rust-side `reindex_one_core` can scan a `messages.jsonl` that's still
    // missing the very message this reindex is supposed to index — newest
    // text absent from FTS, `message_count` lagging by one turn.
    // `flushWrites()` is a no-op if nothing is queued (idempotent, already
    // used this way elsewhere — see `shutdownConversationStorage`).
    await flushWrites();
    // Flush the in-memory index to disk NEXT. The Rust side's
    // `read_index_entries` reads `index.json` straight off disk, not TS's
    // in-memory `indexCache` — and index writes are normally debounced up to
    // `INDEX_FLUSH_INTERVAL_MS` (2s) by `scheduleIndexFlush()`. Both call
    // sites (rename, turn-end) call `updateIndexEntry()` — which updates
    // `indexCache` synchronously — immediately before this, so without an
    // explicit flush here the Rust-side reindex would very likely read the
    // STALE on-disk title/timestamps, defeating the entire point of a
    // live-freshness reindex. `flushIndex()` is a no-op if there's nothing
    // pending (idempotent, already used this way elsewhere in this module).
    await flushIndex();
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
export async function appendMessage(
  convId: string,
  message: Message,
): Promise<void> {
  if (writtenIds.has(message.id)) return; // dedup
  const inFlight = writingIds.get(message.id);
  if (inFlight) return inFlight;

  const write = (async () => {
    await ensureBase();
    // `pid` = the ledger tail at append time (plan §3.2). Claimed synchronously
    // so two appends racing through `ensureBase` still chain in write order.
    const pid = lastMessageIdByConv.get(convId);
    lastMessageIdByConv.set(convId, message.id);
    if (pid !== undefined) parentIdByMessage.set(message.id, pid);
    const allowToolResultDehydration = hasInlineToolResultImages(message)
      ? await refreshOutputManifestForToolResultImages(convId)
      : true;
    const line = serializeLedgerPut(convId, message, pid, allowToolResultDehydration);
    await enqueueWrite(messagesPath(convId), line, message.id);

    // Only claim the id after the append has actually succeeded. Marking it
    // before I/O made a transient disk failure permanently suppress retry and
    // allowed Reliable Run to execute without a durable user message.
    writtenIds.add(message.id);
    rememberPersistedMessage(message);

    // The catalog is a rebuildable projection; JSONL success above is the
    // hard requirement and the catalog bump remains best-effort.
    void catalogBumpCount(convId, 1, message.timestamp ?? Date.now(), message.id);
  })();
  writingIds.set(message.id, write);
  try {
    await write;
  } finally {
    if (writingIds.get(message.id) === write) writingIds.delete(message.id);
  }
}

/**
 * Unique id for a ledger event row (never the id of the affected message).
 * Mirrors the store-wide id convention (`Date.now().toString(36) +
 * Math.random().toString(36).substring(2, 8)`, AGENTS.md §5) with a short
 * kind prefix so a raw event line is recognizable at a glance in
 * `messages.jsonl` (plan §3.1's `tomb_…` example).
 */
function generateEventId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
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
 *   can be released (see below).
 * @returns `false` when nothing durable existed to cut — a purely in-memory
 *   message (never durably appended, and no put still queued either). Writing
 *   an event for it would be a permanent no-op line for a message no build
 *   ever persisted; the caller (chatStore) falls back to its approximate
 *   catalog nudge instead of relying on a reindex that would find nothing to
 *   reconcile.
 */
export async function appendTruncateEvent(
  convId: string,
  fromMessageId: string,
  opts: { pid?: string; removedIds: string[] },
): Promise<boolean> {
  await ensureBase();
  const path = messagesPath(convId);

  // Skip guard (plan stage 3): see this function's doc comment and
  // `isMessageWrittenToDisk`'s doc comment for why the durable-write set,
  // the still-queued puts AND the mid-drain in-flight puts all count as
  // "something to cut" — the third one closes the dequeued-but-unsettled
  // window where a turn-end checkpoint's put is otherwise invisible to both
  // other checks (review finding #1).
  if (
    !writtenIds.has(fromMessageId)
    && !hasPendingPut(path, fromMessageId)
    && !hasInFlightPut(path, fromMessageId)
  ) {
    return false;
  }

  const event = createLedgerEvent('msg.truncate', {
    id: generateEventId('trunc'),
    timestamp: Date.now(),
    from: fromMessageId,
    pid: opts.pid,
  });
  // Order-sensitive (no mergeKey): any put already queued for this file lands
  // BEFORE this line (so a same-drain-window edit-and-resend still lands),
  // and nothing queued after it can coalesce across it — see
  // `findMergeTarget`'s doc comment.
  await enqueueWrite(path, JSON.stringify(event) + '\n');

  // The event row is now the physical tail, but the NEXT message's parent
  // pointer must skip over it and point at the last SURVIVING message (plan
  // §3.2) — update the same per-conversation bookkeeping `appendMessage` uses
  // for an ordinary put.
  if (opts.pid !== undefined) lastMessageIdByConv.set(convId, opts.pid);
  else lastMessageIdByConv.delete(convId);

  // A future re-append of a truncated id must not be dedup-skipped by
  // appendMessage's `writtenIds.has` check — the fold treats a put after a
  // truncate as a legitimate revival (plan §3.3), so both the disk-side dedup
  // cache and any buffered stream-snapshot revision must forget these ids, or
  // the next load would resurrect exactly what the ledger just cut.
  for (const id of opts.removedIds) {
    writtenIds.delete(id);
    await dropStreamSnapshotEntry(convId, id);
  }

  return true;
}

/**
 * Replace a message in the JSONL file by its id.
 *
 * Since the ledger change this appends a second line carrying the same id
 * rather than rewriting the matching line in place: the fold keeps the last
 * put for an id, at that id's original position, so an append expresses a
 * revision exactly. That removes the read-modify-write — and with it the
 * whole class of interleaved-rewrite corruption the file mutex was holding
 * back — at the cost of the file growing by one line per checkpoint.
 *
 * Used by the agent loop to flush each turn's full state (including tool
 * calls) at a checkpoint; the in-flight revisions between checkpoints go to
 * `snapshotMessageRevision` instead so they never become lines at all.
 */
const SETTLED_SANDBOX_RECOVERY_ACTIONS = new Set([
  'completed',
  'failed',
  'needs-review',
  'stopped',
]);

function preservePersistedSandboxRecoveryActions(
  incoming: Message,
  persistedActions: Map<string, SandboxRecoveryAction> | undefined,
): Message {
  if (!incoming.toolCalls?.length || !persistedActions?.size) return incoming;
  let changed = false;
  const toolCalls = incoming.toolCalls.map((toolCall) => {
    const persistedAction = persistedActions.get(toolCall.id);
    const incomingAction = toolCall.sandboxRecoveryAction;
    const shouldPreserve =
      persistedAction != null
      && (
        incomingAction == null
        || (
          SETTLED_SANDBOX_RECOVERY_ACTIONS.has(persistedAction)
          && !SETTLED_SANDBOX_RECOVERY_ACTIONS.has(incomingAction)
        )
      );
    if (!shouldPreserve) return toolCall;
    changed = true;
    return { ...toolCall, sandboxRecoveryAction: persistedAction };
  });
  return changed ? { ...incoming, toolCalls } : incoming;
}

/**
 * Last-resort existence check for an id this process has neither written nor
 * loaded. The old rewrite read the whole file on EVERY replace; this reads it
 * only on a `writtenIds` miss, which in practice means never — both
 * `loadMessages` and `appendMessage` populate that set. Folding rather than
 * grepping means a message that a later event removed correctly reads as
 * absent.
 */
async function ledgerContainsMessage(path: string, messageId: string): Promise<boolean> {
  try {
    const raw = await readTextFile(path);
    if (!raw.includes(`"${messageId}"`)) return false;
    const present = foldMessageLog(raw.split('\n')).messages.some((m) => m.id === messageId);
    if (present) writtenIds.add(messageId);
    return present;
  } catch {
    return false;
  }
}

async function replaceMessageByIdInternal(
  convId: string,
  message: Message,
  strict: boolean,
): Promise<boolean> {
  await ensureBase();
  const path = messagesPath(convId);

  // An append is an upsert by nature; the old rewrite was not. Replacing an id
  // the file never held used to be a no-op (and a throw under `strict`), and
  // callers depend on that — a strict replace reporting success for a row that
  // does not exist would make crash recovery lie about a saved choice. With no
  // file scan left, `writtenIds` plus the still-queued puts are what answer
  // "does this message exist on disk?" (plan §1, difference ②).
  if (!hasPendingPut(path, message.id)) {
    if (!(await exists(path))) {
      if (strict) throw new Error(`Conversation messages file does not exist: ${convId}`);
      return false;
    }
    if (!writtenIds.has(message.id) && !(await ledgerContainsMessage(path, message.id))) {
      if (strict) throw new Error(`Message "${message.id}" was not found in conversation "${convId}"`);
      return false;
    }
  }

  try {
    // The rewrite used to re-read the persisted row here to keep a settled
    // sandbox recovery action from being clobbered by a stale in-memory one.
    // Nothing is read now, so the same protection comes from the recorded
    // per-message action map (plan §1, difference ①).
    const merged = preservePersistedSandboxRecoveryActions(
      message,
      persistedSandboxActions.get(message.id),
    );
    const allowToolResultDehydration = hasInlineToolResultImages(merged)
      ? await refreshOutputManifestForToolResultImages(convId)
      : true;
    await enqueueWrite(
      path,
      serializeLedgerPut(convId, merged, parentIdByMessage.get(message.id), allowToolResultDehydration),
      message.id,
    );
    writtenIds.add(message.id);
    rememberPersistedMessage(merged);
    // The ledger now carries this revision, so the crash-protection buffer
    // must stop claiming a newer one.
    await dropStreamSnapshotEntry(convId, message.id);
    return true;
  } catch (error) {
    if (strict) throw error;
    // Non-critical: leave the file as-is. Worst case the message disk state lags behind memory.
    return false;
  }
}

export async function replaceMessageById(
  convId: string,
  message: Message,
): Promise<void> {
  await replaceMessageByIdInternal(convId, message, false);
}

/**
 * Same serialized replacement as replaceMessageById, but confirms durable
 * success. Interactive workflow state uses this variant because reporting a
 * choice as saved when the row was absent or the write failed would make crash
 * recovery lie to the user.
 */
export async function replaceMessageByIdStrict(
  convId: string,
  message: Message,
): Promise<void> {
  await replaceMessageByIdInternal(convId, message, true);
}

/**
 * Persist the tail of a conversation when streaming completes or tool results
 * are added, for callers that do not know the message id they are finishing.
 *
 * This used to overwrite the last physical line WITHOUT checking its id, so a
 * message that arrived mid-stream could be silently swallowed by the update of
 * a different message. It now appends a put for `message.id` like any other
 * revision, which means both rows survive the fold (plan §1, difference ③).
 * That is a behaviour change, and a deliberate one: the failure it removes
 * destroyed a message, and the cost is one extra line.
 */
export async function updateLastMessage(
  convId: string,
  message: Message,
): Promise<void> {
  await ensureBase();
  const path = messagesPath(convId);
  // Preserved from the rewrite era: with no conversation file there is nothing
  // to finish, and this must not conjure one.
  if (!hasPendingPut(path, message.id) && !(await exists(path))) return;

  try {
    const merged = preservePersistedSandboxRecoveryActions(
      message,
      persistedSandboxActions.get(message.id),
    );
    const allowToolResultDehydration = hasInlineToolResultImages(merged)
      ? await refreshOutputManifestForToolResultImages(convId)
      : true;
    await enqueueWrite(
      path,
      serializeLedgerPut(convId, merged, parentIdByMessage.get(message.id), allowToolResultDehydration),
      message.id,
    );
    writtenIds.add(message.id);
    rememberPersistedMessage(merged);
    await dropStreamSnapshotEntry(convId, message.id);
  } catch {
    // Leave the id unclaimed so a later appendMessage can still get the
    // message onto disk — the same recovery the old fallback provided, minus
    // the second write path.
    writtenIds.delete(message.id);
  }
}

/**
 * Load all messages from a conversation JSONL file.
 * Populates the dedup cache so subsequent writes skip already-persisted messages.
 */
export async function loadMessages(convId: string): Promise<Message[]> {
  await ensureBase();
  const path = messagesPath(convId);
  if (!(await exists(path))) return [];

  // File-level read failure → empty list (same contract as before).
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch (err) {
    console.warn(
      `[conversationStorage] loadMessages(${convId}) readTextFile failed:`,
      err,
    );
    return [];
  }
  // Free the next append from re-reading the file just to check its tail.
  noteTailFromRead(path, raw);
  // Ledger byte watermark (RB-03 fix, plan §3.6 addendum): this read is now
  // the freshest known-durable length for this conversation's ledger — see
  // `ledgerBytesByConv`'s doc comment.
  ledgerBytesByConv.set(convId, raw.length);

  // The whole read is one fold (see messageLedger.ts for the spec). It keeps
  // the previous damage-reduction behaviour — a corrupt line is skipped, not
  // fatal — and the previous keep-last-by-id dedup, which a non-idempotent
  // append fallback can produce: if the native O(1) append durably writes a
  // line but its invoke promise still rejects (IPC teardown / shutdown race),
  // appendToFile falls through to read+rewrite and appends the same line again.
  // The fold additionally makes a repeated id an in-place revision rather than
  // a reorder, which is what lets the write side express "replace" as "append".
  // Revisions that a crash caught between checkpoints live in the stream
  // snapshot, not the ledger. Folding them in as trailing puts applies them
  // with exactly the ledger's own last-write-wins-in-place rule — MINUS
  // anything either stale-snapshot guard below determines the ledger has
  // already superseded.
  const snapshotResult = await readStreamSnapshot(convId);
  let rawSnapshotEntries = snapshotResult.entries;
  if (snapshotResult.ledgerBytes !== undefined && raw.length < snapshotResult.ledgerBytes) {
    // File-level shrink guard (plan §3.6 addendum): the ledger is SHORTER
    // than the watermark this snapshot was written against. Append-only
    // ledgers never shrink on their own — this means a foreign or older
    // build rewrote messages.jsonl in place since the snapshot was taken
    // (e.g. a downgrade to a pre-ledger version that knows nothing of
    // snapshots/persistRev, followed by a re-upgrade). Merging the
    // snapshot's revisions on top of that rewritten ledger risks overlaying
    // stale content over the user's edited history, so discard the WHOLE
    // snapshot instead — the ledger alone is the trustworthy source once its
    // own length no longer matches what this process last saw. (The
    // per-entry pass below only ever drops individual ids, so this coarser
    // check has to run first and short-circuit it.)
    console.warn(
      `[conversationStorage] loadMessages(${convId}): ledger shrank below its stream-snapshot ` +
        `watermark (${raw.length} < ${snapshotResult.ledgerBytes}) — discarding the snapshot instead of merging it.`,
    );
    await discardStreamSnapshot(convId);
    rawSnapshotEntries = new Map();
  }
  // Per-entry supersede pass (RB-03 fix): drop any surviving entry the
  // ledger has already superseded individually (a newer put for the same
  // id, or a truncate/tomb/loopDrop that removed it, at or after the
  // entry's byte-offset stamp).
  const snapshotEntries = await filterStaleSnapshotEntries(convId, raw, rawSnapshotEntries);
  if (snapshotEntries.size > 0) streamSnapshots.set(convId, snapshotEntries);
  else streamSnapshots.delete(convId);
  const { messages, corruptCount, totalLines } = foldMessageLog([
    ...raw.split('\n'),
    ...[...snapshotEntries.values()].map((entry) => JSON.stringify(entry.message)),
  ]);
  if (corruptCount > 0) {
    console.warn(
      `[conversationStorage] loadMessages(${convId}): skipped ${corruptCount}/${totalLines} corrupt line(s). ` +
        `The affected messages are lost, but ${messages.length} intact message(s) recovered.`,
    );
  }
  populateWrittenIds(convId, messages);
  return messages;
}

/**
 * Delete all files for a conversation (messages, outputs, results).
 * Also cleans up the legacy sessions/ path from pre-migration data.
 */
export async function deleteConversationFiles(convId: string): Promise<void> {
  await ensureBase();
  // Drop the crash-protection buffer first: leaving it armed would have a
  // later flush recreate the conversation directory we are deleting.
  streamSnapshots.delete(convId);
  lastMessageIdByConv.delete(convId);
  ledgerBytesByConv.delete(convId);
  // Remove new path
  const dir = convDir(convId);
  try {
    if (await exists(dir)) {
      await remove(dir, { recursive: true });
    }
  } catch {
    // Non-critical — directory may already be gone
  }

  // Remove legacy sessions/ path (pre-v4 migration data)
  try {
    const appData = await appDataDir();
    const legacyDir = joinPath(appData, 'sessions', convId);
    if (await exists(legacyDir)) {
      await remove(legacyDir, { recursive: true });
    }
  } catch {
    // Non-critical
  }
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
  imChannelId?: string;
  imPlatform?: string;
  scheduledTaskId?: string;
  triggerId?: string;
  projectId?: string;
  readOnly?: boolean;
  importedFrom?: { schemaVersion: number; importedAt: number };
}): ConversationMeta {
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
    projectId: conv.projectId,
    readOnly: conv.readOnly,
    importedFrom: conv.importedFrom,
  };
}

// ════════════════════════════════════════════════════════════
// Backup
// ════════════════════════════════════════════════════════════

const BACKUP_RETENTION_DAYS = 7;

/**
 * Create a daily backup of index.json. Keeps last 7 days.
 * Call once on app startup.
 */
export async function dailyBackup(): Promise<void> {
  await ensureBase();
  const appData = await appDataDir();
  const backupDir = joinPath(appData, 'backups');
  const today = new Date().toISOString().slice(0, 10);
  const backupPath = joinPath(backupDir, `index.${today}.json`);

  // Skip if already backed up today
  if (await exists(backupPath)) return;

  // Ensure backup directory exists
  if (!(await exists(backupDir))) {
    await mkdir(backupDir, { recursive: true });
  }

  // Copy current index
  const srcPath = indexFilePath();
  if (await exists(srcPath)) {
    try {
      const content = await readTextFile(srcPath);
      await atomicWrite(backupPath, content);
    } catch {
      // Backup failure is non-critical
    }
  }

  // Clean old backups
  try {
    const entries = await readDir(backupDir);
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86_400_000;
    for (const entry of entries) {
      if (!entry.name?.startsWith('index.')) continue;
      const dateMatch = entry.name.match(/index\.(\d{4}-\d{2}-\d{2})\.json/);
      if (dateMatch && new Date(dateMatch[1]).getTime() < cutoff) {
        await remove(joinPath(backupDir, entry.name));
      }
    }
  } catch {
    // Cleanup failure is non-critical
  }
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
  await ensureBase();
  await loadIndex();
  dailyBackup().catch(() => {}); // fire-and-forget
}

/**
 * Shutdown the storage engine. Call before app exit.
 * Flushes all pending writes.
 */
export async function shutdownConversationStorage(): Promise<void> {
  // Promote buffered revisions into the ledger first, so a stream snapshot
  // never outlives the session that produced it.
  await flushStreamSnapshots();
  await flushWrites();
  await flushIndex();
}
