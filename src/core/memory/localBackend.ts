/**
 * Local Memory Backend — JSON file-based structured memory storage
 *
 * Storage layout:
 *   ~/.abu/memory/entries.json  — user-scope memory index + content
 *   {workspace}/.abu/memory/entries.json — project-scope memory
 *
 * Each entry has id, category, summary, content, keywords, timestamps.
 * Search uses keyword matching + time decay scoring.
 */

import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ensureParentDir, joinPath } from '../../utils/pathUtils';
import type { MemoryBackend, MemoryEntry, SearchOptions, ListOptions } from './types';

const MAX_ENTRIES = 200;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Cache homeDir
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

async function loadEntries(scope: 'user' | 'project', projectPath?: string): Promise<MemoryEntry[]> {
  try {
    const path = await getMemoryPath(scope, projectPath);
    const raw = await readTextFile(path);
    return JSON.parse(raw) as MemoryEntry[];
  } catch {
    return [];
  }
}

async function saveEntries(entries: MemoryEntry[], scope: 'user' | 'project', projectPath?: string): Promise<void> {
  const path = await getMemoryPath(scope, projectPath);
  await ensureParentDir(path);
  await writeTextFile(path, JSON.stringify(entries, null, 2));
}

/** Simple tokenizer: split on CJK chars, whitespace, and punctuation */
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
    // Keyword exact match (highest weight)
    if (keywordSet.has(token)) score += 3;
    // Summary contains token
    if (summaryLower.includes(token)) score += 2;
    // Content contains token
    if (contentLower.includes(token)) score += 1;
  }

  // Time decay: 30-day half-life
  const ageDays = (Date.now() - entry.updatedAt) / (24 * 60 * 60 * 1000);
  const timeDecay = 1 / (1 + ageDays / 30);

  // Access frequency boost (diminishing returns)
  const accessBoost = Math.log2(entry.accessCount + 1) * 0.1;

  return score * timeDecay + accessBoost;
}

export class LocalMemoryBackend implements MemoryBackend {
  async add(data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): Promise<MemoryEntry> {
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

    // Enforce max entries: remove oldest with lowest access count
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => {
        // Keep high-access entries; among equal access, keep newer
        const scoreDiff = b.accessCount - a.accessCount;
        return scoreDiff !== 0 ? scoreDiff : b.updatedAt - a.updatedAt;
      });
      entries.length = MAX_ENTRIES;
    }

    await saveEntries(entries, data.scope, data.projectPath);
    return entry;
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

  async update(id: string, data: Partial<Pick<MemoryEntry, 'summary' | 'content' | 'keywords' | 'category'>>): Promise<void> {
    // Try user scope first, then all project scopes
    const userEntries = await loadEntries('user');
    const idx = userEntries.findIndex(e => e.id === id);
    if (idx >= 0) {
      Object.assign(userEntries[idx], data, { updatedAt: Date.now() });
      await saveEntries(userEntries, 'user');
      return;
    }
    // Entry not found in user scope — caller may need to specify project scope
  }

  async remove(id: string): Promise<void> {
    const userEntries = await loadEntries('user');
    const filtered = userEntries.filter(e => e.id !== id);
    if (filtered.length < userEntries.length) {
      await saveEntries(filtered, 'user');
    }
  }

  async list(options?: ListOptions): Promise<MemoryEntry[]> {
    const scope = options?.scope ?? 'user';
    const entries = await loadEntries(scope, options?.projectPath);
    if (options?.category) {
      return entries.filter(e => e.category === options.category);
    }
    return entries;
  }

  async touch(id: string): Promise<void> {
    const userEntries = await loadEntries('user');
    const entry = userEntries.find(e => e.id === id);
    if (entry) {
      entry.accessCount++;
      await saveEntries(userEntries, 'user');
    }
  }
}
