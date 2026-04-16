import type { StorageAdapter } from '../ports/adapters/storage';
import type { ClockAdapter } from '../ports/adapters/clock';
import { joinPath, ensureParentDir } from '../common/pathUtils';
import { MemdirPaths } from './paths';
import type { MemdirScanner } from './scan';
import type { MemoryType, MemorySource, MemoryHeader } from './types';
import {
  MEMORY_INDEX_FILENAME,
  MAX_INDEX_LINES,
  MAX_MEMORY_FILES,
  toMemoryFilename,
} from './types';

export interface WriteMemoryOptions {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  source?: MemorySource;
  workspacePath?: string | null;
  filename?: string;
}

export interface MemdirWriterDeps {
  storage: StorageAdapter;
  clock: ClockAdapter;
  paths: MemdirPaths;
  scanner: MemdirScanner;
}

export class MemdirWriter {
  private writeLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: MemdirWriterDeps) {}

  private async withWriteLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(dir) ?? Promise.resolve();
    let releaseLock: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.writeLocks.set(dir, next);
    await prev;
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  private buildFileContent(
    name: string,
    description: string,
    type: MemoryType,
    source: MemorySource,
    content: string,
    created?: number,
    updated?: number,
    accessCount?: number
  ): string {
    const now = this.deps.clock.now();
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

  private async rebuildIndex(dir: string, headers: MemoryHeader[]): Promise<void> {
    const { storage } = this.deps;
    const lines = ['# Memory Index', ''];
    for (const h of headers.slice(0, MAX_INDEX_LINES - 2)) {
      lines.push(`- [${h.filename}](${h.filename}) — ${h.description}`);
    }
    const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
    await storage.writeTextFile(indexPath, lines.join('\n') + '\n');
  }

  private async addToIndex(
    dir: string,
    filename: string,
    description: string,
    workspacePath?: string | null
  ): Promise<void> {
    const { storage, scanner } = this.deps;
    const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
    let content: string;
    try {
      content = await storage.readTextFile(indexPath);
    } catch {
      content = '# Memory Index\n';
    }

    const newLine = `- [${filename}](${filename}) — ${description}`;
    const lines = content.split('\n');

    if (lines.some((l) => l.includes(`[${filename}]`))) {
      const updated = lines.map((l) => (l.includes(`[${filename}]`) ? newLine : l));
      await storage.writeTextFile(indexPath, updated.join('\n'));
      return;
    }

    lines.push(newLine);

    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length > MAX_INDEX_LINES) {
      const headers = await scanner.scanMemoryFiles(workspacePath);
      await this.rebuildIndex(dir, headers);
      return;
    }

    await storage.writeTextFile(indexPath, lines.join('\n'));
  }

  private async removeFromIndex(dir: string, filename: string): Promise<void> {
    const { storage } = this.deps;
    const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
    try {
      const content = await storage.readTextFile(indexPath);
      const lines = content.split('\n');
      const filtered = lines.filter((l) => !l.includes(`[${filename}]`));
      await storage.writeTextFile(indexPath, filtered.join('\n'));
    } catch {
      /* no index */
    }
  }

  async writeMemory(options: WriteMemoryOptions): Promise<string> {
    const { storage, paths, scanner } = this.deps;
    const {
      name,
      description,
      type,
      content,
      source = 'agent_explicit',
      workspacePath,
      filename: overrideFilename,
    } = options;

    const dir = await paths.getMemoryDir(workspacePath);

    return this.withWriteLock(dir, async () => {
      const existing = await scanner.scanMemoryFiles(workspacePath);
      if (existing.length >= MAX_MEMORY_FILES && !overrideFilename) {
        const sorted = [...existing].sort(
          (a, b) => a.accessCount - b.accessCount || a.updated - b.updated
        );
        const evictTarget = sorted[0];
        if (evictTarget) {
          await storage.remove(evictTarget.filePath).catch(() => {});
          await this.removeFromIndex(dir, evictTarget.filename);
        }
      }

      const filename = overrideFilename || toMemoryFilename(type, name);
      const filePath = joinPath(dir, filename);
      await ensureParentDir(storage, filePath);

      const fileContent = this.buildFileContent(name, description, type, source, content);
      await storage.writeTextFile(filePath, fileContent);
      await this.addToIndex(dir, filename, description, workspacePath);

      return filename;
    });
  }

  async touchMemory(filePath: string): Promise<void> {
    const { storage, clock } = this.deps;
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));

    return this.withWriteLock(dir, async () => {
      try {
        const raw = await storage.readTextFile(filePath);
        const updated = raw
          .replace(/^(accessCount:\s*)(\d+)/m, (_, prefix, count) => `${prefix}${Number(count) + 1}`)
          .replace(/^(updated:\s*)(\d+)/m, () => `updated: ${clock.now()}`);
        await storage.writeTextFile(filePath, updated);
      } catch {
        /* may have been deleted */
      }
    });
  }

  async deleteMemory(filename: string, workspacePath?: string | null): Promise<void> {
    const { storage, paths } = this.deps;
    const dir = await paths.getMemoryDir(workspacePath);

    return this.withWriteLock(dir, async () => {
      const filePath = joinPath(dir, filename);
      if (await storage.exists(filePath)) {
        await storage.remove(filePath);
      }
      await this.removeFromIndex(dir, filename);
    });
  }

  async clearAllMemories(workspacePath?: string | null): Promise<number> {
    const { storage, paths, scanner } = this.deps;
    const dir = await paths.getMemoryDir(workspacePath);

    return this.withWriteLock(dir, async () => {
      const headers = await scanner.scanMemoryFiles(workspacePath);
      let count = 0;
      for (const h of headers) {
        try {
          await storage.remove(h.filePath);
          count++;
        } catch {
          /* ignore */
        }
      }
      const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
      try {
        await storage.writeTextFile(indexPath, '# Memory Index\n');
      } catch {
        /* ignore */
      }
      return count;
    });
  }
}
