import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

import { OpenAICompatibleAdapter } from './openai-compatible';

function makeSSEResponse(chunks: unknown[]): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function opts(o: Partial<ChatOptions> = {}): ChatOptions {
  return {
    model: 'glm-5.1-external',
    apiKey: 'k',
    baseUrl: 'https://api.test/v1',
    maxTokens: 100,
    tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: {}, required: [] }, execute: async () => 'ok' } as ToolDefinition],
    ...o,
  };
}

// Exact repro of conversation mr6949f59zuixs: agent read a PNG from an extracted
// zip; read_file returned a vision image block; next turn was sent to glm-5.1-external
// (vision=false) and GLM rejected it (400 code 1210: content.type must be ['text']).
const messages: Message[] = [
  { id: 'u1', role: 'user', content: '看看这里有啥', timestamp: 1 },
  {
    id: 'a1', role: 'assistant', content: '', timestamp: 2,
    toolCalls: [{
      id: 'tc1', name: 'read_file', input: { path: '/tmp/x/图片.png' },
      result: 'Image: /tmp/x/图片.png (251KB, image/png)',
      resultContent: [
        { type: 'text', text: 'Image: /tmp/x/图片.png (251KB, image/png)' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64PNG' } },
      ],
    }],
  },
];

describe('OpenAICompatibleAdapter — non-vision model must not receive image_url', () => {
  beforeEach(() => mockFetch.mockReset());

  it('sends NO image_url to a supportsVision:false model', async () => {
    mockFetch.mockResolvedValueOnce(makeSSEResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await new OpenAICompatibleAdapter().chat(messages, opts({ supportsVision: false }), () => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const wire = JSON.stringify(body.messages);
    expect(wire).not.toContain('image_url');
    expect(wire).not.toContain('BASE64PNG');
  });
});
