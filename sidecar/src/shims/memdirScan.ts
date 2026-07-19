/**
 * Sidecar-local replacement for `src/core/memdir/scan.ts`.
 *
 * See `memdirPaths.ts`'s module doc for why this shim exists (a dynamic
 * `import('../memdir/scan')` inside `subagentLoop.ts`'s memory-injection
 * step, not caught by the P1-3a-pre static-import inventory).
 *
 * Only `scanMemoryFiles` and `loadMemoryIndex` are implemented — the only
 * two names `subagentLoop.ts` actually destructures from the dynamic
 * import (`const { scanMemoryFiles, loadMemoryIndex } = await
 * import('../memdir/scan')`). `scanMemoryFilesCached` /
 * `invalidateScanCache` / `readMemoryFile` / `formatMemoryManifest` /
 * `_resetScanCache` are NOT reachable from that call site and are
 * intentionally omitted rather than speculatively duplicated — this shim
 * only needs to satisfy what's actually imported at runtime (esbuild
 * doesn't structurally type-check a shim redirect against the real
 * module's full export surface).
 *
 * `@tauri-apps/plugin-fs`'s `readDir`/`readTextFile`/`stat` are replaced
 * with `node:fs/promises` equivalents — same semantic mapping already
 * established by `fsHost.ts` for the P1-2a fs bridge (see that file's
 * module doc): `readdir(dir, { withFileTypes: true })` for `readDir`,
 * `readFile(path, 'utf-8')` for `readTextFile`, `stat(path)` for `stat`
 * (both follow symlinks, matching plugin-fs's `stat()`).
 *
 * Parsing logic (`parseFrontmatter`/`parseBoolField`/`VALID_TYPES`/
 * `VALID_SOURCES`) is copied verbatim from the real `scan.ts` — pure string
 * logic, zero fs dependency, so there was never a reason to reimplement it
 * differently.
 */
import * as fs from 'node:fs/promises';
import type { MemoryHeader, MemoryType, MemorySource } from '@/core/memdir/types';
import { MEMORY_INDEX_FILENAME, MAX_MEMORY_FILES } from '@/core/memdir/types';
import { getMemoryDir, joinPath } from './memdirPaths';

const VALID_TYPES: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference']);
const VALID_SOURCES: ReadonlySet<string> = new Set(['agent_explicit', 'auto_flush', 'user_manual']);

/** Verbatim copy of scan.ts's parseBoolField. */
function parseBoolField(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === 'true' || t === 'yes' || t === '1';
}

/** Verbatim copy of scan.ts's parseFrontmatter. */
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

export async function scanMemoryFiles(workspacePath?: string | null): Promise<MemoryHeader[]> {
  const dir = await getMemoryDir(workspacePath);

  let dirEntries;
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // Directory doesn't exist yet
  }

  const mdFiles = dirEntries.filter(
    (e) => e.name.endsWith('.md') && e.name !== MEMORY_INDEX_FILENAME && !e.isDirectory(),
  );

  const headers: MemoryHeader[] = [];

  for (const file of mdFiles.slice(0, MAX_MEMORY_FILES)) {
    const filePath = joinPath(dir, file.name);
    try {
      // Read only the first ~1KB for frontmatter (avoid loading full content)
      const raw = await fs.readFile(filePath, 'utf-8');
      const preview = raw.slice(0, 1024);
      const fm = parseFrontmatter(preview);

      if (!fm.name) continue; // Skip files without valid frontmatter

      // Fallback: use file stat for timestamps if frontmatter missing them
      let created = Number(fm.created) || 0;
      let updated = Number(fm.updated) || 0;
      if (!created || !updated) {
        try {
          const s = await fs.stat(filePath);
          if (!created && s.mtime) created = s.mtime.getTime();
          if (!updated && s.mtime) updated = s.mtime.getTime();
        } catch { /* ignore stat errors */ }
      }

      headers.push({
        filename: file.name,
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

export async function loadMemoryIndex(workspacePath?: string | null): Promise<string> {
  const dir = await getMemoryDir(workspacePath);
  const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
  try {
    return await fs.readFile(indexPath, 'utf-8');
  } catch {
    return '';
  }
}
