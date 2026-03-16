/**
 * LocalMemoryBackend Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri APIs
const mockFiles: Record<string, string> = {};

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn((path: string) => {
    if (mockFiles[path]) return Promise.resolve(mockFiles[path]);
    return Promise.reject(new Error('File not found'));
  }),
  writeTextFile: vi.fn((path: string, content: string) => {
    mockFiles[path] = content;
    return Promise.resolve();
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn(() => Promise.resolve('/mock/home')),
}));

vi.mock('../../utils/pathUtils', () => ({
  ensureParentDir: vi.fn(() => Promise.resolve()),
  joinPath: (...parts: string[]) => parts.join('/'),
}));

import { LocalMemoryBackend } from './localBackend';

describe('LocalMemoryBackend', () => {
  let backend: LocalMemoryBackend;

  beforeEach(() => {
    backend = new LocalMemoryBackend();
    // Clear mock files
    for (const key of Object.keys(mockFiles)) {
      delete mockFiles[key];
    }
  });

  describe('add', () => {
    it('creates a new memory entry with generated id and timestamps', async () => {
      const entry = await backend.add({
        category: 'user_preference',
        summary: 'User prefers dark theme',
        content: 'The user mentioned they always use dark theme in all apps.',
        keywords: ['dark', 'theme', 'preference'],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      expect(entry.id).toBeTruthy();
      expect(entry.category).toBe('user_preference');
      expect(entry.summary).toBe('User prefers dark theme');
      expect(entry.createdAt).toBeGreaterThan(0);
      expect(entry.updatedAt).toBeGreaterThan(0);
      expect(entry.accessCount).toBe(0);
    });

    it('persists entry to disk', async () => {
      await backend.add({
        category: 'conversation_fact',
        summary: 'Test fact',
        content: 'Content here',
        keywords: ['test'],
        sourceType: 'auto_flush',
        scope: 'user',
      });

      // Should have written to the user memory path
      const path = '/mock/home/.abu/memory/entries.json';
      expect(mockFiles[path]).toBeDefined();
      const parsed = JSON.parse(mockFiles[path]);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].summary).toBe('Test fact');
    });

    it('appends to existing entries', async () => {
      await backend.add({
        category: 'user_preference',
        summary: 'Entry 1',
        content: 'Content 1',
        keywords: ['one'],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      await backend.add({
        category: 'decision',
        summary: 'Entry 2',
        content: 'Content 2',
        keywords: ['two'],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      const entries = await backend.list({ scope: 'user' });
      expect(entries).toHaveLength(2);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await backend.add({
        category: 'user_preference',
        summary: 'User likes React',
        content: 'The user prefers React over Vue for frontend development.',
        keywords: ['react', 'frontend', 'preference'],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      await backend.add({
        category: 'project_knowledge',
        summary: 'Project uses Tauri',
        content: 'This project is built with Tauri 2.0 and TypeScript.',
        keywords: ['tauri', 'typescript', 'desktop'],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      await backend.add({
        category: 'conversation_fact',
        summary: 'Meeting notes for Q3',
        content: 'Q3 revenue was discussed. Focus on mobile app.',
        keywords: ['meeting', 'q3', 'revenue', 'mobile'],
        sourceType: 'auto_flush',
        scope: 'user',
      });
    });

    it('finds entries matching keyword', async () => {
      const results = await backend.search('react frontend');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].summary).toContain('React');
    });

    it('finds entries matching content', async () => {
      const results = await backend.search('tauri desktop');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].summary).toContain('Tauri');
    });

    it('returns empty for non-matching query', async () => {
      const results = await backend.search('xyznonexistent');
      expect(results).toHaveLength(0);
    });

    it('respects limit option', async () => {
      const results = await backend.search('project', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('filters by category', async () => {
      const results = await backend.search('user', { category: 'user_preference' });
      for (const r of results) {
        expect(r.category).toBe('user_preference');
      }
    });
  });

  describe('list', () => {
    it('returns all entries for scope', async () => {
      await backend.add({
        category: 'user_preference',
        summary: 'Pref 1',
        content: 'Content',
        keywords: [],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      const entries = await backend.list({ scope: 'user' });
      expect(entries).toHaveLength(1);
    });

    it('returns empty array when no entries exist', async () => {
      const entries = await backend.list({ scope: 'user' });
      expect(entries).toHaveLength(0);
    });

    it('filters by category', async () => {
      await backend.add({
        category: 'user_preference',
        summary: 'Pref',
        content: 'C',
        keywords: [],
        sourceType: 'agent_explicit',
        scope: 'user',
      });
      await backend.add({
        category: 'decision',
        summary: 'Dec',
        content: 'C',
        keywords: [],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      const prefs = await backend.list({ scope: 'user', category: 'user_preference' });
      expect(prefs).toHaveLength(1);
      expect(prefs[0].category).toBe('user_preference');
    });
  });

  describe('remove', () => {
    it('removes entry by id', async () => {
      const entry = await backend.add({
        category: 'conversation_fact',
        summary: 'To remove',
        content: 'Content',
        keywords: [],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      await backend.remove(entry.id);

      const entries = await backend.list({ scope: 'user' });
      expect(entries).toHaveLength(0);
    });

    it('no-ops for non-existent id', async () => {
      await backend.add({
        category: 'conversation_fact',
        summary: 'Keep',
        content: 'Content',
        keywords: [],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      await backend.remove('nonexistent');

      const entries = await backend.list({ scope: 'user' });
      expect(entries).toHaveLength(1);
    });
  });

  describe('touch', () => {
    it('increments access count', async () => {
      const entry = await backend.add({
        category: 'user_preference',
        summary: 'Test',
        content: 'Content',
        keywords: [],
        sourceType: 'agent_explicit',
        scope: 'user',
      });

      expect(entry.accessCount).toBe(0);

      await backend.touch(entry.id);
      await backend.touch(entry.id);

      const entries = await backend.list({ scope: 'user' });
      expect(entries[0].accessCount).toBe(2);
    });
  });
});
