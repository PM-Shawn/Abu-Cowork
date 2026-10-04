/**
 * Checkpoint — crash recovery for the agent loop.
 *
 * Writes a small JSON file before each LLM call / tool execution.
 * On app restart, orphaned checkpoints indicate interrupted conversations
 * that the user may want to resume.
 *
 * Lifecycle:
 *   agentLoop turn start  → writeCheckpoint({ status: 'llm_calling' })
 *   tool execution start  → writeCheckpoint({ status: 'tool_executing' })
 *   loop normal end       → clearCheckpointForLoop()
 *   loop abort / error    → clearCheckpointForLoop()
 *   (the unguarded clearCheckpoint() is for callers that own no loopId,
 *    e.g. discarding recovery for a conversation from the startup UI —
 *    loop teardown must use the guarded variant, because teardown can
 *    outlive the turn and the next turn may already own the conversation)
 *   app startup           → findOrphanedCheckpoints() → show recovery UI
 */

import { exists, readTextFile, writeTextFile, remove, readDir, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { createConversationPaths, isConversationId, type ConversationPaths } from './conversationPaths';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════

export interface Checkpoint {
  conversationId: string;
  loopId: string;
  turnCount: number;
  lastMessageId: string;
  status: 'llm_calling' | 'tool_executing';
  currentTool?: string;
  timestamp: number;
  model?: string;
  workspacePath?: string;
}

// ════════════════════════════════════════════════════════════
// Paths
// ════════════════════════════════════════════════════════════

let cachedPaths: ConversationPaths | null = null;

async function conversationPaths(): Promise<ConversationPaths> {
  if (!cachedPaths) {
    cachedPaths = createConversationPaths(await appDataDir());
  }
  return cachedPaths;
}

async function checkpointPath(convId: string): Promise<string> {
  return (await conversationPaths()).checkpointPath(convId);
}

// ════════════════════════════════════════════════════════════
// Write / Clear
// ════════════════════════════════════════════════════════════

/**
 * Write a checkpoint file. Called before LLM calls and tool execution.
 * Errors are silently ignored — checkpoint loss is acceptable.
 */
export async function writeCheckpoint(cp: Checkpoint): Promise<void> {
  try {
    const path = await checkpointPath(cp.conversationId);
    // Ensure directory exists
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    await writeTextFile(path, JSON.stringify(cp));
  } catch {
    // Non-critical — worst case is no recovery hint on crash
  }
}

/**
 * Clear the checkpoint file. Called on normal loop completion, abort, or error.
 */
export async function clearCheckpoint(convId: string): Promise<void> {
  try {
    const path = await checkpointPath(convId);
    if (await exists(path)) {
      await remove(path);
    }
  } catch {
    // Non-critical
  }
}

/**
 * Clear the checkpoint only while it still belongs to `loopId`.
 *
 * A run's teardown can outlive its own visible terminal (see
 * `agentLoopRunner.ts`'s `RunSession.terminalPublished`), so by the time this
 * fire-and-forget cleanup runs, the next turn may already own the
 * conversation — and checkpoints are keyed by conversation, not by loop.
 * Deleting unconditionally there would strip the LIVE turn of its crash
 * recovery. Reading first costs one extra file read on a path that is already
 * best-effort.
 */
export async function clearCheckpointForLoop(convId: string, loopId: string): Promise<void> {
  try {
    const path = await checkpointPath(convId);
    if (!(await exists(path))) return;
    const current = JSON.parse(await readTextFile(path)) as Checkpoint;
    if (current.loopId !== loopId) return;
    await remove(path);
  } catch {
    // Non-critical — an unreadable/corrupt checkpoint is left for the startup
    // orphan scan, which already handles stale entries.
  }
}

// ════════════════════════════════════════════════════════════
// Orphan detection (startup scan)
// ════════════════════════════════════════════════════════════

/** Checkpoints older than this are auto-cleaned (1 hour) */
const MAX_CHECKPOINT_AGE_MS = 60 * 60 * 1000;

function isRecoverableCheckpoint(value: unknown, directoryId: string, now: number): value is Checkpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cp = value as Record<string, unknown>;
  return cp.conversationId === directoryId
    && typeof cp.loopId === 'string' && cp.loopId.trim().length > 0
    && typeof cp.lastMessageId === 'string' && cp.lastMessageId.trim().length > 0
    && typeof cp.turnCount === 'number' && Number.isSafeInteger(cp.turnCount) && cp.turnCount >= 0
    && (cp.status === 'llm_calling' || cp.status === 'tool_executing')
    && typeof cp.timestamp === 'number' && Number.isSafeInteger(cp.timestamp)
    && cp.timestamp >= 0 && cp.timestamp <= now && now - cp.timestamp <= MAX_CHECKPOINT_AGE_MS
    && ['currentTool', 'model', 'workspacePath'].every((field) => cp[field] === undefined || typeof cp[field] === 'string');
}

/**
 * Scan for orphaned checkpoints left by crashed sessions.
 * Call once on app startup.
 *
 * Returns checkpoints younger than 1 hour.
 * Older ones are auto-cleaned.
 */
export async function findOrphanedCheckpoints(): Promise<Checkpoint[]> {
  const paths = await conversationPaths();
  if (!(await exists(paths.root))) return [];

  const orphans: Checkpoint[] = [];

  try {
    const entries = await readDir(paths.root);
    for (const entry of entries) {
      // Only check directories (conversation folders), and only those whose
      // name is a conversation id: no other directory can hold a checkpoint
      // this scan is able to attribute, and the builder below refuses one.
      if (!entry.isDirectory || !entry.name || !isConversationId(entry.name)) continue;

      const cpPath = paths.checkpointPath(entry.name);
      if (!(await exists(cpPath))) continue;

      try {
        const raw = await readTextFile(cpPath);
        const cp: unknown = JSON.parse(raw);

        if (!isRecoverableCheckpoint(cp, entry.name, Date.now())) {
          // Invalid, mismatched, future or stale: remove the SCANNED file,
          // never a path derived from untrusted checkpoint contents.
          await remove(cpPath).catch(() => {});
        } else {
          orphans.push(cp);
        }
      } catch {
        // Corrupt checkpoint — clean up
        await remove(cpPath).catch(() => {});
      }
    }
  } catch {
    // Directory read failed — no orphans to report
  }

  return orphans;
}
