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
 *   loop normal end       → clearCheckpoint()
 *   loop abort / error    → clearCheckpoint()
 *   app startup           → findOrphanedCheckpoints() → show recovery UI
 */

import { exists, readTextFile, writeTextFile, remove, readDir } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';

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

let cachedBase: string | null = null;

async function getConversationsDir(): Promise<string> {
  if (!cachedBase) {
    const appData = await appDataDir();
    cachedBase = joinPath(appData, 'conversations');
  }
  return cachedBase;
}

async function checkpointPath(convId: string): Promise<string> {
  const base = await getConversationsDir();
  return joinPath(base, convId, 'checkpoint.json');
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
      const { mkdir } = await import('@tauri-apps/plugin-fs');
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

/**
 * Scan for orphaned checkpoints left by crashed sessions.
 * Call once on app startup.
 *
 * Returns checkpoints younger than 1 hour.
 * Older ones are auto-cleaned.
 */
export async function findOrphanedCheckpoints(): Promise<Checkpoint[]> {
  const base = await getConversationsDir();
  if (!(await exists(base))) return [];

  const orphans: Checkpoint[] = [];

  try {
    const entries = await readDir(base);
    for (const entry of entries) {
      // Only check directories (conversation folders)
      if (!entry.isDirectory || !entry.name) continue;

      const cpPath = joinPath(base, entry.name, 'checkpoint.json');
      if (!(await exists(cpPath))) continue;

      try {
        const raw = await readTextFile(cpPath);
        const cp = JSON.parse(raw) as Checkpoint;

        if (Date.now() - cp.timestamp > MAX_CHECKPOINT_AGE_MS) {
          // Too old — clean up silently
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
