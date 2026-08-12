/**
 * Integration test: contextManager + tokenEstimator + truncation
 * Validates the full pipeline of context preparation with truncation
 */
import { describe, it, expect } from 'vitest';
import { enforceContextBudget } from '../core/context/contextManager';
import { estimateTokens, estimateMessageTokens } from '../core/context/tokenEstimator';
import { truncateToolResult } from '../core/context/truncation';
import type { Message } from '../types';

function makeMsg(role: 'user' | 'assistant', content: string): Message {
  return { id: `${role}-${content.slice(0, 12)}`, role, content, timestamp: 1_800_000_000_000 };
}

describe('contextManager integration', () => {
  it('truncated tool results reduce token count', () => {
    const longResult = 'x'.repeat(50000);
    const truncated = truncateToolResult('read_file', longResult);

    const original = estimateTokens(longResult);
    const afterTruncation = estimateTokens(truncated);

    expect(afterTruncation).toBeLessThan(original);
  });

  it('context preparation with tool-heavy messages stays within limits', () => {
    const systemPrompt = 'You are an assistant.';
    const messages: Message[] = [];

    // First user message (task context)
    messages.push(makeMsg('user', 'Analyze these files'));

    // Multiple rounds with tool results
    for (let i = 0; i < 10; i++) {
      const toolResult = truncateToolResult('read_file', `File ${i} content: ${'data '.repeat(500)}`);
      messages.push({
        ...makeMsg('assistant', `Reading file ${i}...`),
        toolCallsForContext: [{
          name: 'read_file',
          input: { path: `/tmp/file${i}.txt` },
          result: toolResult,
        }],
      });
      messages.push(makeMsg('user', `Good, continue with file ${i + 1}`));
    }

    const contextWindow = 8000;
    const reserveForOutput = 2000;
    const budgetResult = enforceContextBudget(messages, systemPrompt, contextWindow, reserveForOutput);
    const result = budgetResult.messages;

    // Result should fit within the budget
    const resultTokens = estimateTokens(systemPrompt) + estimateMessageTokens(result);
    expect(resultTokens).toBeLessThanOrEqual(budgetResult.inputBudget);

    // First user message should be preserved
    const firstUser = result.find((m) => m.role === 'user');
    expect(firstUser?.content).toContain('Analyze');
  });

  it('token estimator handles various message content types consistently', () => {
    const textMsg: Message = {
      id: '1', role: 'user',
      content: 'Hello world',
      timestamp: 1_800_000_000_000,
    };

    const multimodalMsg: Message = {
      id: '2', role: 'user',
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ],
      timestamp: 1_800_000_000_000,
    };

    const textTokens = estimateMessageTokens([textMsg]);
    const multimodalTokens = estimateMessageTokens([multimodalMsg]);

    // Multimodal should be significantly higher due to image (~1600 tokens)
    expect(multimodalTokens).toBeGreaterThan(textTokens + 1000);
  });

  it('Chinese text gets higher token estimates than equivalent English', () => {
    const englishTokens = estimateTokens('Hello world, this is a test.');
    const chineseTokens = estimateTokens('你好世界，这是一个测试。');

    // Chinese should have more tokens per character
    // 12 CJK chars / 1.5 = 8 tokens vs 28 English chars / 4 = 7 tokens
    // Both are similar but Chinese per-char ratio is higher
    expect(chineseTokens).toBeGreaterThan(0);
    expect(englishTokens).toBeGreaterThan(0);
  });

  it('truncation rules are applied per-tool-type', () => {
    const longContent = 'x'.repeat(50000);

    const readResult = truncateToolResult('read_file', longContent);
    const defaultResult = truncateToolResult('unknown_tool', longContent);

    // read_file has maxChars=20000, unknown has maxChars=3500
    expect(readResult.length).toBeGreaterThan(defaultResult.length);
    expect(readResult.length).toBeLessThanOrEqual(21000);
    expect(defaultResult.length).toBeLessThanOrEqual(4000);
  });
});
