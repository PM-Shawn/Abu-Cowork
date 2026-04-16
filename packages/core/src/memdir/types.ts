/**
 * Memdir Types — file-based persistent memory system (aligned with Claude Code).
 *
 * Each memory is a standalone .md file with YAML frontmatter:
 *   ~/.abu/memory/              — global memories (no workspace)
 *   ~/.abu/projects/<key>/memory/ — per-workspace memories
 *
 * MEMORY.md in each directory is the index (always injected into system prompt).
 */

/** Memory type taxonomy (4 types, aligned with CC) */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** How this memory was created */
export type MemorySource = 'agent_explicit' | 'auto_flush' | 'user_manual';

/**
 * YAML frontmatter parsed from a memory .md file.
 *
 * ```yaml
 * ---
 * name: Avoid force-deleting files
 * description: User requires confirmation before any delete operation
 * type: feedback
 * source: agent_explicit
 * created: 1712000000000
 * updated: 1712000000000
 * accessCount: 3
 * ---
 * ```
 */
export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  created: number;
  updated: number;
  accessCount: number;
}

/**
 * Lightweight header returned by scan (no body content loaded).
 * Used for index listing, relevance scoring, and manifest display.
 */
export interface MemoryHeader {
  /** Filename relative to memory directory (e.g. "feedback_no_delete.md") */
  filename: string;
  /** Absolute path on disk */
  filePath: string;
  /** Parsed frontmatter fields */
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  created: number;
  updated: number;
  accessCount: number;
}

/**
 * Full memory file: header + body content.
 */
export interface MemoryFile extends MemoryHeader {
  /** Markdown body (everything after the frontmatter) */
  content: string;
}

/** Constraints */
export const MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25_000;
export const MAX_MEMORY_FILES = 200;
export const MAX_MEMORY_FILE_BYTES = 4_000;

/** Filename-safe ID generator (same convention as the rest of Abu) */
export function generateMemoryId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/**
 * Generate a filesystem-safe filename from type + name.
 * Example: "feedback", "no force delete" → "feedback_no_force_delete.md"
 */
export function toMemoryFilename(type: MemoryType, name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')  // allow CJK chars
    .replace(/^_|_$/g, '')
    .slice(0, 60);
  return `${type}_${safe || generateMemoryId()}.md`;
}
