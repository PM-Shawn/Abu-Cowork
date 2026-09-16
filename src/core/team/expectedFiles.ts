import { exists } from '@/core/tools/fsBridge';

/**
 * "Define done before dispatching" (block P): a hand-off may declare the files
 * it must produce; the harness checks them after the member finishes, so a
 * step is done when the artifact exists — not when the member says so.
 */
export const MAX_EXPECTED_FILES = 20;

/** Model input → clean list (strings only, trimmed, de-duplicated, capped). */
export function parseExpectedFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed) seen.add(trimmed);
    if (seen.size >= MAX_EXPECTED_FILES) break;
  }
  return Array.from(seen);
}

function isAbsolutePath(file: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(file);
}

/** Absolute paths stay; relative ones resolve against the workspace. */
export function resolveExpectedFile(file: string, workspacePath: string | null | undefined): string {
  if (isAbsolutePath(file) || !workspacePath) return file;
  const separator = workspacePath.includes('\\') && !workspacePath.includes('/') ? '\\' : '/';
  const base = workspacePath.replace(/[\\/]+$/, '');
  return `${base}${separator}${file.replace(/^[\\/]+/, '')}`;
}

/** Resolved paths of declared files that do not exist (empty = all present). */
export async function findMissingExpectedFiles(
  files: readonly string[],
  workspacePath: string | null | undefined,
): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    const resolved = resolveExpectedFile(file, workspacePath);
    const present = await exists(resolved).catch(() => false);
    if (!present) missing.push(resolved);
  }
  return missing;
}
