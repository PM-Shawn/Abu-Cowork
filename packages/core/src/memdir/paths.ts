import type { PathAdapter } from '../ports/adapters/path';
import { joinPath, normalizeSeparators } from '../common/pathUtils';
import { MEMORY_INDEX_FILENAME } from './types';

const MAX_SANITIZED_LENGTH = 200;

/**
 * 对比 Abu 原版改动：
 * - 原版 import `@tauri-apps/api/path` 获取 homeDir；
 * - 新版通过 PathAdapter 注入；
 * - cachedHome 改为 MemdirPaths 实例上的状态（之前是模块级全局）。
 */

function djb2Hash(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  const hash = Math.abs(djb2Hash(name)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}

export class MemdirPaths {
  private cachedHome: string | null = null;

  constructor(private readonly path: PathAdapter) {}

  private async getHome(): Promise<string> {
    if (!this.cachedHome) this.cachedHome = await this.path.homeDir();
    return this.cachedHome;
  }

  async getMemoryDir(workspacePath?: string | null): Promise<string> {
    const home = await this.getHome();
    if (workspacePath) {
      const key = sanitizePath(normalizeSeparators(workspacePath));
      return joinPath(home, '.abu', 'projects', key, 'memory');
    }
    return joinPath(home, '.abu', 'memory');
  }

  async getMemoryEntrypoint(workspacePath?: string | null): Promise<string> {
    const dir = await this.getMemoryDir(workspacePath);
    return joinPath(dir, MEMORY_INDEX_FILENAME);
  }

  async isMemoryPath(absolutePath: string): Promise<boolean> {
    const home = await this.getHome();
    const normalized = normalizeSeparators(absolutePath);

    const globalDir = joinPath(home, '.abu', 'memory');
    if (normalized.startsWith(globalDir + '/') || normalized === globalDir) return true;

    const projectsPrefix = joinPath(home, '.abu', 'projects');
    if (normalized.startsWith(projectsPrefix + '/')) {
      const rest = normalized.slice(projectsPrefix.length + 1);
      const parts = rest.split('/');
      if (parts.length >= 2 && parts[1] === 'memory') return true;
    }
    return false;
  }

  /** 测试辅助：清空缓存 */
  resetCache(): void {
    this.cachedHome = null;
  }
}
