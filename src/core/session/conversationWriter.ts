/**
 * Conversation Storage — JSONL-based file system persistence.
 *
 * `createConversationWriter` returns one instance that owns every piece of
 * state a conversation write needs: the write queue, the per-file locks, the
 * confirmed tails, the claimed message ids, the ledger watermarks, the parent
 * pointers, the buffered stream snapshots and the index cache. Nothing lives at
 * module level, so two instances share nothing and a tier can hold one per
 * process.
 *
 * Everything that is not a pure computation is injected. File access is the
 * `ConversationFsPrimitives` of the tier; the clock, the random suffix of an
 * event id, the app version, the trace sink, the output-manifest lookup, the
 * catalog count bump and the app data directory are the
 * `ConversationWriterEnv`. The one-per-install jobs — the version-change
 * snapshot sweep, the daily index backup and ownership of `index.json` — are
 * capabilities, so a second tier can write conversations without also claiming
 * them. Paths and the conversation-id grammar come from `conversationPaths.ts`.
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
 *     event line (messageLedger.ts) rather than a rewrite. The read side
 *     (`projectLedger` in ledgerReader.ts) keeps the last put per id and
 *     applies truncate/tomb events strictly in the order they were written,
 *     then folds in whatever the stream snapshot still holds that the ledger
 *     has not superseded. Nothing rewrites an existing line anymore
 *     except what a tier's `appendText` does to emulate an append.
 *   - WriteQueue batches writes per file (100ms debounce) and collapses queued
 *     revisions of the same message into one line; event rows (truncates)
 *     are order-sensitive and never merge across a put
 *   - UUID-based dedup prevents duplicate writes on restart
 *   - Streaming tokens stay in memory; only complete messages hit disk
 *   - The 5s crash-protection flush and per-tool-result writes go to
 *     stream-snapshot.json, NOT the ledger — see the stream snapshot section
 *     for why that budget matters
 */

import { parsePayloadTooLargeError } from '@/core/ipc/payloadTooLarge';
import type { PermissionMode } from '../permissions/permissionMode';
import { withAcceptedPermissionMode } from './conversationPermissionMode';
import { createLedgerEvent, type LedgerLine } from './messageLedger';
import { projectLedger, STREAM_SNAPSHOT_FILENAME, type StreamSnapshotEntry } from './ledgerReader';
import {
  assertConversationId,
  ConversationPathError,
  createConversationPaths,
  isDirectChildPath,
  joinConversationPath,
  type ConversationPaths,
} from './conversationPaths';
import {
  hasInlineToolResultImages,
  serializeLedgerPut,
  stripForDisk,
  type FindToolResultImageSnapshot,
} from './ledgerLineSerializer';
import type { Message, SandboxRecoveryAction } from '@/types';

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
  /** Permission mode of this conversation (undefined = follow the global default). */
  permissionMode?: PermissionMode;
  imChannelId?: string;
  imPlatform?: string;
  scheduledTaskId?: string;
  triggerId?: string;
  teamId?: string;
  projectId?: string;
  totalCost?: number;
  /** Imported share bundle — conversation is read-only. See Conversation.readOnly. */
  readOnly?: boolean;
  importedFrom?: {
    schemaVersion: number;
    importedAt: number;
  };
}

export interface ConversationIndex {
  version: 1;
  entries: Record<string, ConversationMeta>;
}

/** Everything a writer does to a file. One implementation per tier. */
export interface ConversationFsPrimitives {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  stat(path: string): Promise<{ size: number }>;
  /** Writes `data` at the end of the file, creating the file and its parent directory when missing. Not atomic. */
  appendText(path: string, data: string): Promise<void>;
  /** Replaces the file so that a reader sees the old content or the new, creating parent directories. */
  atomicWriteText(path: string, content: string): Promise<void>;
  /**
   * `path` with every existing component resolved through the filesystem and a
   * missing tail kept as written. Null when this tier has no such primitive.
   */
  canonicalPath(path: string): Promise<string | null>;
}

/** Everything a writer needs that is neither a file nor a pure computation. */
export interface ConversationWriterEnv {
  appDataDir(): Promise<string>;
  appVersion: string;
  now(): number;
  /** Up to six base-36 characters; the tail of a ledger event id. */
  randomSuffix(): string;
  /** `event` has no tier prefix (`stream_snapshot_write_failed`). */
  trace(event: string, attributes: Record<string, unknown>): void;
  errorType(err: unknown): string;
  outputManifest: {
    refresh(convId: string): Promise<unknown>;
    findToolResultImageSnapshot: FindToolResultImageSnapshot;
  };
  /** Best-effort catalog count bump after a first durable append. A tier that must not issue it leaves it out. */
  catalogBumpCount?(convId: string, delta: number, updatedAt: number, lastMessageId: string | null): Promise<void>;
}

export interface ConversationWriterCapabilities {
  /** The first use of the instance runs the version-change stream-snapshot sweep. */
  versionSweep: boolean;
  /** `init()` starts the daily index backup and `dailyBackup()` may be called. */
  dailyBackup: boolean;
  /** The instance owns `index.json`: load, row update, row removal, flush. */
  indexWriter: boolean;
}

export class ConversationWriterCapabilityError extends Error {
  readonly code = 'capability_not_enabled' as const;
  readonly capability: keyof ConversationWriterCapabilities;
  constructor(capability: keyof ConversationWriterCapabilities) {
    super(`This conversation writer was created without the "${capability}" capability`);
    this.name = 'ConversationWriterCapabilityError';
    this.capability = capability;
  }
}

export interface ConversationWriter {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  /** Resolves the conversations root, creates it when missing, and runs the version sweep when this instance has it. Idempotent. */
  ensureReady(): Promise<void>;
  /** `<appData>/conversations`, or null until `ensureReady` or any other awaited method has resolved it. */
  conversationsRoot(): string | null;
  flushWrites(): Promise<void>;
  flushAndGetLedgerWatermark(convId: string): Promise<number>;
  snapshotMessageRevision(convId: string, message: Message): Promise<void>;
  promoteStreamSnapshots(convId: string): Promise<number>;
  hasArmedStreamSnapshot(convId: string): boolean;
  flushStreamSnapshots(): Promise<void>;
  isMessageWrittenToDisk(id: string): boolean;
  loadIndex(): Promise<ConversationIndex>;
  getIndexEntries(): Record<string, ConversationMeta>;
  updateIndexEntry(meta: ConversationMeta): Promise<void>;
  removeIndexEntry(convId: string): Promise<void>;
  flushIndex(): Promise<void>;
  appendMessage(convId: string, message: Message): Promise<void>;
  appendTruncateEvent(convId: string, fromMessageId: string, opts: { pid?: string; removedIds: string[] }): Promise<boolean>;
  replaceMessageById(convId: string, message: Message): Promise<void>;
  replaceMessageByIdStrict(convId: string, message: Message): Promise<void>;
  updateLastMessage(convId: string, message: Message): Promise<void>;
  loadMessages(convId: string, options?: { strictRead?: boolean }): Promise<Message[]>;
  /**
   * Drops everything this instance knows about one conversation: tail check,
   * written ids, ledger length, last message id, parent ids, settled sandbox
   * actions, armed snapshots and the containment check. Write entries of the
   * conversation that are still running are awaited and the queue is flushed
   * first. The next write entry for the conversation re-derives all of it from
   * one strict read of the ledger and the snapshot file, resolves the
   * conversation directory again, and rejects when either fails. Files are not
   * touched.
   */
  forgetConversation(convId: string): Promise<void>;
  deleteConversationFiles(convId: string): Promise<void>;
  dailyBackup(): Promise<void>;
}

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
   * `ledgerCharsByConv`'s doc comment. Present on both the v1 shape (an
   * already-shipped build wrote it before the per-entry `stamp` addendum
   * existed) and the current v2 shape; absent only on the oldest snapshots
   * written before either addendum, which are merged unconditionally.
   */
  ledgerBytes?: number;
}

const DRAIN_INTERVAL_MS = 100;
const INDEX_FLUSH_INTERVAL_MS = 2000;
const BACKUP_RETENTION_DAYS = 7;

const SETTLED_SANDBOX_RECOVERY_ACTIONS = new Set([
  'completed',
  'failed',
  'needs-review',
  'stopped',
]);

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

export function createConversationWriter(deps: {
  fs: ConversationFsPrimitives;
  env: ConversationWriterEnv;
  capabilities: ConversationWriterCapabilities;
}): ConversationWriter {
  const { fs, env, capabilities } = deps;

  const requireCapability = (c: keyof ConversationWriterCapabilities): void => {
    if (!capabilities[c]) throw new ConversationWriterCapabilityError(c);
  };

  const diskOptions = (allowToolResultDehydration: boolean) => ({
    allowToolResultDehydration,
    findToolResultImageSnapshot: env.outputManifest.findToolResultImageSnapshot,
  });

  // ════════════════════════════════════════════════════════════
  // Path helpers
  // ════════════════════════════════════════════════════════════

  let paths: ConversationPaths | null = null;

  async function ensureBase(): Promise<ConversationPaths> {
    if (!paths) {
      const appData = await env.appDataDir();
      paths = createConversationPaths(appData);
      if (!(await fs.exists(paths.root))) {
        await fs.mkdir(paths.root, { recursive: true });
      }
      if (capabilities.versionSweep) await sweepStaleStreamSnapshotsOnVersionChange();
      // Probed here, with the root's own creation, rather than on the first
      // conversation: a tier with no canonical primitive then answers every
      // later containment check out of this one result, and the first write of
      // a conversation waits for nothing the root's setup did not already pay.
      canonicalRoot = await fs.canonicalPath(paths.root);
    }
    return paths;
  }

  // ════════════════════════════════════════════════════════════
  // Containment (design D6)
  // ════════════════════════════════════════════════════════════
  //
  // The id grammar makes a conversation path lexically `<root>/<one segment>`,
  // which says nothing about where that segment points once the filesystem has
  // resolved it. A conversation directory that is a link, or that sits under a
  // linked ancestor, can name anything on the disk — and this writer appends
  // to it, rewrites files in it and removes it recursively. So before the first
  // file call this process makes for a conversation, both sides are resolved
  // and the directory must come out a direct child of the resolved root.

  /** undefined: not asked yet. null: this tier has no canonical primitive. */
  let canonicalRoot: string | null | undefined;
  /** The resolved legacy sessions root. undefined: not asked yet. null: no canonical primitive. */
  let canonicalLegacyRoot: string | null | undefined;
  const containedConversations = new Set<string>();

  async function canonicalOf(path: string, known: string | null | undefined): Promise<string | null> {
    return known !== undefined ? known : fs.canonicalPath(path);
  }

  /** Rejects unless `dir` canonically is a direct child of `canonicalRootDir`. */
  async function assertDirectChild(canonicalRootDir: string | null, dir: string): Promise<void> {
    if (canonicalRootDir === null) return;
    const canonicalDir = await fs.canonicalPath(dir);
    if (canonicalDir === null) throw new ConversationPathError('canonical_path_unavailable');
    if (!isDirectChildPath(canonicalRootDir, canonicalDir)) throw new ConversationPathError('conversation_dir_outside_root');
  }

  /**
   * Resolve the conversation directory and refuse it unless it is a direct
   * child of the resolved conversations root.
   *
   * `ensureConversation` runs it the first time this process touches a
   * conversation and again after a `forgetConversation` — the same moments at
   * which every other fact this instance holds about the conversation is
   * (re-)derived — and records the answer in `containedConversations`.
   * `deleteConversationFiles` calls it directly, past that record, because the
   * one operation that removes a directory tree re-resolves it every time.
   * Between those checks the path is not unguarded: in the renderer the main
   * process resolves and scope-checks the path of every single operation
   * (`assertAllowed` in `electron/fsHost.cjs`), and in the sidecar the adapter
   * opens final components without following links.
   *
   * A tier whose `canonicalPath` answers null for the root has no canonical
   * primitive at all, and the lexical guarantee of `conversationPaths.ts`
   * stands alone. A tier that resolves the root and then cannot resolve a
   * conversation directory is refused instead: that is a missing answer, not a
   * missing primitive.
   */
  async function assertConversationContained(convId: string): Promise<void> {
    const p = paths!;
    // `ensureBase` normally has this already. It does not when a second caller
    // entered while the first was still inside `ensureBase`'s init block, which
    // assigns `paths` before it resolves the root.
    canonicalRoot = await canonicalOf(p.root, canonicalRoot);
    await assertDirectChild(canonicalRoot, p.conversationDir(convId));
    containedConversations.add(convId);
  }

  /**
   * What every conversation-scoped method awaits first: the id passes the
   * grammar before any path exists, the root exists, and the conversation
   * directory resolves inside it.
   *
   * It answers without a promise whenever it has nothing to resolve — the root
   * is resolved and either this conversation has been checked already or this
   * tier has no canonical primitive to check it with. A queued append reaches
   * the write queue in a fixed number of microtask turns, and a caller that
   * fires a flush right behind one (`catalogReindexConversation` drains the
   * queue before it reindexes) must still find that append in it.
   */
  function ensureConversation(convId: string): ConversationPaths | Promise<ConversationPaths> {
    // Before `ensureBase`, so an invalid id costs no file call even on the
    // first use of the instance.
    assertConversationId(convId);
    if (paths && canonicalRoot !== undefined && (canonicalRoot === null || containedConversations.has(convId))) {
      return paths;
    }
    return resolveConversation(convId);
  }

  async function resolveConversation(convId: string): Promise<ConversationPaths> {
    const p = await ensureBase();
    await assertConversationContained(convId);
    return p;
  }

  // ════════════════════════════════════════════════════════════
  // Per-file mutex — serializes read-modify-write against same path
  // ════════════════════════════════════════════════════════════
  //
  // One call site still does non-atomic read-modify-write on messages.jsonl:
  //   - a tier whose `appendText` emulates the append by rewriting the file
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

  const writeQueues = new Map<string, PendingWrite[]>();
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

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
   * Put ids dequeued by a drain whose append has not settled yet, keyed
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
          // Ledger watermark (RB-03 fix, plan §3.6 addendum): the append that
          // just landed durably grew messages.jsonl by exactly `data.length`
          // characters (repairTornTail's rare leading newline is a bounded,
          // accepted exception — see its doc comment — immaterial to the >= /
          // strictly-less-than comparisons this watermark feeds in
          // `projectLedger` (ledgerReader.ts), both the file-level shrink guard
          // and the per-entry supersede rule). Advance before claiming ids below
          // so a snapshot written moments later already reflects this append's
          // offset.
          const watermarkConvId = paths?.conversationIdOfMessagesPath(filePath);
          if (watermarkConvId) advanceLedgerChars(watermarkConvId, data.length);
          // Claim the ids HERE, synchronously with the drain settling — not in
          // the callers' microtask continuations — so there is no instant where
          // a durably-landed put is in neither writtenIds nor the in-flight set
          // (appendMessage's own later add is then redundant but harmless).
          // A drained path that is not a conversation's ledger never carries a
          // merge key, so the two conditions below are one condition.
          pending.forEach((p) => {
            if (p.mergeKey !== undefined && watermarkConvId) claimWritten(watermarkConvId, p.mergeKey);
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
   * An append is not atomic (see `appendToFile` below), so a crash mid-write
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
      if (!(await fs.exists(filePath))) {
        tailCheckedPaths.add(filePath);
        return data;
      }
      const raw = await fs.readTextFile(filePath);
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
   * Append data to a file. The tier's `appendText` creates the parent directory
   * on the first write.
   *
   * Atomicity trade-off: an append does NOT have the guarantee an atomic write
   * has — a crash mid-write can leave a half-written last line. This is an
   * accepted trade-off: `loadMessages` below already tolerates and skips
   * corrupt JSONL lines, so the worst case of a crash during an append is
   * losing the one message that was mid-flight, never the messages already
   * durably on disk before the call started.
   *
   * Serialized against concurrent mutations on the same path via `withFileLock`.
   */
  async function appendToFile(filePath: string, rawData: string): Promise<void> {
    return withFileLock(filePath, async () => {
      await fs.appendText(filePath, await repairTornTail(filePath, rawData));
    });
  }

  /**
   * Force-flush all pending writes. Call before app exit or crash recovery.
   */
  async function flushWrites(): Promise<void> {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    await drainAll();
  }

  /**
   * Terminate a crash-torn tail so the file ends after a `\n`, writing the same
   * newline the next append would have prefixed (`repairTornTail`) and marking
   * the tail confirmed so that append does not write a second one.
   *
   * The caller must hold the path's file lock and must have established that the
   * file exists. Common path: `loadMessages` and every append already confirm
   * the tail through `tailCheckedPaths`, so this costs nothing and reads
   * nothing. Only a tail this process has never seen — or one a read reported
   * torn — pays for one read, and only a genuinely torn one for a one-byte
   * append. That append's byte is not counted into `ledgerCharsByConv`, the same
   * bounded exception `repairTornTail`'s own newline has.
   */
  async function terminateTornTailLocked(filePath: string): Promise<void> {
    if (tailCheckedPaths.has(filePath)) return;
    const raw = await fs.readTextFile(filePath);
    if (raw.length > 0 && !raw.endsWith('\n')) await fs.appendText(filePath, '\n');
    tailCheckedPaths.add(filePath);
  }

  /**
   * Flush the write queue and report the ledger's size in bytes — the offset up
   * to which every line is durable and complete, which is what makes it usable
   * as a cut point by a reader in another process (`decodeLedgerPrefix` in
   * `ledgerReader.ts`).
   *
   * Two things stand between the flush and that guarantee, and both are handled
   * under the ledger's own file lock:
   *
   *  - A drain the 100 ms debounce started is not awaited by anyone, so
   *    `flushWrites` can find an empty queue while that drain is still inside
   *    its append. Taking the lock queues this read behind it, because
   *    `appendToFile` registers the lock synchronously when `drainAll` calls it.
   *  - A crash mid-append leaves the file ending in a partial line, and nothing
   *    repairs it until the next append. A size that does not sit after a `\n`
   *    is refused by every reader, so the tail is terminated first.
   */
  async function flushAndGetLedgerWatermark(convId: string): Promise<number> {
    await ensureConversation(convId);
    await flushWrites();
    const path = paths!.messagesPath(convId);
    return withFileLock(path, async () => {
      if (!(await fs.exists(path))) return 0;
      await terminateTornTailLocked(path);
      return (await fs.stat(path)).size;
    });
  }

  // ════════════════════════════════════════════════════════════
  // UUID dedup — prevents double-writing on restart/replay
  // ════════════════════════════════════════════════════════════

  const writtenIds = new Set<string>();
  const writingIds = new Map<string, Promise<void>>();

  /**
   * The ids claimed above, grouped by conversation. `writtenIds` is one flat
   * set because a message id is unique across conversations; this index is what
   * lets `forgetConversation` release one conversation's ids without walking
   * every id this process has ever claimed.
   */
  const idsByConv = new Map<string, Set<string>>();

  /** Every claim of a durable id goes through here, so a conversation's ids can be released together. */
  function claimWritten(convId: string, id: string): void {
    writtenIds.add(id);
    let ids = idsByConv.get(convId);
    if (!ids) {
      ids = new Set();
      idsByConv.set(convId, ids);
    }
    ids.add(id);
  }

  /**
   * Clear the dedup cache. Call when loading messages from disk
   * to populate the set with already-persisted message IDs.
   */
  function populateWrittenIds(convId: string, messages: Message[]): void {
    for (const msg of messages) {
      claimWritten(convId, msg.id);
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
   * Per conversation, the length of `messages.jsonl` this process last confirmed
   * durable — either by reading it (`loadMessages`) or by appending to it
   * (`drainAll`). It counts JavaScript string length, not UTF-8 bytes: it is
   * compared against, and written into, numbers measured the same way.
   *
   * This is what this process writes into a stream snapshot twice over: once per
   * file as `ledgerBytes` and once per entry as `stamp` (see
   * `writeStreamSnapshot` and `snapshotMessageRevision`). Those two field names
   * are part of the on-disk format and stay as they are, whatever the unit is
   * called here. Both numbers exist so that a later load can tell a snapshot the
   * ledger has moved past from one it has not touched; the rules that read them
   * are in `ledgerReader.ts`.
   *
   * `flushAndGetLedgerWatermark`'s byte watermark is a different number for a
   * different purpose — real UTF-8 bytes from `stat`, handed to a reader in
   * another process as a cut point.
   */
  const ledgerCharsByConv = new Map<string, number>();

  function advanceLedgerChars(convId: string, delta: number): void {
    ledgerCharsByConv.set(convId, (ledgerCharsByConv.get(convId) ?? 0) + delta);
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

  async function refreshOutputManifestForToolResultImages(convId: string): Promise<boolean> {
    try {
      await env.outputManifest.refresh(convId);
      return true;
    } catch {
      // Temporal guard: if the cross-process manifest refresh fails, keep
      // inline bytes for this write rather than risking a dangling outputRef.
      return false;
    }
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

  /** convId → messageId → newest revision not yet checkpointed into the ledger. */
  const streamSnapshots = new Map<string, Map<string, StreamSnapshotEntry>>();

  async function writeStreamSnapshot(
    convId: string,
    entries: Map<string, StreamSnapshotEntry>,
  ): Promise<void> {
    const path = paths!.streamSnapshotPath(convId);
    try {
      if (entries.size === 0) {
        if (await fs.exists(path)) await fs.remove(path);
        return;
      }
      const payload: StreamSnapshotFile = {
        version: 2,
        entries: [...entries.values()],
        // Best current knowledge of the ledger's durable length (0 for a
        // conversation this process has neither loaded nor appended to yet —
        // accurate, since there is then nothing on disk to shrink below). Kept
        // alongside the per-entry `stamp` so the file-level shrink guard
        // (plan §3.6 addendum) and the per-entry supersede pass (RB-03 fix)
        // can both run off the same on-disk payload.
        ledgerBytes: ledgerCharsByConv.get(convId) ?? 0,
      };
      await fs.atomicWriteText(path, JSON.stringify(payload));
    } catch (err) {
      // Best-effort crash protection — but never silent (#549). Losing a snapshot
      // only costs the in-flight revision, yet a snapshot that never lands is
      // exactly what makes a long turn end with nothing on screen, so the failure
      // is recorded (numbers and ids only, never the buffered content).
      const tooLarge = parsePayloadTooLargeError(err);
      env.trace('stream_snapshot_write_failed', {
        conversationId: convId,
        outcome: 'error',
        errorType: tooLarge ? 'payload_too_large' : env.errorType(err),
        ...(tooLarge ? { payloadBytes: tooLarge.bytes, limitBytes: tooLarge.limit } : {}),
      });
    }
  }

  /**
   * Record an in-flight revision without touching the ledger.
   *
   * Use this for anything that fires on a timer or per tool result while a turn
   * is still running. Use `replaceMessageById` at the checkpoints where the
   * state is worth a permanent line.
   */
  async function snapshotMessageRevision(convId: string, message: Message): Promise<void> {
    await ensureConversation(convId);
    await ensureDerived(convId);
    const allowToolResultDehydration = hasInlineToolResultImages(message)
      ? await refreshOutputManifestForToolResultImages(convId)
      : true;
    const entries = streamSnapshots.get(convId) ?? new Map<string, StreamSnapshotEntry>();
    entries.set(message.id, {
      message: stripForDisk(message, convId, diskOptions(allowToolResultDehydration)),
      // RB-03 fix: how much of this conversation's ledger this process had
      // confirmed durable at the moment this revision was captured. See
      // `ledgerCharsByConv`'s doc comment, and the per-entry supersede rule in
      // `ledgerReader.ts`, which is what this stamp exists for.
      stamp: ledgerCharsByConv.get(convId) ?? 0,
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

  /**
   * The snapshot file's text, or null when there is none or it cannot be read.
   * Handed to `projectLedger`, which owns the parsing and the stale-entry rules;
   * the in-memory buffer is re-armed by `loadMessages` from what that projection
   * says survived, never straight from the file.
   */
  async function readStreamSnapshotText(convId: string): Promise<string | null> {
    const path = paths!.streamSnapshotPath(convId);
    try {
      if (!(await fs.exists(path))) return null;
      return await fs.readTextFile(path);
    } catch {
      // An unreadable snapshot must never take the conversation down with it —
      // the ledger alone is still a complete, if slightly older, history.
      // (Damaged CONTENT is `projectLedger`'s business, not this read's.)
      return null;
    }
  }

  /**
   * Discard a stream snapshot outright — drop the in-memory buffer and delete
   * the file — rather than merging it. Used by `loadMessages` when the
   * projection reports that the whole snapshot was discarded. Best-effort
   * delete: if it fails, the same snapshot is simply re-evaluated (and again
   * discarded) on the next load.
   */
  async function discardStreamSnapshot(convId: string): Promise<void> {
    streamSnapshots.delete(convId);
    const path = paths!.streamSnapshotPath(convId);
    try {
      if (await fs.exists(path)) await fs.remove(path);
    } catch {
      // Best-effort — see doc comment above.
    }
  }

  /**
   * One-shot, version-gated sweep: on the first `ensureBase()` call of a
   * process whose app version does not match the version recorded in
   * `conversations/.snapshot-sweep-version`, delete every conversation's
   * `stream-snapshot.json`, then rewrite the marker to the current version.
   * Plan §3.6 addendum, part B.
   *
   * Why this exists alongside the ledger watermark (part A, whose `ledgerBytes`
   * shrink guard and RB-03 per-entry `stamp` supersede rule are both in
   * `projectLedger`, `ledgerReader.ts`): those checks only protect a snapshot
   * whose entries actually carry a watermark. That covers the
   * downgrade-then-reupgrade case precisely because a pre-ledger build knows
   * nothing about `stream-snapshot.json` and never touches it — it only
   * rewrites `messages.jsonl`, which is exactly what the file-level watermark
   * detects. This sweep is a coarser, independent second guard: it guarantees
   * no snapshot ever survives an app-version change at all, regardless of
   * whether it happens to carry a watermark, so a legacy snapshot from before
   * either field existed (merged unconditionally) cannot outlive the version
   * that wrote it either.
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
      const markerPath = paths!.sweepMarkerPath();
      let markerVersion: string | null = null;
      if (await fs.exists(markerPath)) {
        try {
          markerVersion = (await fs.readTextFile(markerPath)).trim();
        } catch (err) {
          console.warn('[conversationStorage] snapshot sweep: failed to read marker:', err);
        }
      }
      if (markerVersion === env.appVersion) return; // already swept for this version

      const entries = await fs.readDir(paths!.root);
      for (const entry of entries) {
        if (!entry.isDirectory) continue; // skip index.json, the marker itself, backups is outside the root
        // A directory name found on disk is not an id a caller handed in, so it
        // is not put through the grammar; only a file with this fixed name
        // inside a direct child of the root is removed.
        const snapshotPath = joinConversationPath(paths!.root, entry.name, STREAM_SNAPSHOT_FILENAME);
        try {
          if (await fs.exists(snapshotPath)) await fs.remove(snapshotPath);
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

      await fs.atomicWriteText(markerPath, env.appVersion);
    } catch (err) {
      // Must never block or throw out of ensureBase's init path — see doc
      // comment above.
      console.warn('[conversationStorage] snapshot sweep failed:', err);
    }
  }

  /**
   * Turn one buffered revision into the ledger line it promotes to.
   *
   * Both promotions serialize through here — the one conversation a dispatch
   * asks for (`promoteStreamSnapshots`) and every conversation at shutdown
   * (`flushStreamSnapshots`) — so a buffered revision becomes the same ledger
   * line whichever one reaches it.
   */
  async function serializeSnapshotPromotion(convId: string, message: Message): Promise<string> {
    const allowToolResultDehydration = hasInlineToolResultImages(message)
      ? await refreshOutputManifestForToolResultImages(convId)
      : true;
    return serializeLedgerPut(
      convId,
      message,
      parentIdByMessage.get(message.id),
      diskOptions(allowToolResultDehydration),
    );
  }

  /**
   * Queue one promoted line and claim its id once the line is durable. The
   * returned promise settles with the write: resolved means the line is on disk.
   *
   * The queue keeps the merge key, so a revision still queued for the same id is
   * overwritten in place rather than appended twice.
   */
  async function queueSnapshotPromotion(convId: string, message: Message, line: string): Promise<void> {
    await enqueueWrite(paths!.messagesPath(convId), line, message.id);
    claimWritten(convId, message.id);
  }

  /**
   * Promote one conversation's buffered revisions into its ledger and drop them
   * from the snapshot; every other conversation's buffer is left alone.
   *
   * A reader given a byte watermark gets the ledger prefix alone, with no
   * snapshot merged on top. A revision that lives only in the snapshot — the
   * partial answer a crash left behind, re-armed by `loadMessages` — is part of
   * what the user sees, so it has to be a ledger line before the watermark of a
   * new run is taken (`takeLedgerHistoryPoint` in `ledgerHistoryPoint.ts`).
   *
   * Every line is queued before the flush, so they reach the file in one append.
   * A failed append rejects and leaves the entries armed, in memory and on disk:
   * the dispatch that asked for the promotion fails visibly, and the next
   * attempt promotes them. The snapshot file is rewritten only after the ledger
   * holds the revisions, so no crash window has neither copy.
   */
  async function promoteStreamSnapshots(convId: string): Promise<number> {
    // The early return below answers before any path is built, so the grammar
    // runs here; the containment check comes with `ensureConversation` on the
    // path that reaches a file.
    assertConversationId(convId);
    // A forgotten conversation may have a snapshot on disk this process does not
    // hold, so the buffer is re-derived before it is read as empty.
    if (forgotten.has(convId)) {
      await ensureBase();
      await ensureDerived(convId);
    }
    const entries = streamSnapshots.get(convId);
    if (!entries || entries.size === 0) return 0;
    await ensureConversation(convId);

    // Serialized first, queued second: a revision whose tool-result images make
    // serialization await the output manifest would otherwise reach the queue
    // after the flush below and wait for the next drain.
    const promoted = await Promise.all(
      [...entries.entries()].map(async ([id, entry]) => ({
        id,
        entry,
        line: await serializeSnapshotPromotion(convId, entry.message),
      })),
    );
    // Observed before the flush so a rejected write always has a handler.
    const outcome = Promise.allSettled(
      promoted.map(({ entry, line }) => queueSnapshotPromotion(convId, entry.message, line)),
    );
    await flushWrites();
    const failed = (await outcome).find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;

    // Only what was promoted is dropped: an entry replaced while the write was
    // in flight is a newer revision the ledger does not hold.
    for (const { id, entry } of promoted) {
      if (entries.get(id) === entry) entries.delete(id);
    }
    if (entries.size === 0) streamSnapshots.delete(convId);
    await writeStreamSnapshot(convId, entries);
    return promoted.length;
  }

  /**
   * Whether this conversation holds a revision that is not a ledger line yet.
   *
   * Read-only: a dispatch taking its history point (`ledgerHistoryPoint.ts`)
   * asks after the watermark, because a frame that lands during the promotion
   * arms a revision the watermark it just took cannot cover.
   */
  function hasArmedStreamSnapshot(convId: string): boolean {
    const entries = streamSnapshots.get(convId);
    return entries !== undefined && entries.size > 0;
  }

  /**
   * Promote every buffered revision into the ledger and drop the snapshot files.
   * Called on shutdown so a snapshot never outlives the session that wrote it.
   */
  async function flushStreamSnapshots(): Promise<void> {
    if (streamSnapshots.size === 0) return;
    await ensureBase();
    const buffered: { convId: string; message: Message }[] = [];
    for (const [convId, entries] of [...streamSnapshots.entries()]) {
      for (const { message } of entries.values()) buffered.push({ convId, message });
      streamSnapshots.delete(convId);
    }
    // Serialized first, queued second, for the reason `promoteStreamSnapshots`
    // gives: the flush below has to find every line already in the queue, or the
    // promotion waits for the next drain — which a renderer being torn down at
    // quit never reaches.
    const serialized = await Promise.all(
      buffered.map(async ({ convId, message }) => ({
        convId,
        message,
        line: await serializeSnapshotPromotion(convId, message),
      })),
    );
    const promotions = serialized.map(({ convId, message, line }) => ({
      convId,
      done: queueSnapshotPromotion(convId, message, line),
    }));
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
  function isMessageWrittenToDisk(id: string): boolean {
    return writtenIds.has(id);
  }

  // ════════════════════════════════════════════════════════════
  // Index management
  // ════════════════════════════════════════════════════════════

  let indexCache: ConversationIndex | null = null;
  let indexFlushTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadIndex(): Promise<ConversationIndex> {
    requireCapability('indexWriter');
    if (indexCache) return indexCache;
    await ensureBase();
    const path = paths!.indexFilePath();
    if (await fs.exists(path)) {
      try {
        const raw = await fs.readTextFile(path);
        indexCache = JSON.parse(raw) as ConversationIndex;
      } catch {
        indexCache = { version: 1, entries: {} };
      }
    } else {
      indexCache = { version: 1, entries: {} };
    }
    normalizeIndexEntries(indexCache);
    return indexCache;
  }

  /**
   * A conversation's permission mode is read tolerantly: a value this build
   * does not accept is left out of the entry, every other field stays as it
   * was read. Runs outside the parse `try`, and never throws, so it cannot
   * turn a readable index into an empty one.
   */
  function normalizeIndexEntries(index: ConversationIndex): void {
    const entries: unknown = index.entries;
    if (typeof entries !== 'object' || entries === null) return;
    for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      index.entries[id] = withAcceptedPermissionMode(entry as ConversationMeta);
    }
  }

  function getIndexEntries(): Record<string, ConversationMeta> {
    requireCapability('indexWriter');
    return indexCache?.entries ?? {};
  }

  /**
   * Replace a conversation's row. The row passes the same rule as a row read
   * from disk: an entry can reach this writer without passing the reader (the
   * store keeps a localStorage row that has no disk row yet), and a permission
   * mode this build does not accept must not become durable that way.
   */
  async function updateIndexEntry(meta: ConversationMeta): Promise<void> {
    requireCapability('indexWriter');
    const index = await loadIndex();
    index.entries[meta.id] = withAcceptedPermissionMode(meta);
    scheduleIndexFlush();
  }

  async function removeIndexEntry(convId: string): Promise<void> {
    requireCapability('indexWriter');
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

  async function flushIndex(): Promise<void> {
    requireCapability('indexWriter');
    if (indexFlushTimer) {
      clearTimeout(indexFlushTimer);
      indexFlushTimer = null;
    }
    if (!indexCache) return;
    await ensureBase();
    await fs.atomicWriteText(paths!.indexFilePath(), JSON.stringify(indexCache, null, 2));
  }

  // ════════════════════════════════════════════════════════════
  // Message CRUD
  // ════════════════════════════════════════════════════════════

  /**
   * Append a message to the conversation JSONL file.
   * Deduplicates by message ID — safe to call multiple times.
   */
  async function appendMessage(convId: string, message: Message): Promise<void> {
    if (writtenIds.has(message.id)) return; // dedup
    const inFlight = writingIds.get(message.id);
    if (inFlight) return inFlight;

    const write = (async () => {
      await ensureConversation(convId);
      // A forgotten conversation re-derives first, and the dedup check above ran
      // against a set that did not yet know what the previous owner wrote.
      if ((await ensureDerived(convId)) && writtenIds.has(message.id)) return;
      // `pid` = the ledger tail at append time (plan §3.2). Claimed synchronously
      // so two appends racing through `ensureBase` still chain in write order.
      const pid = lastMessageIdByConv.get(convId);
      lastMessageIdByConv.set(convId, message.id);
      if (pid !== undefined) parentIdByMessage.set(message.id, pid);
      const allowToolResultDehydration = hasInlineToolResultImages(message)
        ? await refreshOutputManifestForToolResultImages(convId)
        : true;
      const line = serializeLedgerPut(convId, message, pid, diskOptions(allowToolResultDehydration));
      await enqueueWrite(paths!.messagesPath(convId), line, message.id);

      // Only claim the id after the append has actually succeeded. Marking it
      // before I/O made a transient disk failure permanently suppress retry and
      // allowed Reliable Run to execute without a durable user message.
      claimWritten(convId, message.id);
      rememberPersistedMessage(message);

      // The catalog is a rebuildable projection; JSONL success above is the
      // hard requirement and the catalog bump remains best-effort.
      if (env.catalogBumpCount) {
        void env.catalogBumpCount(convId, 1, message.timestamp ?? env.now(), message.id);
      }
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
    return `${prefix}_${env.now().toString(36)}${env.randomSuffix()}`;
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
  async function appendTruncateEvent(
    convId: string,
    fromMessageId: string,
    opts: { pid?: string; removedIds: string[] },
  ): Promise<boolean> {
    await ensureConversation(convId);
    await ensureDerived(convId);
    const path = paths!.messagesPath(convId);

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
      timestamp: env.now(),
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
  async function ledgerContainsMessage(convId: string, path: string, messageId: string): Promise<boolean> {
    try {
      const raw = await fs.readTextFile(path);
      if (!raw.includes(`"${messageId}"`)) return false;
      const present = projectLedger({ ledgerText: raw }).messages.some((m) => m.id === messageId);
      if (present) claimWritten(convId, messageId);
      return present;
    } catch {
      return false;
    }
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
  async function replaceMessageByIdInternal(
    convId: string,
    message: Message,
    strict: boolean,
  ): Promise<boolean> {
    await ensureConversation(convId);
    // Outside the `try` below, so a re-derivation that fails rejects the
    // non-strict variant too rather than being read as "nothing to replace".
    await ensureDerived(convId);
    const path = paths!.messagesPath(convId);

    // An append is an upsert by nature; the old rewrite was not. Replacing an id
    // the file never held used to be a no-op (and a throw under `strict`), and
    // callers depend on that — a strict replace reporting success for a row that
    // does not exist would make crash recovery lie about a saved choice. With no
    // file scan left, `writtenIds` plus the still-queued puts are what answer
    // "does this message exist on disk?" (plan §1, difference ②).
    if (!hasPendingPut(path, message.id)) {
      if (!(await fs.exists(path))) {
        if (strict) throw new Error(`Conversation messages file does not exist: ${convId}`);
        return false;
      }
      if (!writtenIds.has(message.id) && !(await ledgerContainsMessage(convId, path, message.id))) {
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
        serializeLedgerPut(convId, merged, parentIdByMessage.get(message.id), diskOptions(allowToolResultDehydration)),
        message.id,
      );
      claimWritten(convId, message.id);
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

  async function replaceMessageById(convId: string, message: Message): Promise<void> {
    await replaceMessageByIdInternal(convId, message, false);
  }

  /**
   * Same serialized replacement as replaceMessageById, but confirms durable
   * success. Interactive workflow state uses this variant because reporting a
   * choice as saved when the row was absent or the write failed would make crash
   * recovery lie to the user.
   */
  async function replaceMessageByIdStrict(convId: string, message: Message): Promise<void> {
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
  async function updateLastMessage(convId: string, message: Message): Promise<void> {
    await ensureConversation(convId);
    await ensureDerived(convId);
    const path = paths!.messagesPath(convId);
    // Preserved from the rewrite era: with no conversation file there is nothing
    // to finish, and this must not conjure one.
    if (!hasPendingPut(path, message.id) && !(await fs.exists(path))) return;

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
        serializeLedgerPut(convId, merged, parentIdByMessage.get(message.id), diskOptions(allowToolResultDehydration)),
        message.id,
      );
      claimWritten(convId, message.id);
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
   * Read the conversation from disk and rebuild every piece of bookkeeping a
   * write needs from what the read says: the confirmed tail, the claimed ids,
   * the ledger watermark, the last message id, the parent pointers, the settled
   * sandbox actions and the armed stream snapshot.
   *
   * This is what `loadMessages` has always done as a side effect of reading;
   * `forgetConversation` relies on it as the one way state comes back.
   */
  async function deriveFromDisk(convId: string, options?: { strictRead?: boolean }): Promise<Message[]> {
    await ensureConversation(convId);
    const path = paths!.messagesPath(convId);
    if (!(await fs.exists(path))) {
      // Nothing on disk is a complete answer, so the conversation is derived.
      forgotten.delete(convId);
      return [];
    }

    // Display reads keep the tolerant contract; receipt recovery must distinguish a read failure from an empty ledger.
    let raw: string;
    try {
      raw = await fs.readTextFile(path);
    } catch (err) {
      if (options?.strictRead) throw err;
      console.warn(
        `[conversationStorage] loadMessages(${convId}) readTextFile failed:`,
        err,
      );
      return [];
    }
    // Free the next append from re-reading the file just to check its tail.
    noteTailFromRead(path, raw);
    // Ledger watermark in string length (RB-03 fix, plan §3.6 addendum): this
    // read is now the freshest known-durable length for this conversation's
    // ledger — see `ledgerCharsByConv`'s doc comment.
    ledgerCharsByConv.set(convId, raw.length);

    // The whole read is one projection (`projectLedger` in ledgerReader.ts): the
    // ledger folded line by line, then whatever the stream snapshot still holds
    // that the ledger has not superseded, folded on top as trailing puts. It
    // keeps the previous damage-reduction behaviour — a corrupt line is skipped,
    // not fatal — and the previous keep-last-by-id dedup, which a non-idempotent
    // append can produce: if a tier's append durably writes a line but its
    // promise still rejects (IPC teardown / shutdown race), the emulated append
    // writes the same line again. The fold additionally makes a repeated id an
    // in-place revision rather than a reorder, which is what lets the write side
    // express "replace" as "append". Revisions that a crash caught between
    // checkpoints live in the stream snapshot, not the ledger.
    const snapshotText = await readStreamSnapshotText(convId);
    const projection = projectLedger({ ledgerText: raw, snapshotText });
    // This process is the only writer of `stream-snapshot.json`, so acting on
    // the projection's verdict is its job alone.
    if (projection.snapshot.discardedWhole) {
      console.warn(
        `[conversationStorage] loadMessages(${convId}): ledger shrank below its stream-snapshot ` +
          `watermark (${raw.length} < ${projection.snapshot.recordedLedgerChars}) — discarding the ` +
          `snapshot instead of merging it.`,
      );
      await discardStreamSnapshot(convId);
    } else if (projection.snapshot.droppedIds.length > 0) {
      const dropped = projection.snapshot.droppedIds;
      console.warn(
        `[conversationStorage] loadMessages(${convId}): dropping ${dropped.length} stale ` +
          `stream-snapshot entr${dropped.length === 1 ? 'y' : 'ies'} superseded by the ledger ` +
          `(ids: ${dropped.join(', ')}).`,
      );
      // Write the survivors back so a dropped entry cannot resurface on a later
      // load. Best-effort: the projection re-runs on every load, so a write-back
      // that never lands only means the same entry is filtered again next time.
      await writeStreamSnapshot(convId, projection.snapshot.merged);
    }
    if (projection.snapshot.merged.size > 0) streamSnapshots.set(convId, projection.snapshot.merged);
    else streamSnapshots.delete(convId);
    const { messages, corruptCount, totalLines } = projection;
    if (corruptCount > 0) {
      console.warn(
        `[conversationStorage] loadMessages(${convId}): skipped ${corruptCount}/${totalLines} corrupt line(s). ` +
          `The affected messages are lost, but ${messages.length} intact message(s) recovered.`,
      );
    }
    populateWrittenIds(convId, messages);
    forgotten.delete(convId);
    return messages;
  }

  /**
   * Load all messages from a conversation JSONL file.
   * Populates the dedup cache so subsequent writes skip already-persisted messages.
   */
  async function loadMessages(convId: string, options?: { strictRead?: boolean }): Promise<Message[]> {
    return deriveFromDisk(convId, options);
  }

  // ════════════════════════════════════════════════════════════
  // Forgetting one conversation
  // ════════════════════════════════════════════════════════════
  //
  // Everything above assumes this process is the only writer of a
  // conversation's files, and the bookkeeping it keeps is only true while that
  // holds. When the conversation is handed to another process and back, every
  // one of those facts can have moved on disk: the tail can be a stump the
  // other writer's crash left, the ledger can be longer than the watermark
  // says, ids and parent pointers and settled sandbox actions can exist that
  // this process never wrote, and a revision can be armed in a snapshot file
  // this process never buffered. So the whole conversation is dropped in one
  // step and re-derived from one read before the next write.

  /** Conversations whose state was dropped and not yet re-derived. */
  const forgotten = new Set<string>();

  /**
   * Drop every piece of per-conversation state this instance holds, including
   * the record that this conversation's directory was found inside the root, so
   * the next method to touch it resolves the directory again. Touches no file.
   */
  function releaseConversationState(convId: string): void {
    containedConversations.delete(convId);
    for (const id of idsByConv.get(convId) ?? []) {
      writtenIds.delete(id);
      persistedSandboxActions.delete(id);
      parentIdByMessage.delete(id);
    }
    idsByConv.delete(convId);
    ledgerCharsByConv.delete(convId);
    lastMessageIdByConv.delete(convId);
    streamSnapshots.delete(convId);
  }

  /**
   * Re-derive a forgotten conversation, once, before its next write. Answers
   * whether a re-derivation ran, which an append needs in order to re-check the
   * dedup it already decided against the older set. A conversation that was
   * never forgotten costs one `Set.has` and no read.
   */
  async function ensureDerived(convId: string): Promise<boolean> {
    if (!forgotten.has(convId)) return false;
    await deriveFromDisk(convId, { strictRead: true });
    return true;
  }

  /** Write entries that have started and not settled, per conversation. */
  const activeWrites = new Map<string, Set<Promise<unknown>>>();

  function tracked<T>(convId: string, run: () => Promise<T>): Promise<T> {
    const running = run();
    let set = activeWrites.get(convId);
    if (!set) {
      set = new Set();
      activeWrites.set(convId, set);
    }
    const entries = set;
    entries.add(running);
    const done = (): void => {
      entries.delete(running);
      if (entries.size === 0 && activeWrites.get(convId) === entries) activeWrites.delete(convId);
    };
    running.then(done, done);
    return running;
  }

  /**
   * Drop everything this instance knows about one conversation: tail check,
   * written ids, ledger length, last message id, parent ids, settled sandbox
   * actions, armed snapshots and the containment check. Write entries of the
   * conversation that are still running are awaited and the queue is flushed
   * first. The next write entry for the conversation re-derives all of it from
   * one strict read of the ledger and the snapshot file, resolves the
   * conversation directory again, and rejects when either fails. Files are not
   * touched.
   */
  async function forgetConversation(convId: string): Promise<void> {
    const { messagesPath } = await ensureConversation(convId);
    const path = messagesPath(convId);
    // An entry that has started may not have reached the queue yet; it settles
    // once its line is durable (or refused), so waiting for it covers both.
    await Promise.allSettled([...(activeWrites.get(convId) ?? [])]);
    await flushWrites();
    // Behind any drain the debounce started: `appendToFile` takes this lock
    // synchronously when `drainAll` calls it.
    await withFileLock(path, async () => {
      tailCheckedPaths.delete(path);
      releaseConversationState(convId);
      forgotten.add(convId);
    });
  }

  /**
   * Delete all files for a conversation (messages, outputs, results).
   * Also cleans up the legacy sessions/ path from pre-migration data.
   *
   * These are the writer's only recursive removes. Both targets come from the
   * path builders, so each is lexically `<root>/<id that passed the grammar>`,
   * and both are resolved again here rather than trusted from an earlier check:
   * a directory that has become a link since this process last looked at it
   * would otherwise carry the remove out of the root. A refusal is thrown, not
   * swallowed by the "non-critical" catches below, which cover a directory that
   * is merely gone or busy.
   */
  async function deleteConversationFiles(convId: string): Promise<void> {
    const p = await ensureConversation(convId);
    await assertConversationContained(convId);
    canonicalLegacyRoot = await canonicalOf(p.legacySessionsRoot, canonicalLegacyRoot);
    await assertDirectChild(canonicalLegacyRoot, p.legacySessionDir(convId));
    // Drop the crash-protection buffer first: leaving it armed would have a
    // later flush recreate the conversation directory we are deleting. The rest
    // of the conversation's state goes with it — the files it describes are
    // about to be gone — and the conversation counts as derived, because an
    // absent conversation is what the next read would find.
    releaseConversationState(convId);
    forgotten.delete(convId);
    // Remove new path
    const dir = paths!.conversationDir(convId);
    try {
      if (await fs.exists(dir)) {
        await fs.remove(dir, { recursive: true });
      }
    } catch {
      // Non-critical — directory may already be gone
    }

    // Remove legacy sessions/ path (pre-v4 migration data)
    try {
      const legacyDir = paths!.legacySessionDir(convId);
      if (await fs.exists(legacyDir)) {
        await fs.remove(legacyDir, { recursive: true });
      }
    } catch {
      // Non-critical
    }
  }

  // ════════════════════════════════════════════════════════════
  // Backup
  // ════════════════════════════════════════════════════════════

  /**
   * Create a daily backup of index.json. Keeps last 7 days.
   * Call once on app startup.
   */
  async function dailyBackup(): Promise<void> {
    requireCapability('dailyBackup');
    await ensureBase();
    const backupDir = paths!.backupDir;
    const today = new Date(env.now()).toISOString().slice(0, 10);
    const backupPath = joinConversationPath(backupDir, `index.${today}.json`);

    // Skip if already backed up today
    if (await fs.exists(backupPath)) return;

    // Ensure backup directory exists
    if (!(await fs.exists(backupDir))) {
      await fs.mkdir(backupDir, { recursive: true });
    }

    // Copy current index
    const srcPath = paths!.indexFilePath();
    if (await fs.exists(srcPath)) {
      try {
        const content = await fs.readTextFile(srcPath);
        await fs.atomicWriteText(backupPath, content);
      } catch {
        // Backup failure is non-critical
      }
    }

    // Clean old backups
    try {
      const entries = await fs.readDir(backupDir);
      const cutoff = env.now() - BACKUP_RETENTION_DAYS * 86_400_000;
      for (const entry of entries) {
        if (!entry.name?.startsWith('index.')) continue;
        const dateMatch = entry.name.match(/index\.(\d{4}-\d{2}-\d{2})\.json/);
        if (dateMatch && new Date(dateMatch[1]).getTime() < cutoff) {
          await fs.remove(joinConversationPath(backupDir, entry.name));
        }
      }
    } catch {
      // Cleanup failure is non-critical
    }
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
  async function init(): Promise<void> {
    await ensureBase();
    if (capabilities.indexWriter) await loadIndex();
    if (capabilities.dailyBackup) dailyBackup().catch(() => {}); // fire-and-forget
  }

  /**
   * Shutdown the storage engine. Call before app exit.
   * Flushes all pending writes.
   */
  async function shutdown(): Promise<void> {
    // Promote buffered revisions into the ledger first, so a stream snapshot
    // never outlives the session that produced it.
    await flushStreamSnapshots();
    await flushWrites();
    if (capabilities.indexWriter) await flushIndex();
  }

  return {
    init,
    shutdown,
    ensureReady: async () => { await ensureBase(); },
    conversationsRoot: () => paths?.root ?? null,
    flushWrites,
    flushAndGetLedgerWatermark,
    // The seven conversation-scoped write entries are tracked, so
    // `forgetConversation` can wait for the ones that have started. `tracked`
    // hands back the entry's own promise, so a caller settles exactly when and
    // with what it settled before.
    snapshotMessageRevision: (convId, message) => tracked(convId, () => snapshotMessageRevision(convId, message)),
    promoteStreamSnapshots: (convId) => tracked(convId, () => promoteStreamSnapshots(convId)),
    hasArmedStreamSnapshot,
    flushStreamSnapshots,
    isMessageWrittenToDisk,
    loadIndex,
    getIndexEntries,
    updateIndexEntry,
    removeIndexEntry,
    flushIndex,
    appendMessage: (convId, message) => tracked(convId, () => appendMessage(convId, message)),
    appendTruncateEvent: (convId, fromMessageId, opts) => tracked(convId, () => appendTruncateEvent(convId, fromMessageId, opts)),
    replaceMessageById: (convId, message) => tracked(convId, () => replaceMessageById(convId, message)),
    replaceMessageByIdStrict: (convId, message) => tracked(convId, () => replaceMessageByIdStrict(convId, message)),
    updateLastMessage: (convId, message) => tracked(convId, () => updateLastMessage(convId, message)),
    loadMessages,
    forgetConversation,
    deleteConversationFiles,
    dailyBackup,
  };
}
