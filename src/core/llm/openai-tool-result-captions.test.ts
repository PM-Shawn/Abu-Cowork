import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

import { OpenAICompatibleAdapter } from './openai-compatible';
import { imageLabelBlock, TOOL_RESULT_IMAGES_INTRO, TOOL_RESULT_SCREENSHOTS_NOTE } from './toolResultImageCaptions';

function sse(): Response {
  const lines = [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }].map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const options: ChatOptions = {
  model: 'gpt-4o', apiKey: 'k', baseUrl: 'https://api.test/v1', maxTokens: 100, supportsVision: true,
  tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: {}, required: [] }, execute: async () => 'ok' } as ToolDefinition],
};

const png = { type: 'base64' as const, media_type: 'image/png', data: 'iVBORw0KGgo=' };

function history(calls: Array<{ id: string; name: string; content: Message['toolCalls'] extends (infer T)[] | undefined ? T : never }>): Message[] {
  return [
    { id: 'u1', role: 'user', content: 'look', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: '', timestamp: 2, toolCalls: calls.map((call) => call.content) },
  ];
}

async function userMessageAfterTools(messages: Message[]): Promise<Array<{ type: string; text?: string }>> {
  mockFetch.mockResolvedValueOnce(sse());
  await new OpenAICompatibleAdapter().chat(messages, options, () => {});
  const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string).messages as Array<{ role: string; content: unknown }>;
  const tail = sent.filter((m) => m.role !== 'system');
  const last = tail[tail.length - 1];
  return last.content as Array<{ type: string; text?: string }>;
}

describe('OpenAICompatibleAdapter — tool-result images are captioned by their call', () => {
  beforeEach(() => mockFetch.mockReset());

  it('puts each labeled image after a caption naming its call and label, under the neutral intro', async () => {
    const parts = await userMessageAfterTools(history([{
      id: 'tc1', name: 'read_file',
      content: {
        id: 'tc1', name: 'read_file', input: { path: '/d/a.pdf' }, result: 'manifest',
        resultContent: [
          { type: 'text', text: 'manifest' },
          imageLabelBlock('Page 3 of a.pdf, whole page'), { type: 'image', source: png },
          imageLabelBlock('Page 4 of a.pdf, whole page'), { type: 'image', source: png },
        ],
      },
    }]));
    expect(parts.map((part) => part.text ?? part.type)).toEqual([
      TOOL_RESULT_IMAGES_INTRO,
      '[Image 1 of 2, from read_file (call toolu_1_0): Page 3 of a.pdf, whole page]', 'image_url',
      '[Image 2 of 2, from read_file (call toolu_1_0): Page 4 of a.pdf, whole page]', 'image_url',
    ]);
  });

  it('keeps the screenshot note when an image has no label', async () => {
    const parts = await userMessageAfterTools(history([{
      id: 'tc1', name: 'read_file',
      content: {
        id: 'tc1', name: 'read_file', input: {}, result: 'Screenshot: 1280x800',
        resultContent: [{ type: 'text', text: 'Screenshot: 1280x800' }, { type: 'image', source: png }],
      },
    }]));
    expect(parts.map((part) => part.text ?? part.type)).toEqual([TOOL_RESULT_SCREENSHOTS_NOTE, '[Image 1 of 1, from read_file (call toolu_1_0)]', 'image_url']);
  });
});
