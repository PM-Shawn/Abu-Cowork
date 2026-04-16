import type { StorageAdapter } from '../ports/adapters/storage';

/**
 * 跨平台纯路径工具。从 Abu src/utils/pathUtils.ts 抽取。
 * 只保留零依赖的字符串操作；Tauri FS 相关的辅助（ensureParentDir 等）改为接 StorageAdapter。
 */

export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

export function getBaseName(p: string): string {
  const normalized = normalizeSeparators(p);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function getParentDir(p: string): string {
  const normalized = normalizeSeparators(p);
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.substring(0, idx);
}

export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => normalizeSeparators(s))
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function extractUsername(homePath: string): string {
  const normalized = normalizeSeparators(homePath);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'user';
}

const WIN_DRIVE_RE = /^[A-Za-z]:[/\\]/;

export function isLocalFilePath(s: string): boolean {
  return s.startsWith('/') || WIN_DRIVE_RE.test(s);
}

export async function ensureParentDir(
  storage: StorageAdapter,
  filePath: string
): Promise<void> {
  const parent = getParentDir(filePath);
  if (parent && parent !== '/') {
    await storage.mkdir(parent, { recursive: true });
  }
}
