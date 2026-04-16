import type { StorageAdapter } from '../ports/adapters/storage';
import type { ClockAdapter } from '../ports/adapters/clock';
import { joinPath } from '../common/pathUtils';
import type { MemoryHeader, MemoryType, MemorySource } from './types';
import { MEMORY_INDEX_FILENAME, MAX_MEMORY_FILES } from './types';
import { MemdirPaths } from './paths';

const VALID_TYPES: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference']);
const VALID_SOURCES: ReadonlySet<string> = new Set([
  'agent_explicit',
  'auto_flush',
  'user_manual',
]);

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

export interface MemdirScanDeps {
  storage: StorageAdapter;
  clock: ClockAdapter;
  paths: MemdirPaths;
}

export class MemdirScanner {
  constructor(private readonly deps: MemdirScanDeps) {}

  async scanMemoryFiles(workspacePath?: string | null): Promise<MemoryHeader[]> {
    const { storage, clock, paths } = this.deps;
    const dir = await paths.getMemoryDir(workspacePath);

    let dirEntries;
    try {
      dirEntries = await storage.readDir(dir);
    } catch {
      return [];
    }

    const mdFiles = dirEntries.filter(
      (e) => e.name.endsWith('.md') && e.name !== MEMORY_INDEX_FILENAME && !e.isDirectory
    );

    const headers: MemoryHeader[] = [];

    for (const file of mdFiles.slice(0, MAX_MEMORY_FILES)) {
      const filePath = joinPath(dir, file.name);
      try {
        const raw = await storage.readTextFile(filePath);
        const preview = raw.slice(0, 1024);
        const fm = parseFrontmatter(preview);

        if (!fm.name) continue;

        let created = Number(fm.created) || 0;
        let updated = Number(fm.updated) || 0;
        if (!created || !updated) {
          try {
            const s = await storage.stat(filePath);
            if (!created && s.mtime) created = s.mtime;
            if (!updated && s.mtime) updated = s.mtime;
          } catch {
            /* ignore */
          }
        }

        headers.push({
          filename: file.name,
          filePath,
          name: fm.name,
          description: fm.description || fm.name,
          type: VALID_TYPES.has(fm.type) ? (fm.type as MemoryType) : 'project',
          source: VALID_SOURCES.has(fm.source) ? (fm.source as MemorySource) : 'user_manual',
          created: created || clock.now(),
          updated: updated || clock.now(),
          accessCount: Number(fm.accessCount) || 0,
        });
      } catch {
        /* skip */
      }
    }

    headers.sort((a, b) => b.updated - a.updated);
    return headers;
  }

  async readMemoryFile(
    filePath: string
  ): Promise<{ header: MemoryHeader; content: string } | null> {
    const { storage, clock } = this.deps;
    try {
      const raw = await storage.readTextFile(filePath);
      const fm = parseFrontmatter(raw);
      if (!fm.name) return null;

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
          created: Number(fm.created) || clock.now(),
          updated: Number(fm.updated) || clock.now(),
          accessCount: Number(fm.accessCount) || 0,
        },
        content,
      };
    } catch {
      return null;
    }
  }

  async loadMemoryIndex(workspacePath?: string | null): Promise<string> {
    const { storage, paths } = this.deps;
    const dir = await paths.getMemoryDir(workspacePath);
    const indexPath = joinPath(dir, MEMORY_INDEX_FILENAME);
    try {
      return await storage.readTextFile(indexPath);
    } catch {
      return '';
    }
  }
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const date = new Date(h.updated).toISOString().split('T')[0];
      return `- [${h.type}] ${h.filename} (${date}): ${h.description}`;
    })
    .join('\n');
}
