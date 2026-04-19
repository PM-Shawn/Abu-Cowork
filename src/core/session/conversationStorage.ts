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
 *   ├── {convId}/
 *   │   ├── messages.jsonl      (message bodies, append-only)
 *   │   ├── outputs/            (images, generated files)
 *   │   └── results/            (large tool results >8KB)
 *   └── ...
 *
 * Write strategy:
 *   - WriteQueue batches writes per file (100ms debounce)
 *   - UUID-based dedup prevents duplicate writes on restart
 *   - Streaming tokens stay in memory; only complete messages hit disk
 *   - Periodic flush (5s) during streaming for crash protection
 */

import { exists, readTextFile, mkdir, remove, readDir } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { atomicWrite } from '@/utils/atomicFs';
import type { Message, MessageContent } from '@/types';

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
  imChannelId?: string;
  imPlatform?: string;
  scheduledTaskId?: string;
  triggerId?: string;
  projectId?: string;
  totalCost?: number;
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
// Three call sites do non-atomic read-modify-write on messages.jsonl:
//   - appendToFile (from drain)
//   - replaceMessageById (flush each agent turn)
//   - updateLastMessage (on stream completion)
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
  resolve: () => void;
  reject: (err: unknown) => void;
}

const writeQueues = new Map<string, PendingWrite[]>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
const DRAIN_INTERVAL_MS = 100;

function enqueueWrite(filePath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const queue = writeQueues.get(filePath) ?? [];
    queue.push({ line, resolve, reject });
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

async function drainAll(): Promise<void> {
  const entries = [...writeQueues.entries()];
  writeQueues.clear();

  await Promise.allSettled(
    entries.map(async ([filePath, pending]) => {
      const data = pending.map((p) => p.line).join('');
      try {
        await appendToFile(filePath, data);
        pending.forEach((p) => p.resolve());
      } catch (err) {
        pending.forEach((p) => p.reject(err));
      }
    }),
  );
}

/**
 * Append data to a file. Creates parent directory on first write.
 * Tauri's plugin-fs writeTextFile doesn't support native append, so we
 * read + append + atomic-write. For typical conversation files (<1MB) this is fine.
 *
 * Atomic writes (tempfile + fsync + rename) prevent partial writes on
 * crash / kill / power loss — readers either see the pre-append content
 * or the fully-appended content, never a truncated middle state.
 *
 * Serialized against concurrent mutations on the same path via `withFileLock`.
 */
async function appendToFile(filePath: string, data: string): Promise<void> {
  return withFileLock(filePath, async () => {
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

/**
 * Clear the dedup cache. Call when loading messages from disk
 * to populate the set with already-persisted message IDs.
 */
function populateWrittenIds(messages: Message[]): void {
  for (const msg of messages) {
    writtenIds.add(msg.id);
  }
}

// ════════════════════════════════════════════════════════════
// Strip for disk — reduce message size before persisting
// ════════════════════════════════════════════════════════════

const THINKING_MAX_CHARS = 500;

/**
 * Prepare a message for disk storage:
 * - Truncate thinking content (saves space, not useful for history)
 * - Clear image base64 data (filePath preserved for recovery)
 * - HTML/Mermaid/code blocks preserved intact
 */
function stripForDisk(msg: Message): Message {
  const stripped: Message = { ...msg };

  // 1. Truncate thinking
  if (stripped.thinking && stripped.thinking.length > THINKING_MAX_CHARS) {
    stripped.thinking =
      stripped.thinking.slice(0, THINKING_MAX_CHARS) + '\n[truncated]';
  }

  // 2. Clear image base64 data (preserve filePath for recovery)
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

  // 3. Clear streaming flags
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
  writtenIds.add(message.id);

  await ensureBase();
  const line = JSON.stringify(stripForDisk(message)) + '\n';
  await enqueueWrite(messagesPath(convId), line);
}

/**
 * Replace a message in the JSONL file by its id.
 * Unlike updateLastMessage, this scans for the matching id, so it correctly
 * updates intermediate-turn messages even after later turns have appended new
 * lines. Used by the agent loop to flush each turn's full state (including
 * tool calls) immediately after the tool batch completes — without this,
 * only the very last turn's tool calls would survive a restart.
 */
export async function replaceMessageById(
  convId: string,
  message: Message,
): Promise<void> {
  await ensureBase();
  const path = messagesPath(convId);
  if (!(await exists(path))) return;

  // Serialize with concurrent drain / updateLastMessage on the same path.
  // We intentionally do NOT pre-flush via flushWrites(): drain would try
  // to re-acquire the same lock and deadlock. The lock itself guarantees
  // any queued drain runs before-or-after us, never mid-operation.
  return withFileLock(path, async () => {
    try {
      const raw = await readTextFile(path);
      const lines = raw.trimEnd().split('\n');
      let replaced = false;
      for (let i = 0; i < lines.length; i++) {
        // Cheap pre-check: only parse lines that contain the id substring
        if (!lines[i].includes(`"${message.id}"`)) continue;
        try {
          const parsed = JSON.parse(lines[i]) as Message;
          if (parsed.id === message.id) {
            lines[i] = JSON.stringify(stripForDisk(message));
            replaced = true;
            break;
          }
        } catch {
          // Skip corrupt line
        }
      }

      if (replaced) {
        await atomicWrite(path, lines.join('\n') + '\n');
        writtenIds.add(message.id);
      }
    } catch {
      // Non-critical: leave the file as-is. Worst case the message disk state lags behind memory.
    }
  });
}

/**
 * Replace the last line in the JSONL file.
 * Used when streaming completes or tool results are added.
 */
export async function updateLastMessage(
  convId: string,
  message: Message,
): Promise<void> {
  await ensureBase();
  const path = messagesPath(convId);
  if (!(await exists(path))) return;

  // Serialize with concurrent drain / replaceMessageById on the same path.
  // Like replaceMessageById, we do not pre-flush — the lock does the job
  // without the deadlock risk of flushWrites re-acquiring.
  let updated = false;
  try {
    await withFileLock(path, async () => {
      const raw = await readTextFile(path);
      const lines = raw.trimEnd().split('\n');
      lines[lines.length - 1] = JSON.stringify(stripForDisk(message));
      await atomicWrite(path, lines.join('\n') + '\n');
      writtenIds.add(message.id);
      updated = true;
    });
  } catch {
    // Swallow: fall through to append-fallback below
  }
  if (!updated) {
    // If the in-lock update failed, appendMessage is a safer recovery — it
    // re-uses the same lock internally so ordering is still preserved.
    writtenIds.delete(message.id);
    await appendMessage(convId, message);
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

  // Per-line parse failures are tolerated: skip the bad line, keep the rest.
  // Previously we .map()'d + caught the whole block, which meant any single
  // corrupt line nuked the entire conversation for the UI even though most
  // lines were fine. This is pure damage reduction for a storage bug we
  // eventually need to fix on the write side (see conversationStorage write
  // race / TODO in Task #15 follow-up).
  const lines = raw.trimEnd().split('\n').filter((l) => l.length > 0);
  const messages: Message[] = [];
  let corruptCount = 0;
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      corruptCount++;
    }
  }
  if (corruptCount > 0) {
    console.warn(
      `[conversationStorage] loadMessages(${convId}): skipped ${corruptCount}/${lines.length} corrupt line(s). ` +
        `The affected messages are lost, but ${messages.length} intact message(s) recovered.`,
    );
  }
  populateWrittenIds(messages);
  return messages;
}

/**
 * Delete all files for a conversation (messages, outputs, results).
 * Also cleans up the legacy sessions/ path from pre-migration data.
 */
export async function deleteConversationFiles(convId: string): Promise<void> {
  await ensureBase();
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
  imChannelId?: string;
  imPlatform?: string;
  scheduledTaskId?: string;
  triggerId?: string;
  projectId?: string;
}): ConversationMeta {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    workspacePath: conv.workspacePath,
    imChannelId: conv.imChannelId,
    imPlatform: conv.imPlatform,
    scheduledTaskId: conv.scheduledTaskId,
    triggerId: conv.triggerId,
    projectId: conv.projectId,
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
  await flushWrites();
  await flushIndex();
}
