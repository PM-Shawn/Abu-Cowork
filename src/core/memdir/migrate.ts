/**
 * Memdir Migration — one-time migration from old memory systems to file-based memdir.
 *
 * Migrates from:
 *   1. Structured entries: ~/.abu/memory/entries.json (user scope)
 *   2. Structured entries: {workspace}/.abu/memory/entries.json (project scope)
 *   3. Legacy flat file: ~/.abu/agents/abu/memory.md
 *   4. Legacy flat file: {workspace}/.abu/MEMORY.md
 *
 * Category mapping (7 → 4):
 *   user_preference     → user
 *   feedback            → feedback
 *   project_knowledge   → project
 *   conversation_fact   → project
 *   decision            → project
 *   action_item         → project
 *   conversation_index  → SKIPPED (internal, not user-facing)
 *
 * Old files are preserved (not deleted) as backup.
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { writeMemory } from './write';
import { scanMemoryFiles } from './scan';
import type { MemoryType, MemorySource } from './types';

let migrated = false;

/** Old structured entry shape (from localBackend.ts) */
interface OldEntry {
  id: string;
  category: string;
  summary: string;
  content: string;
  keywords: string[];
  sourceType: string;
  scope: 'user' | 'project';
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
}

/** Map old 7-category to new 4-type */
function mapCategory(category: string): MemoryType | null {
  switch (category) {
    case 'user_preference': return 'user';
    case 'feedback': return 'feedback';
    case 'project_knowledge': return 'project';
    case 'conversation_fact': return 'project';
    case 'decision': return 'project';
    case 'action_item': return 'project';
    case 'conversation_index': return null; // Skip
    default: return 'project';
  }
}

function mapSource(sourceType: string): MemorySource {
  switch (sourceType) {
    case 'agent_explicit': return 'agent_explicit';
    case 'auto_flush': return 'auto_flush';
    case 'user_manual': return 'user_manual';
    default: return 'user_manual';
  }
}

/**
 * Try to read and parse entries.json from a given path.
 * Returns empty array if file doesn't exist or is invalid.
 */
async function loadOldEntries(path: string): Promise<OldEntry[]> {
  try {
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Migrate old structured entries to memdir .md files.
 */
async function migrateEntries(
  entries: OldEntry[],
  workspacePath?: string | null,
): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    const type = mapCategory(entry.category);
    if (!type) continue; // Skip conversation_index

    try {
      await writeMemory({
        name: entry.summary.slice(0, 80),
        description: entry.summary,
        type,
        content: entry.content,
        source: mapSource(entry.sourceType),
        workspacePath,
        // Grandfather clause: legacy entries predate the content scanner.
        // Blocking them would strand the user's existing memory, which is
        // worse than the residual risk of keeping already-persisted data.
        bypassScan: true,
      });
      count++;
    } catch (err) {
      console.warn(`[Memdir] Failed to migrate entry "${entry.summary}":`, err);
    }
  }
  return count;
}

/**
 * Migrate a legacy flat-file memory (memory.md or MEMORY.md) as a single entry.
 */
async function migrateFlatFile(
  filePath: string,
  workspacePath?: string | null,
): Promise<boolean> {
  try {
    const content = await readTextFile(filePath);
    if (!content.trim()) return false;

    await writeMemory({
      name: '从旧版记忆迁移的内容',
      description: '旧版记忆文件的完整内容，已迁移到新系统',
      type: 'project',
      content: content.trim(),
      source: 'user_manual',
      workspacePath,
      // Grandfather: legacy flat-file entry predates the content scanner.
      bypassScan: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run migration if needed. Safe to call multiple times — only runs once.
 *
 * Migration logic:
 *   1. Check if new memdir already has files (skip if yes)
 *   2. Migrate global entries.json → ~/.abu/memory/*.md
 *   3. Migrate legacy ~/.abu/agents/abu/memory.md → ~/.abu/memory/*.md
 *
 * Note: per-workspace migration happens lazily when the workspace is opened,
 * not at startup (we don't know all workspace paths upfront).
 */
export async function migrateMemdirIfNeeded(): Promise<void> {
  if (migrated) return;
  migrated = true;

  try {
    // Check if new memdir already has files (skip if so)
    const existing = await scanMemoryFiles(null);
    if (existing.length > 0) return;

    const home = await homeDir();
    let totalMigrated = 0;

    // 1. Migrate global entries.json
    const globalEntriesPath = joinPath(home, '.abu', 'memory', 'entries.json');
    const globalEntries = await loadOldEntries(globalEntriesPath);
    if (globalEntries.length > 0) {
      const count = await migrateEntries(globalEntries, null);
      totalMigrated += count;
      console.log(`[Memdir] Migrated ${count} global entries from entries.json`);
    }

    // 2. Migrate legacy agent memory.md
    const legacyPath = joinPath(home, '.abu', 'agents', 'abu', 'memory.md');
    if (await migrateFlatFile(legacyPath, null)) {
      totalMigrated++;
      console.log('[Memdir] Migrated legacy agents/abu/memory.md');
    }

    if (totalMigrated > 0) {
      console.log(`[Memdir] Global migration complete: ${totalMigrated} memories`);
    }
  } catch (err) {
    console.warn('[Memdir] Migration failed (non-critical):', err);
  }
}

/**
 * Migrate per-workspace memories. Called when a workspace is opened.
 * Checks both entries.json and legacy MEMORY.md in the workspace.
 */
export async function migrateWorkspaceIfNeeded(workspacePath: string): Promise<void> {
  try {
    // Check if already migrated for this workspace
    const existing = await scanMemoryFiles(workspacePath);
    if (existing.length > 0) return;

    let totalMigrated = 0;

    // 1. Migrate workspace entries.json
    const entriesPath = joinPath(workspacePath, '.abu', 'memory', 'entries.json');
    const entries = await loadOldEntries(entriesPath);
    if (entries.length > 0) {
      const count = await migrateEntries(entries, workspacePath);
      totalMigrated += count;
    }

    // 2. Migrate legacy workspace MEMORY.md
    const legacyPath = joinPath(workspacePath, '.abu', 'MEMORY.md');
    if (await migrateFlatFile(legacyPath, workspacePath)) {
      totalMigrated++;
    }

    if (totalMigrated > 0) {
      console.log(`[Memdir] Workspace migration complete (${workspacePath}): ${totalMigrated} memories`);
    }
  } catch (err) {
    console.warn(`[Memdir] Workspace migration failed for ${workspacePath}:`, err);
  }
}

/**
 * Check if the new memdir exists for a given workspace.
 * Used to determine if migration is needed.
 */
export async function hasMemdirFiles(workspacePath?: string | null): Promise<boolean> {
  try {
    const headers = await scanMemoryFiles(workspacePath);
    return headers.length > 0;
  } catch {
    return false;
  }
}
