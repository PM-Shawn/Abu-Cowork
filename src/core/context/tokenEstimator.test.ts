import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens } from './tokenEstimator';
import type { Message } from '../../types';

// Filler timestamp (TESTING.md §3) — not asserted on below (estimateMessageTokens
// counts content/thinking/toolCalls, not timestamps).
const FIXED_TIMESTAMP = 1_700_000_000_000;

describe('tokenEstimator', () => {
  // ── estimateTokens ──
  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('returns 0 for null/undefined', () => {
      expect(estimateTokens(null as unknown as string)).toBe(0);
      expect(estimateTokens(undefined as unknown as string)).toBe(0);
    });

    it('estimates English text (~4 chars/token)', () => {
      const text = 'Hello world, this is a test string.'; // 34 chars
      const tokens = estimateTokens(text);
      // ~34/4 = ~9 tokens
      expect(tokens).toBeGreaterThanOrEqual(7);
      expect(tokens).toBeLessThanOrEqual(12);
    });

    it('estimates Chinese text (~1.5 chars/token)', () => {
      const text = '你好世界这是测试'; // 8 CJK chars
      const tokens = estimateTokens(text);
      // ~8/1.5 = ~5.3 → ceil = 6
      expect(tokens).toBeGreaterThanOrEqual(4);
      expect(tokens).toBeLessThanOrEqual(8);
    });

    it('estimates mixed Chinese/English text', () => {
      const text = 'Hello 你好 World 世界'; // mix
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it('longer text produces more tokens', () => {
      const short = 'Hello';
      const long = 'Hello world, this is a much longer test string for estimating tokens.';
      expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
    });

    it('returns integer (ceil)', () => {
      const result = estimateTokens('Hi');
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  // ── estimateMessageTokens ──
  describe('estimateMessageTokens', () => {
    it('returns 0 for empty array', () => {
      expect(estimateMessageTokens([])).toBe(0);
    });

    it('estimates string content messages', () => {
      const messages: Message[] = [
        { id: '1', role: 'user', content: 'Hello world', timestamp: FIXED_TIMESTAMP },
        { id: '2', role: 'assistant', content: 'Hi there!', timestamp: FIXED_TIMESTAMP },
      ];
      const tokens = estimateMessageTokens(messages);
      // 2 messages × ~3 tokens + 2 × 4 overhead = ~14
      expect(tokens).toBeGreaterThan(0);
    });

    it('accounts for image content (~1600 tokens per image)', () => {
      const msgWithImage: Message[] = [{
        id: '1',
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
        timestamp: FIXED_TIMESTAMP,
      }];
      const tokens = estimateMessageTokens(msgWithImage);
      expect(tokens).toBeGreaterThanOrEqual(1600);
    });

    it('accounts for thinking content', () => {
      const msg: Message[] = [{
        id: '1',
        role: 'assistant',
        content: 'Result',
        thinking: 'Let me think about this carefully and reason through it step by step.',
        timestamp: FIXED_TIMESTAMP,
      }];
      const withThinking = estimateMessageTokens(msg);

      const msgNoThink: Message[] = [{
        id: '1',
        role: 'assistant',
        content: 'Result',
        timestamp: FIXED_TIMESTAMP,
      }];
      const withoutThinking = estimateMessageTokens(msgNoThink);
      expect(withThinking).toBeGreaterThan(withoutThinking);
    });

    it('accounts for tool calls', () => {
      const msg: Message[] = [{
        id: '1',
        role: 'assistant',
        content: 'Running tool...',
        toolCalls: [{
          id: 'tc1',
          name: 'read_file',
          input: { path: '/tmp/test.txt' },
          result: 'File content here with some text.',
        }],
        timestamp: FIXED_TIMESTAMP,
      }];
      const tokens = estimateMessageTokens(msg);
      // Should include text + tool name + input JSON + result
      expect(tokens).toBeGreaterThan(10);
    });

    it('accounts for toolCallsForContext', () => {
      const msg: Message[] = [{
        id: '1',
        role: 'assistant',
        content: 'Done',
        toolCallsForContext: [{
          name: 'read_file',
          input: { path: '/tmp/file.txt' },
          result: 'Long file content...',
        }],
        timestamp: FIXED_TIMESTAMP,
      }];
      const tokens = estimateMessageTokens(msg);
      expect(tokens).toBeGreaterThan(10);
    });

    it('includes per-message overhead of 4', () => {
      const msg: Message[] = [
        { id: '1', role: 'user', content: '', timestamp: FIXED_TIMESTAMP },
      ];
      // Empty content = 0 text tokens + 4 overhead
      expect(estimateMessageTokens(msg)).toBe(4);
    });
  });
});
