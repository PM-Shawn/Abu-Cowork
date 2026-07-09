import { describe, it, expect, beforeEach } from 'vitest';
import { useScratchpadStore, generateScratchpadTitle, inferScratchpadType, shouldCaptureScratchpad, truncateScratchpadContent } from './scratchpadStore';
import { getI18n } from '@/i18n';

describe('scratchpadStore', () => {
  beforeEach(() => {
    useScratchpadStore.setState({ entries: {}, order: [] });
  });

  // ── addEntry ──
  describe('addEntry', () => {
    it('adds an entry and returns id', () => {
      const id = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1',
        title: 'Test Entry',
        type: 'extraction',
        content: 'Some content',
      });
      expect(typeof id).toBe('string');
      const state = useScratchpadStore.getState();
      expect(state.entries[id]).toBeDefined();
      expect(state.entries[id].title).toBe('Test Entry');
      expect(state.entries[id].isViewed).toBe(false);
      expect(state.order[0]).toBe(id);
    });

    it('adds entry to front of order (newest first)', () => {
      const id1 = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'First', type: 'extraction', content: 'a',
      });
      const id2 = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'Second', type: 'analysis', content: 'b',
      });
      const { order } = useScratchpadStore.getState();
      expect(order[0]).toBe(id2);
      expect(order[1]).toBe(id1);
    });
  });

  // ── markViewed ──
  describe('markViewed', () => {
    it('marks an entry as viewed', () => {
      const id = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'Entry', type: 'extraction', content: 'x',
      });
      useScratchpadStore.getState().markViewed(id);
      expect(useScratchpadStore.getState().entries[id].isViewed).toBe(true);
    });
  });

  // ── markAllViewed ──
  describe('markAllViewed', () => {
    it('marks all entries for a conversation as viewed', () => {
      const id1 = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'A', type: 'extraction', content: 'x',
      });
      const id2 = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'B', type: 'analysis', content: 'y',
      });
      const id3 = useScratchpadStore.getState().addEntry({
        conversationId: 'conv2', title: 'C', type: 'search', content: 'z',
      });
      useScratchpadStore.getState().markAllViewed('conv1');
      const state = useScratchpadStore.getState();
      expect(state.entries[id1].isViewed).toBe(true);
      expect(state.entries[id2].isViewed).toBe(true);
      expect(state.entries[id3].isViewed).toBe(false);
    });
  });

  // ── removeEntry ──
  describe('removeEntry', () => {
    it('removes an entry and updates order', () => {
      const id = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'Entry', type: 'extraction', content: 'x',
      });
      useScratchpadStore.getState().removeEntry(id);
      const state = useScratchpadStore.getState();
      expect(state.entries[id]).toBeUndefined();
      expect(state.order).not.toContain(id);
    });
  });

  // ── clearConversation ──
  describe('clearConversation', () => {
    it('clears all entries for a conversation', () => {
      useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'A', type: 'extraction', content: 'x',
      });
      useScratchpadStore.getState().addEntry({
        conversationId: 'conv2', title: 'B', type: 'analysis', content: 'y',
      });
      useScratchpadStore.getState().clearConversation('conv1');
      const state = useScratchpadStore.getState();
      expect(Object.values(state.entries).every((e) => e.conversationId === 'conv2')).toBe(true);
    });
  });

  // ── clearAll ──
  describe('clearAll', () => {
    it('clears everything', () => {
      useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'A', type: 'extraction', content: 'x',
      });
      useScratchpadStore.getState().clearAll();
      const state = useScratchpadStore.getState();
      expect(Object.keys(state.entries)).toHaveLength(0);
      expect(state.order).toHaveLength(0);
    });
  });

  // ── getEntriesByConversation ──
  describe('getEntriesByConversation', () => {
    it('returns entries filtered by conversationId', () => {
      useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'A', type: 'extraction', content: 'x',
      });
      useScratchpadStore.getState().addEntry({
        conversationId: 'conv2', title: 'B', type: 'analysis', content: 'y',
      });
      const entries = useScratchpadStore.getState().getEntriesByConversation('conv1');
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe('A');
    });
  });

  // ── getUnviewedCount ──
  describe('getUnviewedCount', () => {
    it('counts unviewed entries for a conversation', () => {
      const id1 = useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'A', type: 'extraction', content: 'x',
      });
      useScratchpadStore.getState().addEntry({
        conversationId: 'conv1', title: 'B', type: 'analysis', content: 'y',
      });
      useScratchpadStore.getState().markViewed(id1);
      expect(useScratchpadStore.getState().getUnviewedCount('conv1')).toBe(1);
    });
  });

  // ── Helper functions ──
  describe('generateScratchpadTitle', () => {
    it('generates extraction title with filename', () => {
      const title = generateScratchpadTitle('read_file', { path: '/tmp/invoice.pdf' }, 'extraction');
      expect(title).toContain('invoice.pdf');
    });

    it('generates search title with query', () => {
      const title = generateScratchpadTitle('search', { query: 'long query text for testing' }, 'search');
      // The search title template contains the query; verify structure via i18n key
      const template = getI18n().scratchpad.searchTitle;
      const prefix = template.split('{query}')[0];
      expect(title).toContain(prefix);
    });

    it('truncates long queries', () => {
      const title = generateScratchpadTitle('search', { query: 'a'.repeat(50) }, 'search');
      expect(title).toContain('...');
    });
  });

  describe('inferScratchpadType', () => {
    it('returns extraction for read tools', () => {
      expect(inferScratchpadType('read_file')).toBe('extraction');
    });

    it('returns search for search tools', () => {
      expect(inferScratchpadType('web_search')).toBe('search');
    });

    it('returns preview for list_directory', () => {
      expect(inferScratchpadType('list_directory')).toBe('preview');
    });

    it('returns null for unknown tools', () => {
      expect(inferScratchpadType('custom_tool')).toBeNull();
    });
  });

  describe('shouldCaptureScratchpad', () => {
    it('returns true for substantial read_file results', () => {
      expect(shouldCaptureScratchpad('read_file', 'x'.repeat(200))).toBe(true);
    });

    it('returns false for short results', () => {
      expect(shouldCaptureScratchpad('read_file', 'short')).toBe(false);
    });

    it('returns false for error results', () => {
      expect(shouldCaptureScratchpad('read_file', 'Error: file not found')).toBe(false);
    });

    it('returns false for unknown tools', () => {
      expect(shouldCaptureScratchpad('custom_tool', 'x'.repeat(200))).toBe(false);
    });
  });

  describe('truncateScratchpadContent', () => {
    it('returns short content as-is', () => {
      expect(truncateScratchpadContent('short')).toBe('short');
    });

    it('truncates long content', () => {
      const result = truncateScratchpadContent('x'.repeat(3000));
      expect(result.length).toBeLessThan(3000);
      expect(result).toContain('more characters');
    });

    it('respects custom maxLength', () => {
      const result = truncateScratchpadContent('x'.repeat(200), 100);
      expect(result.length).toBeLessThan(200);
    });
  });
});
