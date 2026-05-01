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
import { scanMemoryFiles, invalidateScanCache, _resetScanCache } from './scan';
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
  isPrivate?: boolean,
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
private: ${isPrivate ? 'true' : 'false'}
---

${content}
`;
}

// ── MEMORY.md index management ──

/**
 * Format an index line for a memory. Private memories get a 🔒 marker so the
 * agent can see they exist without their content being auto-injected by Phase 2.
 */
function formatIndexLine(filename: string, description: string, isPrivate: boolean): string {
  const lock = isPrivate ? ' 🔒' : '';
  return `- [${filename}](${filename})${lock} — ${description}`;
}

/**
 * Rebuild the MEMORY.md index from the current set of memory files.
 * Format: `- [filename](filename) — description` (private memories get a 🔒 marker)
 */
async function rebuildIndex(dir: string, headers: MemoryHeader[]): Promise<void> {
  const lines = ['# Memory Index', ''];
  for (const h of headers.slice(0, MAX_INDEX_LINES - 2)) {
    lines.push(formatIndexLine(h.filename, h.description, h.private));
  }
  const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
  await atomicWrite(indexPath, lines.join('\n') + '\n');
}

/**
 * Add a line to MEMORY.md for a new memory file.
 * If the index doesn't exist, creates it.
 * If it exceeds MAX_INDEX_LINES, rebuilds from scratch.
 */
async function addToIndex(
  dir: string,
  filename: string,
  description: string,
  isPrivate: boolean,
): Promise<void> {
  const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
  let content: string;
  try {
    content = await readTextFile(indexPath);
  } catch {
    content = '# Memory Index\n';
  }

  const newLine = formatIndexLine(filename, description, isPrivate);
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
   * Mark as private: excluded from per-turn relevant-memories injection.
   * Defaults to false. See MemoryFrontmatter.private for semantics.
   */
  private?: boolean;
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
    private: isPrivate = false,
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

    const fileContent = buildFileContent(
      name, description, type, source, content,
      undefined, undefined, undefined, isPrivate,
    );
    await atomicWrite(filePath, fileContent);
    await addToIndex(dir, filename, description, isPrivate);

    // Invalidate scan cache so the next per-turn injection sees fresh state.
    invalidateScanCache(workspacePath);

    return filename;
  });
}

/**
 * Update the `description` field on an existing memory file in-place, plus
 * the corresponding MEMORY.md index line. Body content is untouched, so we
 * skip the contentGuard re-scan.
 *
 * Used by the UI flow that nudges users to simplify a private memory's
 * description so it doesn't leak the value through the always-injected
 * MEMORY.md index. See PersonalMemorySection's privateDescHint.
 */
export async function setMemoryDescription(
  filename: string,
  newDescription: string,
  workspacePath?: string | null,
): Promise<void> {
  const dir = await getMemoryDir(workspacePath);
  const filePath = joinPath(dir, filename);

  return withWriteLock(dir, async () => {
    let raw: string;
    try {
      raw = await readTextFile(filePath);
    } catch {
      return;
    }

    // Replace the description line in frontmatter. Tolerates "description: x"
    // with any single-line value; multi-line YAML descriptions aren't supported
    // (we never write them).
    const updated = raw.replace(/^description:\s*.+$/m, `description: ${newDescription}`);
    await atomicWrite(filePath, updated);

    // Update the index line — read the file's current `private` state so we
    // preserve the 🔒 marker through the description rewrite.
    const isPrivateMatch = updated.match(/^private:\s*(\S+)/m);
    const isPrivate = !!isPrivateMatch && isPrivateMatch[1].trim().toLowerCase() === 'true';
    await addToIndex(dir, filename, newDescription, isPrivate);

    invalidateScanCache(workspacePath);
  });
}

/**
 * Toggle the `private` field on an existing memory file in-place. Cheaper than
 * a full rewrite (no contentGuard re-scan, body unchanged) and updates the
 * MEMORY.md index 🔒 marker atomically.
 */
export async function setMemoryPrivate(
  filename: string,
  isPrivate: boolean,
  workspacePath?: string | null,
): Promise<void> {
  const dir = await getMemoryDir(workspacePath);
  const filePath = joinPath(dir, filename);

  return withWriteLock(dir, async () => {
    let raw: string;
    try {
      raw = await readTextFile(filePath);
    } catch {
      return; // File missing — nothing to update
    }

    let updated: string;
    if (/^private:\s*\S+/m.test(raw)) {
      updated = raw.replace(/^private:\s*\S+/m, `private: ${isPrivate ? 'true' : 'false'}`);
    } else {
      // Inject the field before the closing `---` of frontmatter. The opening
      // `---` is at offset 0 and gets left alone; the second is the close.
      let firstSeen = false;
      updated = raw.replace(/^---\s*$/gm, (match) => {
        if (!firstSeen) {
          firstSeen = true;
          return match;
        }
        return `private: ${isPrivate ? 'true' : 'false'}\n${match}`;
      });
    }
    await atomicWrite(filePath, updated);

    // Re-render the index entry so the 🔒 marker matches the new state.
    // Read description from the (just-written) frontmatter so we don't drift.
    const descMatch = updated.match(/^description:\s*(.+)$/m);
    const description = descMatch ? descMatch[1].trim() : filename;
    await addToIndex(dir, filename, description, isPrivate);

    invalidateScanCache(workspacePath);
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
      // touchMemory mutates `updated`, which affects scan-result ordering.
      // We don't know from the path alone whether this lives in global or a
      // workspace dir, so blow the whole cache. Cheap: tiny key set.
      _resetScanCache();
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
    invalidateScanCache(workspacePath);
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
    invalidateScanCache(workspacePath);
    return count;
  });
}
