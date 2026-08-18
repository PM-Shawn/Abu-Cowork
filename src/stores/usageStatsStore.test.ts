import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useUsageStatsStore } from './usageStatsStore';

// Deterministic clock (TESTING.md §3) — usageStatsStore.ts's recordTurn() buckets
// by `new Date().toISOString().slice(0, 10)` internally (no injectable clock), so
// the test freezes the same day instead of racing a real midnight boundary.
const FIXED_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();
const today = new Date(FIXED_NOW).toISOString().slice(0, 10);

function reset() {
  useUsageStatsStore.setState({ records: [], conversationTotals: {} });
}

describe('usageStatsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordTurn', () => {
    it('creates a daily record on first call', () => {
      useUsageStatsStore.getState().recordTurn({
        sessionId: 'conv-1',
        model: 'claude-sonnet-4-6',
        skill: null,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      const record = useUsageStatsStore.getState().getRecord(today);
      expect(record).toBeDefined();
      expect(record!.entries).toHaveLength(1);
      expect(record!.entries[0].requests).toBe(1);
      expect(record!.entries[0].inputTokens).toBe(1000);
      expect(record!.entries[0].outputTokens).toBe(500);
    });

    it('accumulates tokens for the same model+skill', () => {
      const { recordTurn } = useUsageStatsStore.getState();
      recordTurn({ sessionId: 'conv-1', model: 'claude-sonnet-4-6', skill: null, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
      recordTurn({ sessionId: 'conv-1', model: 'claude-sonnet-4-6', skill: null, inputTokens: 2000, outputTokens: 300, cacheReadTokens: 800, cacheCreationTokens: 0 });

      const entry = useUsageStatsStore.getState().getRecord(today)!.entries[0];
      expect(entry.requests).toBe(2);
      expect(entry.inputTokens).toBe(3000);
      expect(entry.outputTokens).toBe(800);
      expect(entry.cacheReadTokens).toBe(800);
    });

    it('tracks different skills independently', () => {
      const { recordTurn } = useUsageStatsStore.getState();
      recordTurn({ sessionId: 'conv-1', model: 'claude-opus-4-7', skill: 'cooper', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
      recordTurn({ sessionId: 'conv-1', model: 'claude-opus-4-7', skill: 'webapp-testing', inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0 });
      recordTurn({ sessionId: 'conv-1', model: 'claude-opus-4-7', skill: null, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const entries = useUsageStatsStore.getState().getRecord(today)!.entries;
      expect(entries).toHaveLength(3);
    });

    it('tracks different models independently', () => {
      const { recordTurn } = useUsageStatsStore.getState();
      recordTurn({ sessionId: 'conv-1', model: 'claude-opus-4-7', skill: null, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
      recordTurn({ sessionId: 'conv-1', model: 'claude-sonnet-4-6', skill: null, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const entries = useUsageStatsStore.getState().getRecord(today)!.entries;
      expect(entries).toHaveLength(2);
    });

    it('ignores turns with zero tokens', () => {
      useUsageStatsStore.getState().recordTurn({
        sessionId: 'conv-1',
        model: 'claude-sonnet-4-6',
        skill: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      expect(useUsageStatsStore.getState().records).toHaveLength(0);
    });

    it('accumulates per-conversation totals', () => {
      const { recordTurn } = useUsageStatsStore.getState();
      recordTurn({ sessionId: 'conv-A', model: 'claude-sonnet-4-6', skill: null, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 0 });
      recordTurn({ sessionId: 'conv-A', model: 'claude-sonnet-4-6', skill: 'cooper', inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0 });
      recordTurn({ sessionId: 'conv-B', model: 'claude-opus-4-7', skill: null, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const convA = useUsageStatsStore.getState().getConversationUsage('conv-A');
      expect(convA?.requests).toBe(2);
      expect(convA?.inputTokens).toBe(3000);
      expect(convA?.outputTokens).toBe(800);
      expect(convA?.cacheReadTokens).toBe(200);

      const convB = useUsageStatsStore.getState().getConversationUsage('conv-B');
      expect(convB?.requests).toBe(1);
      expect(convB?.inputTokens).toBe(500);
    });

    it('clearConversationUsage removes the entry', () => {
      useUsageStatsStore.getState().recordTurn({ sessionId: 'conv-1', model: 'claude-sonnet-4-6', skill: null, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
      useUsageStatsStore.getState().clearConversationUsage('conv-1');
      expect(useUsageStatsStore.getState().getConversationUsage('conv-1')).toBeUndefined();
    });
  });

  describe('getRecentRecords', () => {
    it('returns records sorted by date ascending', () => {
      useUsageStatsStore.setState({
        records: [
          { date: '2026-05-10', entries: [] },
          { date: '2026-05-08', entries: [] },
          { date: '2026-05-12', entries: [] },
        ],
      });
      const result = useUsageStatsStore.getState().getRecentRecords(10);
      expect(result.map((r) => r.date)).toEqual(['2026-05-08', '2026-05-10', '2026-05-12']);
    });

    it('returns at most the requested number of days', () => {
      useUsageStatsStore.setState({
        records: Array.from({ length: 10 }, (_, i) => ({
          date: `2026-05-${String(i + 1).padStart(2, '0')}`,
          entries: [],
        })),
      });
      const result = useUsageStatsStore.getState().getRecentRecords(5);
      expect(result).toHaveLength(5);
      expect(result[result.length - 1].date).toBe('2026-05-10');
    });

    it('returns all records when fewer than requested days exist', () => {
      useUsageStatsStore.setState({
        records: [{ date: '2026-05-12', entries: [] }],
      });
      expect(useUsageStatsStore.getState().getRecentRecords(30)).toHaveLength(1);
    });
  });

  describe('getRecord', () => {
    it('returns undefined for missing date', () => {
      expect(useUsageStatsStore.getState().getRecord('2020-01-01')).toBeUndefined();
    });

    it('returns the matching record', () => {
      useUsageStatsStore.setState({
        records: [{ date: '2026-05-12', entries: [] }],
      });
      expect(useUsageStatsStore.getState().getRecord('2026-05-12')).toBeDefined();
    });
  });
});
