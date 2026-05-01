/**
 * Memdir Scan — scan memory directory for .md files and parse frontmatter.
 *
 * Returns MemoryHeader[] sorted by updated time (newest first), capped at MAX_MEMORY_FILES.
 * MEMORY.md (the index) is excluded from scan results.
 */

import { readDir, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { joinPath } from '../../utils/pathUtils';
import type { MemoryHeader, MemoryType, MemorySource } from './types';
import { MEMORY_INDEX_FILENAME, MAX_MEMORY_FILES } from './types';
import { getMemoryDir } from './paths';

const VALID_TYPES: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference']);
const VALID_SOURCES: ReadonlySet<string> = new Set(['agent_explicit', 'auto_flush', 'user_manual']);

/** Truthy YAML scalars for boolean fields. Missing / falsy → false. */
function parseBoolField(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === 'true' || t === 'yes' || t === '1';
}

/**
 * Parse YAML frontmatter from the first N lines of a file.
 * Lightweight parser — no external YAML library needed since our frontmatter
 * is flat key-value pairs only.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const result: Record<string, string> = {};
  for (let i = 1; i < Math.min(lines.length, 30); i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

/**
 * Scan a memory directory and return headers for all memory files.
 * Excludes MEMORY.md (the index file).
 */
export async function scanMemoryFiles(workspacePath?: string | null): Promise<MemoryHeader[]> {
  const dir = await getMemoryDir(workspacePath);

  let dirEntries;
  try {
    dirEntries = await readDir(dir);
  } catch {
    return []; // Directory doesn't exist yet
  }

  const mdFiles = dirEntries.filter(
    (e) => e.name?.endsWith('.md') && e.name !== MEMORY_INDEX_FILENAME && !e.isDirectory,
  );

  const headers: MemoryHeader[] = [];

  for (const file of mdFiles.slice(0, MAX_MEMORY_FILES)) {
    const filePath = joinPath(dir, file.name!);
    try {
      // Read only the first ~1KB for frontmatter (avoid loading full content)
      const raw = await readTextFile(filePath);
      const preview = raw.slice(0, 1024);
      const fm = parseFrontmatter(preview);

      if (!fm.name) continue; // Skip files without valid frontmatter

      // Fallback: use file stat for timestamps if frontmatter missing them
      let created = Number(fm.created) || 0;
      let updated = Number(fm.updated) || 0;
      if (!created || !updated) {
        try {
          const s = await stat(filePath);
          if (!created && s.mtime) created = s.mtime.getTime();
          if (!updated && s.mtime) updated = s.mtime.getTime();
        } catch { /* ignore stat errors */ }
      }

      headers.push({
        filename: file.name!,
        filePath,
        name: fm.name,
        description: fm.description || fm.name,
        type: VALID_TYPES.has(fm.type) ? (fm.type as MemoryType) : 'project',
        source: VALID_SOURCES.has(fm.source) ? (fm.source as MemorySource) : 'user_manual',
        created: created || Date.now(),
        updated: updated || Date.now(),
        accessCount: Number(fm.accessCount) || 0,
        private: parseBoolField(fm.private),
      });
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by updated time (newest first)
  headers.sort((a, b) => b.updated - a.updated);
  return headers;
}

// ── In-memory scan cache ──
//
// scanMemoryFiles() does N+1 fs reads (one per .md file). For Phase 2
// relevant-memory injection it runs every turn — caching avoids paying that
// per turn while the memory set is unchanged. TTL is short enough that
// stale reads after manual file edits self-heal within minutes; write paths
// (writeMemory / deleteMemory / clearAllMemories) actively invalidate to
// avoid showing pre-write state to the next turn.
//
// Per `feedback_ttl_cache_needs_caller.md`: TTL caches must have a sync
// invalidation path. invalidateScanCache() is exported and called by write.ts.

const SCAN_TTL_MS = 5 * 60 * 1000;
const scanCache = new Map<string, { headers: MemoryHeader[]; expiresAt: number }>();

function cacheKey(workspacePath: string | null | undefined): string {
  return workspacePath ?? '__global__';
}

/**
 * Cached variant of scanMemoryFiles. Use this from hot paths (per-turn
 * injection); use the raw scanMemoryFiles when freshness matters more
 * than latency (settings UI, manual refresh).
 */
export async function scanMemoryFilesCached(workspacePath?: string | null): Promise<MemoryHeader[]> {
  const key = cacheKey(workspacePath);
  const cached = scanCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.headers;
  }
  const headers = await scanMemoryFiles(workspacePath);
  scanCache.set(key, { headers, expiresAt: Date.now() + SCAN_TTL_MS });
  return headers;
}

/**
 * Drop the cached headers for a workspace (or global). Called by write
 * operations so the next read sees the updated set.
 */
export function invalidateScanCache(workspacePath?: string | null): void {
  scanCache.delete(cacheKey(workspacePath));
}

/** Test-only: clear the entire cache. */
export function _resetScanCache(): void {
  scanCache.clear();
}

/**
 * Read a single memory file fully (header + body content).
 */
export async function readMemoryFile(filePath: string): Promise<{ header: MemoryHeader; content: string } | null> {
  try {
    const raw = await readTextFile(filePath);
    const fm = parseFrontmatter(raw);
    if (!fm.name) return null;

    // Extract body: everything after the closing ---
    const lines = raw.split('\n');
    let bodyStart = 0;
    if (lines[0]?.trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
          bodyStart = i + 1;
          break;
        }
      }
    }
    const content = lines.slice(bodyStart).join('\n').trim();

    const filename = filePath.split('/').pop() || '';

    return {
      header: {
        filename,
        filePath,
        name: fm.name,
        description: fm.description || fm.name,
        type: VALID_TYPES.has(fm.type) ? (fm.type as MemoryType) : 'project',
        source: VALID_SOURCES.has(fm.source) ? (fm.source as MemorySource) : 'user_manual',
        created: Number(fm.created) || Date.now(),
        updated: Number(fm.updated) || Date.now(),
        accessCount: Number(fm.accessCount) || 0,
        private: parseBoolField(fm.private),
      },
      content,
    };
  } catch {
    return null;
  }
}

/**
 * Load the MEMORY.md index content.
 * Returns empty string if the file doesn't exist.
 */
export async function loadMemoryIndex(workspacePath?: string | null): Promise<string> {
  const dir = await getMemoryDir(workspacePath);
  const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
  try {
    return await readTextFile(indexPath);
  } catch {
    return '';
  }
}

/**
 * Format a manifest of memory files for display or LLM context.
 * Example: "- [feedback] no_force_delete.md (2026-04-09): User requires confirmation before delete"
 */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const date = new Date(h.updated).toISOString().split('T')[0];
      return `- [${h.type}] ${h.filename} (${date}): ${h.description}`;
    })
    .join('\n');
}
