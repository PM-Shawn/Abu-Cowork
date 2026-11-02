import { describe, it, expect, vi } from 'vitest';
import { writeCompactionSummary, type SummaryRequest } from './contextCompressor';
import type { Message, StreamEvent } from '../../types';
import { LLMError, type LLMAdapter } from '../llm/adapter';

const conversation: Message[] = [
  { id: 'u1', role: 'user', content: 'Refactor the parser', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: 'Reading the files', timestamp: 2 },
];

function request(chat: LLMAdapter['chat'], overrides: Partial<SummaryRequest> = {}): SummaryRequest {
  return {
    adapter: { chat } as LLMAdapter,
    chatOptions: {
      model: 'm',
      apiKey: 'k',
      systemPrompt: 'SYSTEM',
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } }],
      maxTokens: 8_000,
      thinkingBudget: 4_000,
      enableThinking: true,
      volatileContextTail: 'TODOS',
    },
    conversationId: 'conv-1',
    providerInstanceId: 'p1',
    ...overrides,
  };
}

function replying(...events: StreamEvent[]) {
  return vi.fn(async (_messages: Message[], _options: unknown, onEvent: (event: StreamEvent) => void) => {
    for (const event of events) onEvent(event);
  });
}

describe('writeCompactionSummary', () => {
  it('sends the conversation itself, then one instruction, with the conversation\'s own options', async () => {
    const chat = replying({ type: 'text', text: '  The summary.  ' }, { type: 'done', stopReason: 'end_turn' });

    const summary = await writeCompactionSummary(conversation, request(chat));

    expect(summary).toBe('The summary.');
    const [messages, options] = chat.mock.calls[0];
    expect(messages.slice(0, 2)).toEqual(conversation);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ role: 'user' });
    expect(messages[2].content).toContain('Do not call any tools');
    // Same prefix as the conversation's requests, so its cache is reused;
    // the output and thinking budgets stay a matched pair.
    expect(options).toMatchObject({
      model: 'm',
      systemPrompt: 'SYSTEM',
      maxTokens: 8_000,
      thinkingBudget: 4_000,
      accounting: { source: 'compaction', conversationId: 'conv-1', skill: null, providerInstanceId: 'p1' },
    });
    expect((options as { tools: unknown[] }).tools).toHaveLength(1);
    // The per-step tail (todos, memories) is not part of what is summarized.
    expect((options as { volatileContextTail?: string }).volatileContextTail).toBeUndefined();
  });

  it('appends the anchor section to the instruction only when preserveAnchors is on', async () => {
    const withoutAnchors = replying({ type: 'text', text: 's' }, { type: 'done', stopReason: 'end_turn' });
    const withAnchors = replying({ type: 'text', text: 's' }, { type: 'done', stopReason: 'end_turn' });

    await writeCompactionSummary(conversation, request(withoutAnchors));
    await writeCompactionSummary(conversation, request(withAnchors, { preserveAnchors: true }));

    const off = (withoutAnchors.mock.calls[0][0] as Message[]).at(-1)!;
    const on = (withAnchors.mock.calls[0][0] as Message[]).at(-1)!;
    expect(String(off.content)).not.toContain('Kept anchors');
    expect(String(on.content)).toContain('10. Kept anchors — copy verbatim every plan-step line, file path and URL');
  });

  it('retries a transient provider error and returns the summary of the attempt that succeeded', async () => {
    vi.useFakeTimers();
    const chat = vi.fn()
      .mockRejectedValueOnce(new LLMError('overloaded', 'overloaded', { retryable: true }))
      .mockImplementationOnce(async (_m: Message[], _o: unknown, onEvent: (event: StreamEvent) => void) => {
        onEvent({ type: 'text', text: 'second try' });
      });
    try {
      const pending = writeCompactionSummary(conversation, request(chat));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toBe('second try');
      expect(chat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws an error the provider will not retry', async () => {
    const chat = vi.fn().mockRejectedValue(new LLMError('rejected', 'content_policy', { retryable: false }));
    await expect(writeCompactionSummary(conversation, request(chat))).rejects.toThrow('rejected');
  });

  it('throws when the summary comes back empty', async () => {
    const chat = replying({ type: 'text', text: '   ' }, { type: 'done', stopReason: 'end_turn' });
    await expect(writeCompactionSummary(conversation, request(chat))).rejects.toThrow('empty');
  });

  it('throws when the stream reports an error', async () => {
    const chat = replying({ type: 'text', text: 'partial' }, { type: 'error', error: 'stream broke' });
    await expect(writeCompactionSummary(conversation, request(chat))).rejects.toThrow('stream broke');
  });

  it('rejects a partial summary when the adapter reports cancellation', async () => {
    const chat = replying({ type: 'text', text: 'partial summary' }, { type: 'done', stopReason: 'cancelled' });
    await expect(writeCompactionSummary(conversation, request(chat))).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects a partial summary when the signal is aborted before the adapter returns', async () => {
    const controller = new AbortController();
    const chat = vi.fn(async (_messages: Message[], _options: unknown, onEvent: (event: StreamEvent) => void) => {
      onEvent({ type: 'text', text: 'partial summary' });
      controller.abort();
      onEvent({ type: 'done', stopReason: 'end_turn' });
    });
    await expect(writeCompactionSummary(conversation, request(chat, { signal: controller.signal })))
      .rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects a summary that also calls a tool', async () => {
    const chat = replying(
      { type: 'text', text: 'partial summary' },
      { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: '/work/a.ts' } },
      { type: 'done', stopReason: 'tool_use' },
    );
    await expect(writeCompactionSummary(conversation, request(chat))).rejects.toThrow('contained a tool call');
  });
});
