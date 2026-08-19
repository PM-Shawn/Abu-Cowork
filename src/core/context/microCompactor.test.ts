import { describe, it, expect } from 'vitest';
import { shouldMicroCompact, microCompactResult, applyMicroCompaction } from './microCompactor';
import type { Message } from '../../types';

describe('microCompactor', () => {
  describe('shouldMicroCompact', () => {
    it('returns true for compactable tool with large result', () => {
      expect(shouldMicroCompact('read_file', 'x'.repeat(7000))).toBe(true);
    });

    it('returns false for compactable tool with small result', () => {
      expect(shouldMicroCompact('read_file', 'short')).toBe(false);
    });

    it('returns false for non-compactable tool', () => {
      expect(shouldMicroCompact('update_memory', 'x'.repeat(7000))).toBe(false);
    });

    it('returns false at exact threshold', () => {
      expect(shouldMicroCompact('read_file', 'x'.repeat(6000))).toBe(false);
    });

    it('returns true just above threshold', () => {
      expect(shouldMicroCompact('read_file', 'x'.repeat(6001))).toBe(true);
    });
  });

  describe('microCompactResult', () => {
    it('returns original text if below threshold', () => {
      const text = 'short content';
      expect(microCompactResult('read_file', text)).toBe(text);
    });

    it('truncates large text keeping head and tail', () => {
      const text = 'H'.repeat(2000) + 'M'.repeat(5000) + 'T'.repeat(1000);
      const result = microCompactResult('read_file', text);

      // Should start with head content
      expect(result.startsWith('H'.repeat(1500))).toBe(true);
      // Should end with tail content
      expect(result.endsWith('T'.repeat(500))).toBe(true);
      // Should contain truncation marker
      expect(result).toContain('characters truncated for context management');
    });

    it('returns original for non-compactable tool', () => {
      const text = 'x'.repeat(7000);
      expect(microCompactResult('computer', text)).toBe(text);
    });
  });

  describe('applyMicroCompaction', () => {
    const makeAssistantMsg = (toolName: string, result: string): Message => ({
      id: 'msg-1',
      role: 'assistant',
      content: 'done',
      timestamp: 1_700_000_000_000, // filler (TESTING.md §3) — not asserted on
      toolCallsForContext: [{
        name: toolName,
        input: {},
        result,
      }],
    });

    const makeUserMsg = (): Message => ({
      id: 'msg-2',
      role: 'user',
      content: 'hello',
      timestamp: 1_700_000_000_000, // filler (TESTING.md §3) — not asserted on
    });

    it('returns same array if no compaction needed', () => {
      const messages: Message[] = [
        makeUserMsg(),
        makeAssistantMsg('read_file', 'short'),
      ];
      const result = applyMicroCompaction(messages);
      expect(result).toEqual(messages);
    });

    it('compacts old large tool results but preserves recent ones', () => {
      const largeResult = 'x'.repeat(7000);
      const messages: Message[] = [
        makeUserMsg(),
        makeAssistantMsg('read_file', largeResult),  // old — should be compacted
        makeUserMsg(),
        makeAssistantMsg('read_file', largeResult),  // old — should be compacted
        makeUserMsg(),
        makeAssistantMsg('read_file', largeResult),  // recent — should be kept
        makeUserMsg(),
        makeAssistantMsg('read_file', largeResult),  // recent — should be kept
      ];

      const result = applyMicroCompaction(messages, 2);

      // First assistant msg (idx 1) should be compacted
      expect(result[1].toolCallsForContext![0].result!.length).toBeLessThan(largeResult.length);
      expect(result[1].toolCallsForContext![0].result).toContain('truncated');

      // Last assistant msg (idx 7) should be kept full
      const lastAssistant = result[7];
      const tcSource = lastAssistant.toolCallsForContext || lastAssistant.toolCalls;
      const lastResult = tcSource?.[0]?.result as string;
      expect(lastResult).toBe(largeResult);
    });

    it('does not modify user messages', () => {
      const messages: Message[] = [makeUserMsg()];
      const result = applyMicroCompaction(messages);
      expect(result[0]).toBe(messages[0]);
    });

    it('handles empty array', () => {
      expect(applyMicroCompaction([])).toEqual([]);
    });
  });
});
