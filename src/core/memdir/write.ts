/**
 * Memdir Write — write memory files and maintain MEMORY.md index.
 *
 * Two-step write process (aligned with CC):
 *   1. Write the .md file with frontmatter + content
 *   2. Update MEMORY.md index to include a pointer to the new file
 *
 * All writes use a per-directory mutex to prevent concurrent corruption.
 */

import { readTextFile, remove } from '@tauri-apps/plugin-fs';
import { exists } from '@tauri-apps/plugin-fs';
import { atomicWrite } from '../../utils/atomicFs';
import { ensureParentDir, joinPath } from '../../utils/pathUtils';
import { scanContent, evaluate, ContentSafetyError } from '../safety/contentGuard';
import { getMemoryDir } from './paths';
import { scanMemoryFiles } from './scan';
import type { MemoryType, MemorySource, MemoryHeader } from './types';
import {
  MEMORY_INDEX_FILENAME,
  MAX_INDEX_LINES,
  MAX_MEMORY_FILES,
  toMemoryFilename,
} from './types';

// ── Write mutex: serialize all writes per directory ──

const writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(dir) ?? Promise.resolve();
  let releaseLock: () => void;
  const next = new Promise<void>((resolve) => { releaseLock = resolve; });
  writeLocks.set(dir, next);
  await prev;
  try {
    return await fn();
  } finally {
    releaseLock!();
  }
}

// ── Frontmatter serialization ──

function buildFileContent(
  name: string,
  description: string,
  type: MemoryType,
  source: MemorySource,
  content: string,
  created?: number,
  updated?: number,
  accessCount?: number,
): string {
  const now = Date.now();
  return `---
name: ${name}
description: ${description}
type: ${type}
source: ${source}
created: ${created ?? now}
updated: ${updated ?? now}
accessCount: ${accessCount ?? 0}
---

${content}
`;
}

// ── MEMORY.md index management ──

/**
 * Rebuild the MEMORY.md index from the current set of memory files.
 * Format: `- [filename](filename) — description`
 */
async function rebuildIndex(dir: string, headers: MemoryHeader[]): Promise<void> {
  const lines = ['# Memory Index', ''];
  for (const h of headers.slice(0, MAX_INDEX_LINES - 2)) {
    lines.push(`- [${h.filename}](${h.filename}) — ${h.description}`);
  }
  const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
  await atomicWrite(indexPath, lines.join('\n') + '\n');
}

/**
 * Add a line to MEMORY.md for a new memory file.
 * If the index doesn't exist, creates it.
 * If it exceeds MAX_INDEX_LINES, rebuilds from scratch.
 */
async function addToIndex(dir: string, filename: string, description: string): Promise<void> {
  const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
  let content: string;
  try {
    content = await readTextFile(indexPath);
  } catch {
    content = '# Memory Index\n';
  }

  const newLine = `- [${filename}](${filename}) — ${description}`;
  const lines = content.split('\n');

  // Check if already in index (idempotent)
  if (lines.some(l => l.includes(`[${filename}]`))) {
    // Update the existing line
    const updated = lines.map(l =>
      l.includes(`[${filename}]`) ? newLine : l
    );
    await atomicWrite(indexPath, updated.join('\n'));
    return;
  }

  lines.push(newLine);

  // Enforce line limit
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length > MAX_INDEX_LINES) {
    // Rebuild from disk scan to drop stale entries
    const headers = await scanMemoryFiles(); // will be called within lock context
    await rebuildIndex(dir, headers);
    return;
  }

  await atomicWrite(indexPath, lines.join('\n'));
}

/**
 * Remove a file entry from MEMORY.md index.
 */
async function removeFromIndex(dir: string, filename: string): Promise<void> {
  const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
  try {
    const content = await readTextFile(indexPath);
    const lines = content.split('\n');
    const filtered = lines.filter(l => !l.includes(`[${filename}]`));
    await atomicWrite(indexPath, filtered.join('\n'));
  } catch {
    // Index doesn't exist — nothing to remove
  }
}

// ── Public API ──

export interface WriteMemoryOptions {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  source?: MemorySource;
  workspacePath?: string | null;
  /** Override filename (for updates) */
  filename?: string;
  /**
   * Skip the contentGuard safety scan.
   *
   * Intended for grandfathering historical data during migration, where
   * old entries predate the scanner and blocking them would strand the
   * user's existing memory. **DO NOT** use for agent-originated writes —
   * those must always be scanned.
   */
  bypassScan?: boolean;
}

/**
 * Write a new memory file and update the index.
 * Returns the filename of the created file.
 */
export async function writeMemory(options: WriteMemoryOptions): Promise<string> {
  const {
    name,
    description,
    type,
    content,
    source = 'agent_explicit',
    workspacePath,
    filename: overrideFilename,
    bypassScan = false,
  } = options;

  // Safety scan before any disk I/O. Memory content is injected into the
  // system prompt — a blocked injection pattern here is as bad as a prompt
  // injection attack, so we fail fast.
  //
  // Scanner can be disabled entirely via `settings.safety.enableContentGuard`
  // (kill switch — no UI, JSON only), and individual pattern IDs can be
  // allow-listed via `settings.safety.bypass`. Lazy-import settings to avoid
  // a module cycle on cold start (memdir is used during settingsStore
  // rehydration in some edge cases).
  if (!bypassScan) {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    const safety = useSettingsStore.getState().safety;
    if (safety.enableContentGuard) {
      const scan = scanContent(content, { bypass: new Set(safety.bypass) });
      if (evaluate(scan, 'memory') === 'block') {
        throw new ContentSafetyError(scan, 'memory');
      }
    }
  }

  const dir = await getMemoryDir(workspacePath);

  return withWriteLock(dir, async () => {
    // Evict if at capacity
    const existing = await scanMemoryFiles(workspacePath);
    if (existing.length >= MAX_MEMORY_FILES && !overrideFilename) {
      // Evict the least-recently-updated file. accessCount is no longer
      // factored in: under the pull-based recall model it only counts real
      // recall-tool hits, so it is too sparse to be a reliable signal at
      // eviction time and historically produced the wrong outcome (delete
      // brand-new accessCount=0 memories before stale high-count ones).
      const sorted = [...existing].sort((a, b) => a.updated - b.updated);
      const evictTarget = sorted[0];
      if (evictTarget) {
        await remove(evictTarget.filePath).catch(() => {});
        await removeFromIndex(dir, evictTarget.filename);
      }
    }

    const filename = overrideFilename || toMemoryFilename(type, name);
    const filePath = joinPath(dir, filename);
    await ensureParentDir(filePath);

    const fileContent = buildFileContent(name, description, type, source, content);
    await atomicWrite(filePath, fileContent);
    await addToIndex(dir, filename, description);

    return filename;
  });
}

/**
 * Update an existing memory file's frontmatter (e.g. bump accessCount or updated time).
 */
export async function touchMemory(filePath: string): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));

  return withWriteLock(dir, async () => {
    try {
      const raw = await readTextFile(filePath);
      // Parse and bump accessCount + updated
      const updated = raw.replace(
        /^(accessCount:\s*)(\d+)/m,
        (_, prefix, count) => `${prefix}${Number(count) + 1}`,
      ).replace(
        /^(updated:\s*)(\d+)/m,
        () => `updated: ${Date.now()}`,
      );
      await atomicWrite(filePath, updated);
    } catch {
      // File may have been deleted
    }
  });
}

/**
 * Delete a memory file and remove it from the index.
 */
export async function deleteMemory(
  filename: string,
  workspacePath?: string | null,
): Promise<void> {
  const dir = await getMemoryDir(workspacePath);

  return withWriteLock(dir, async () => {
    const filePath = joinPath(dir, filename);
    if (await exists(filePath)) {
      await remove(filePath);
    }
    await removeFromIndex(dir, filename);
  });
}

/**
 * Clear all memory files and the index in a directory.
 */
export async function clearAllMemories(workspacePath?: string | null): Promise<number> {
  const dir = await getMemoryDir(workspacePath);

  return withWriteLock(dir, async () => {
    const headers = await scanMemoryFiles(workspacePath);
    let count = 0;
    for (const h of headers) {
      try {
        await remove(h.filePath);
        count++;
      } catch { /* ignore */ }
    }
    // Clear the index
    const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
    try {
      await atomicWrite(indexPath, '# Memory Index\n');
    } catch { /* ignore */ }
    return count;
  });
}
