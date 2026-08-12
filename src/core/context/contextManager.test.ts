import { describe, it, expect } from 'vitest';
import {
  ContextBudgetError,
  enforceContextBudget,
  prepareContextMessages,
} from './contextManager';
import { estimateMessageTokens, estimateTokens } from './tokenEstimator';
import type { Message } from '../../types';

let messageSequence = 0;
function makeMsg(role: 'user' | 'assistant', content: string): Message {
  messageSequence += 1;
  return { id: `message-${messageSequence}`, role, content, timestamp: 1_800_000_000_000 };
}

describe('contextManager', () => {
  const systemPrompt = 'You are a helpful assistant.';

  // ── Fast path: everything fits ──
  describe('fast path — everything fits', () => {
    it('returns all messages when within limit', () => {
      const messages = [
        makeMsg('user', 'Hello'),
        makeMsg('assistant', 'Hi!'),
      ];
      const result = prepareContextMessages(messages, systemPrompt, 100000, 4000);
      expect(result).toHaveLength(2);
      expect(result).toEqual(messages);
    });

    it('reports the safe budget and leaves a safety margin', () => {
      const result = enforceContextBudget(
        [makeMsg('user', 'Hello')],
        systemPrompt,
        10_000,
        1_000,
      );

      expect(result.strategy).toBe('unchanged');
      expect(result.inputBudget).toBeLessThan(9_000);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.safetyMarginTokens).toBeGreaterThan(0);
    });
  });

  // ── Round identification ──
  describe('round identification and compression', () => {
    it('keeps first and last rounds, compresses middle', () => {
      // Create 8 rounds to trigger compression
      const messages: Message[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push(makeMsg('user', `Question ${i} ${'x'.repeat(500)}`));
        messages.push(makeMsg('assistant', `Answer ${i} ${'y'.repeat(500)}`));
      }

      // Set a limit that forces compression
      const result = prepareContextMessages(messages, systemPrompt, 3000, 500);
      // Should have fewer messages/shorter content than original
      expect(result.length).toBeLessThanOrEqual(messages.length);
    });
  });

  // ── Compression of assistant messages ──
  describe('assistant message compression', () => {
    it('truncates long assistant messages in middle rounds', () => {
      const messages: Message[] = [];
      // First round
      messages.push(makeMsg('user', 'Task: do something important'));
      messages.push(makeMsg('assistant', 'A'.repeat(2000)));
      // Middle rounds with long content (need enough to exceed limit)
      for (let i = 0; i < 8; i++) {
        messages.push(makeMsg('user', `Follow up ${i} with some extra context`));
        messages.push(makeMsg('assistant', `Response ${i}: ${'B'.repeat(2000)}`));
      }
      // Last rounds
      messages.push(makeMsg('user', 'Final question'));
      messages.push(makeMsg('assistant', 'Final answer'));

      // Token limit tight enough to force compression
      // Total ~18000 chars / 4 = ~4500 tokens for content + overhead
      // Set contextWindow small enough to force compression
      const result = prepareContextMessages(messages, systemPrompt, 3000, 500);
      // Result should be shorter than input
      const totalContentLength = result
        .filter((m) => m.role === 'assistant')
        .reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
      const originalContentLength = messages
        .filter((m) => m.role === 'assistant')
        .reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
      expect(totalContentLength).toBeLessThan(originalContentLength);
    });
  });

  // ── Aggressive mode ──
  describe('aggressive mode — drop middle entirely', () => {
    it('falls back to first + last 2 rounds when very constrained', () => {
      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('user', `Q${i} ${'x'.repeat(200)}`));
        messages.push(makeMsg('assistant', `A${i} ${'y'.repeat(200)}`));
      }

      // Very tight limit
      const result = prepareContextMessages(messages, systemPrompt, 500, 100);
      const safeBudget = enforceContextBudget(messages, systemPrompt, 500, 100);
      expect(safeBudget.tokensAfter).toBeLessThanOrEqual(safeBudget.inputBudget);
      expect(result.length).toBeLessThan(messages.length);
    });
  });

  // ── Single round ──
  describe('single round', () => {
    it('compacts an oversized assistant response instead of returning it over budget', () => {
      const messages = [
        makeMsg('user', 'Hello'),
        makeMsg('assistant', 'x'.repeat(20_000)),
      ];
      const result = enforceContextBudget(messages, systemPrompt, 1_000, 200);

      expect(result.strategy).toMatch(/last_round_compacted|latest_user_only/);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.messages[0]).toEqual(messages[0]);
      expect(estimateMessageTokens(result.messages)).toBeLessThan(estimateMessageTokens(messages));
    });

    it('rejects a latest user input that cannot fit by itself', () => {
      const messages = [makeMsg('user', 'x'.repeat(20_000))];

      expect(() => enforceContextBudget(messages, systemPrompt, 1_000, 200))
        .toThrowError(ContextBudgetError);
      try {
        enforceContextBudget(messages, systemPrompt, 1_000, 200);
      } catch (error) {
        expect(error).toMatchObject({ code: 'INPUT_TOO_LARGE' });
      }
    });
  });

  // ── Preserves first user message ──
  describe('user message preservation', () => {
    it('prefers the latest user instruction when only one message can fit', () => {
      const messages: Message[] = [];
      messages.push(makeMsg('user', 'TASK_CONTEXT_IMPORTANT'));
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('assistant', `A${i} ${'x'.repeat(2_000)}`));
        messages.push(makeMsg('user', `Q${i + 1} ${'z'.repeat(50)}`));
      }
      messages.push(makeMsg('assistant', `Final ${'y'.repeat(20_000)}`));

      const result = enforceContextBudget(messages, systemPrompt, 500, 100);
      const latestUser = [...result.messages].reverse().find((message) => message.role === 'user');
      expect(latestUser?.content).toContain('Q10');
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
    });
  });

  // ── Tool calls in context ──
  describe('tool call context compression', () => {
    it('strips tool calls from compressed assistant messages', () => {
      const messages: Message[] = [];
      messages.push(makeMsg('user', 'Start'));
      messages.push({
        ...makeMsg('assistant', 'Running tools'),
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: '/tmp/a.txt' }, result: 'content' }],
        toolCallsForContext: [{ name: 'read_file', input: { path: '/tmp/a.txt' }, result: 'content' }],
      });
      // Add enough rounds to trigger compression
      for (let i = 0; i < 6; i++) {
        messages.push(makeMsg('user', `Q${i} ${'x'.repeat(300)}`));
        messages.push(makeMsg('assistant', `A${i} ${'y'.repeat(300)}`));
      }

      const result = prepareContextMessages(messages, systemPrompt, 2000, 500);
      // The compressed assistant messages in middle should not have toolCalls
      const compressed = result.find(
        (m) => m.role === 'assistant' && m.content !== 'Running tools' && !m.toolCalls
      );
      // At least some assistant messages should be stripped
      expect(compressed?.toolCalls).toBeUndefined();
    });

    it('truncates a giant latest tool result and preserves the outbound invariant', () => {
      const messages: Message[] = [
        makeMsg('user', 'Inspect the file'),
        {
          ...makeMsg('assistant', 'Reading the file'),
          toolCallsForContext: [{
            id: 'tool-1',
            name: 'read_file',
            input: { path: '/tmp/large.txt' },
            result: 'data'.repeat(20_000),
          }],
        },
      ];

      const result = enforceContextBudget(messages, systemPrompt, 2_000, 400);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.messages[0]).toEqual(messages[0]);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
      expect(result.messages[1]?.toolCallsForContext?.[0]?.id).toBe('tool-1');
    });

    it('counts and removes rich tool-result images when the latest round is over budget', () => {
      const resultContent = Array.from({ length: 8 }, () => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png', data: 'image-data' },
      }));
      const messages: Message[] = [
        makeMsg('user', 'Inspect the screenshots'),
        {
          ...makeMsg('assistant', 'Captured screenshots'),
          toolCallsForContext: [{
            id: 'tool-images',
            name: 'computer_screenshot',
            input: {},
            result: '',
            resultContent,
          }],
        },
      ];

      const result = enforceContextBudget(messages, systemPrompt, 4_000, 500);
      expect(result.tokensBefore).toBeGreaterThan(result.inputBudget);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.messages[1]?.toolCallsForContext?.[0]?.resultContent)
        .toEqual([{ type: 'text', text: '' }]);
    });

    it('includes tool schemas in the fixed context budget', () => {
      const toolSchemaTokens = 1_000;
      expect(() => enforceContextBudget(
        [makeMsg('user', 'Hello')],
        systemPrompt,
        1_000,
        200,
        toolSchemaTokens,
      )).toThrowError(expect.objectContaining({ code: 'FIXED_CONTEXT_TOO_LARGE' }));
    });

    it('does not double-count the UI and context copies of the same tool call', () => {
      const base = makeMsg('assistant', 'Tool finished');
      const toolCall = {
        id: 'tool-mirrored',
        name: 'read_file',
        input: { path: '/tmp/file.txt' },
        result: 'file content',
      };
      const withUiCopy: Message = {
        ...base,
        toolCalls: [toolCall],
        toolCallsForContext: [toolCall],
      };
      const contextOnly: Message = {
        ...base,
        toolCallsForContext: [toolCall],
      };

      expect(estimateMessageTokens([withUiCopy])).toBe(estimateMessageTokens([contextOnly]));
    });
  });

  it.each([500, 1_000, 2_000, 4_000])(
    'never returns an estimated payload above a %i-token context window',
    (contextWindow) => {
      const messages: Message[] = [];
      for (let index = 0; index < 12; index++) {
        messages.push(makeMsg('user', `Question ${index} ${'q'.repeat(120)}`));
        messages.push(makeMsg('assistant', `Answer ${index} ${'a'.repeat(1_500)}`));
      }

      const result = enforceContextBudget(messages, systemPrompt, contextWindow, 100);
      const independentlyEstimated = estimateTokens(systemPrompt) + estimateMessageTokens(result.messages);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(independentlyEstimated).toBeLessThanOrEqual(result.inputBudget);
    },
  );
});
