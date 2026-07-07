/**
 * Issue #86: gpt-5.5 rejects "function tools + reasoning_effort" on
 * /v1/chat/completions. The adapter must drop reasoning_effort for that exact
 * combo (gpt-5.5 + tools) while keeping it everywhere else. Verified by
 * capturing the actual request body the adapter POSTs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

import { OpenAICompatibleAdapter } from './openai-compatible';

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'] },
  execute: async () => 'ok',
} as ToolDefinition;

const userMsg: Message = { id: 'm1', role: 'user', content: 'hi', timestamp: 0 };

async function capture(opts: Partial<ChatOptions>): Promise<{ url: string; body: Record<string, unknown> }> {
  let url = '';
  let body: Record<string, unknown> = {};
  mockFetch.mockImplementationOnce(async (u: string, init: { body: string }) => {
    url = u;
    body = JSON.parse(init.body);
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  const adapter = new OpenAICompatibleAdapter();
  await adapter.chat([userMsg], {
    model: 'gpt-5.5', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', maxTokens: 4096, ...opts,
  }, () => {});
  return { url, body };
}

describe('URL normalization (Phase 3)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('posts to full endpoint when baseUrl already has /chat/completions (idempotent)', async () => {
    const { url } = await capture({ baseUrl: 'https://api.example.com/v1/chat/completions' });
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('useRawUrl posts to exact baseUrl without normalization', async () => {
    const { url } = await capture({
      baseUrl: 'https://proxy.corp/gw',
      declaredCapabilities: { useRawUrl: true },
    });
    expect(url).toBe('https://proxy.corp/gw');
  });
});

describe('gpt-5.5 + tools reasoning_effort handling (issue #86)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('drops reasoning_effort when gpt-5.5 has tools (the rejected combo), but keeps the tools', async () => {
    const { url, body } = await capture({ tools: [readFileTool], reasoningEffort: 'medium' });
    expect(url).toBe('https://api.openai.com/v1/chat/completions');   // still chat/completions
    expect(body.reasoning_effort).toBeUndefined();                    // the key OpenAI rejects
    expect(Array.isArray(body.tools)).toBe(true);                     // tools still sent
  });

  it('keeps reasoning_effort for gpt-5.5 WITHOUT tools (combo is allowed)', async () => {
    const { body } = await capture({ reasoningEffort: 'medium' });
    expect(body.reasoning_effort).toBe('medium');
  });

  it('keeps reasoning_effort for gpt-5 + tools (not the 5.5 family)', async () => {
    const { body } = await capture({ model: 'gpt-5', tools: [readFileTool], reasoningEffort: 'medium' });
    expect(body.reasoning_effort).toBe('medium');
  });

  it('keeps reasoning_effort for gpt-5.5-chat-latest only when it has no tools', async () => {
    const withTools = await capture({ model: 'gpt-5.5-chat-latest', tools: [readFileTool], reasoningEffort: 'high' });
    expect(withTools.body.reasoning_effort).toBeUndefined();
    const noTools = await capture({ model: 'gpt-5.5-chat-latest', reasoningEffort: 'high' });
    expect(noTools.body.reasoning_effort).toBe('high');
  });
});
