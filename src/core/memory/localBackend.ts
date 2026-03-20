/**
 * Local Memory Backend — JSON file-based structured memory storage
 *
 * Storage layout:
 *   ~/.abu/memory/entries.json  — user-scope memory index + content
 *   {workspace}/.abu/memory/entries.json — project-scope memory
 *
 * Each entry has id, category, summary, content, keywords, timestamps.
 * Search uses keyword matching + time decay scoring.
 * All write operations use a per-path mutex to prevent concurrent write corruption.
 */

import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ensureParentDir, joinPath } from '../../utils/pathUtils';
import type { MemoryBackend, MemoryEntry, SearchOptions, ListOptions } from './types';

const MAX_ENTRIES = 500;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// ── Write mutex: serialize all writes per file path ──

const writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(path) ?? Promise.resolve();
  let releaseLock: () => void;
  const next = new Promise<void>((resolve) => { releaseLock = resolve; });
  writeLocks.set(path, next);
  await prev;
  try {
    return await fn();
  } finally {
    releaseLock!();
  }
}

// ── Path helpers ──

let cachedHomeDir: string | null = null;
async function getCachedHomeDir(): Promise<string> {
  if (!cachedHomeDir) cachedHomeDir = await homeDir();
  return cachedHomeDir;
}

async function getUserMemoryPath(): Promise<string> {
  const home = await getCachedHomeDir();
  return joinPath(home, '.abu', 'memory', 'entries.json');
}

function getProjectMemoryPath(projectPath: string): string {
  return joinPath(projectPath, '.abu', 'memory', 'entries.json');
}

async function getMemoryPath(scope: 'user' | 'project', projectPath?: string): Promise<string> {
  if (scope === 'project' && projectPath) {
    return getProjectMemoryPath(projectPath);
  }
  return getUserMemoryPath();
}

// ── File I/O ──

async function loadEntries(scope: 'user' | 'project', projectPath?: string): Promise<MemoryEntry[]> {
  try {
    const path = await getMemoryPath(scope, projectPath);
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveEntries(entries: MemoryEntry[], scope: 'user' | 'project', projectPath?: string): Promise<void> {
  const path = await getMemoryPath(scope, projectPath);
  await ensureParentDir(path);
  await writeTextFile(path, JSON.stringify(entries, null, 2));
}

// ── Search helpers ──

/** Simple tokenizer: split on whitespace and CJK/ASCII punctuation */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;.!?，。！？、；：""''（）[\]{}]+/)
    .filter(t => t.length > 0);
}

/** Score how well a query matches an entry */
function scoreEntry(queryTokens: string[], entry: MemoryEntry): number {
  const keywordSet = new Set(entry.keywords.map(k => k.toLowerCase()));
  const summaryLower = entry.summary.toLowerCase();
  const contentLower = entry.content.toLowerCase();

  let score = 0;

  for (const token of queryTokens) {
    if (keywordSet.has(token)) score += 3;
    if (summaryLower.includes(token)) score += 2;
    if (contentLower.includes(token)) score += 1;
  }

  // Time decay: 30-day half-life
  const ageDays = (Date.now() - entry.updatedAt) / (24 * 60 * 60 * 1000);
  const timeDecay = 1 / (1 + ageDays / 30);

  // Access frequency boost (diminishing returns)
  const accessBoost = Math.log2(entry.accessCount + 1) * 0.1;

  return score * timeDecay + accessBoost;
}

// ── Backend implementation ──

export class LocalMemoryBackend implements MemoryBackend {
  async add(data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): Promise<MemoryEntry> {
    const path = await getMemoryPath(data.scope, data.projectPath);
    return withWriteLock(path, async () => {
      const entries = await loadEntries(data.scope, data.projectPath);
      const now = Date.now();
      const entry: MemoryEntry = {
        ...data,
        id: generateId(),
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
      };

      entries.push(entry);

      // Enforce max entries: evict cold memories, but protect recent ones (7-day grace period)
      if (entries.length > MAX_ENTRIES) {
        const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
        const cutoff = Date.now() - GRACE_PERIOD_MS;

        // Partition: protected (created within grace period) vs evictable
        const protected_: MemoryEntry[] = [];
        const evictable: MemoryEntry[] = [];
        for (const e of entries) {
          if (e.createdAt > cutoff) {
            protected_.push(e);
          } else {
            evictable.push(e);
          }
        }

        // Sort evictable: lowest access count + oldest first (evict from tail)
        evictable.sort((a, b) => {
          const scoreDiff = b.accessCount - a.accessCount;
          return scoreDiff !== 0 ? scoreDiff : b.updatedAt - a.updatedAt;
        });

        // Keep as many evictable as we have room for after protected entries
        const evictableKeep = Math.max(0, MAX_ENTRIES - protected_.length);
        entries.length = 0;
        entries.push(...protected_, ...evictable.slice(0, evictableKeep));
      }

      await saveEntries(entries, data.scope, data.projectPath);
      return entry;
    });
  }

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const scope = options?.scope ?? 'user';
    const entries = await loadEntries(scope, options?.projectPath);
    const queryTokens = tokenize(query);

    if (queryTokens.length === 0) return [];

    const scored = entries
      .filter(e => !options?.category || e.category === options.category)
      .map(e => ({ entry: e, score: scoreEntry(queryTokens, e) }))
      .filter(s => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.limit ?? 10);

    return scored.map(s => s.entry);
  }

  async update(id: string, data: Partial<Pick<MemoryEntry, 'summary' | 'content' | 'keywords' | 'category'>>, scope: 'user' | 'project' = 'user', projectPath?: string): Promise<void> {
    const path = await getMemoryPath(scope, projectPath);
    return withWriteLock(path, async () => {
      const entries = await loadEntries(scope, projectPath);
      const idx = entries.findIndex(e => e.id === id);
      if (idx >= 0) {
        Object.assign(entries[idx], data, { updatedAt: Date.now() });
        await saveEntries(entries, scope, projectPath);
      }
    });
  }

  async remove(id: string, scope: 'user' | 'project' = 'user', projectPath?: string): Promise<void> {
    const path = await getMemoryPath(scope, projectPath);
    return withWriteLock(path, async () => {
      const entries = await loadEntries(scope, projectPath);
      const filtered = entries.filter(e => e.id !== id);
      if (filtered.length < entries.length) {
        await saveEntries(filtered, scope, projectPath);
      }
    });
  }

  async list(options?: ListOptions): Promise<MemoryEntry[]> {
    const scope = options?.scope ?? 'user';
    const entries = await loadEntries(scope, options?.projectPath);
    if (options?.category) {
      return entries.filter(e => e.category === options.category);
    }
    return entries;
  }

  async touch(id: string, scope: 'user' | 'project' = 'user', projectPath?: string): Promise<void> {
    const path = await getMemoryPath(scope, projectPath);
    return withWriteLock(path, async () => {
      const entries = await loadEntries(scope, projectPath);
      const entry = entries.find(e => e.id === id);
      if (entry) {
        entry.accessCount++;
        await saveEntries(entries, scope, projectPath);
      }
    });
  }
}
