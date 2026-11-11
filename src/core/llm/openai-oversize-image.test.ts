import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../types';
import type { ChatOptions } from './adapter';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

import { OpenAICompatibleAdapter } from './openai-compatible';

/**
 * A tool-result picture larger than the route takes on a side went into the
 * request as it was, the provider answered 400 "unsupported image", and the
 * run ended. read_file resizes by file size only, so a wide PNG of a few
 * hundred KB reaches the request whole.
 *
 * Only the header matters here: the request is built from the image block's
 * bytes, and the size is in the PNG header.
 */

function pngHeader(w: number, h: number): string {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, w);
  new DataView(png.buffer).setUint32(20, h);
  png.set([8, 6], 24);
  return btoa(String.fromCharCode(...png));
}

const HUGE = pngHeader(10032, 4178);
const SMALL = pngHeader(1600, 667);

function readCall(id: string, data: string, sizeKB: number) {
  const text = `Image: /tmp/work/preview.png (${sizeKB}KB, image/png)`;
  return {
    id, name: 'read_file', input: { path: '/tmp/work/preview.png' },
    result: text,
    resultContent: [
      { type: 'text' as const, text },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data } },
    ],
  };
}

const history: Message[] = [
  { id: 'u1', role: 'user', content: 'Draw the layout', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: '', timestamp: 2, toolCallsForContext: [readCall('c1', SMALL, 198)] } as Message,
  { id: 'a2', role: 'assistant', content: '', timestamp: 3, toolCallsForContext: [readCall('c2', HUGE, 1718)] } as Message,
];

function opts(o: Partial<ChatOptions> = {}): ChatOptions {
  return { model: 'deepseek-flash', apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 100, supportsVision: true, ...o };
}

function sse(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function wire(messages: Message[], o: Partial<ChatOptions> = {}): Promise<string> {
  mockFetch.mockResolvedValueOnce(sse());
  await new OpenAICompatibleAdapter().chat(messages, opts(o), () => {});
  return JSON.stringify(JSON.parse(mockFetch.mock.calls.at(-1)![1].body as string).messages);
}

describe('a tool-result picture larger than the route takes', () => {
  beforeEach(() => mockFetch.mockReset());

  it('never reaches the request; the model is told its size and what to do', async () => {
    const sent = await wire(history);
    expect(sent).not.toContain(HUGE);
    // The picture the route takes still goes.
    expect(sent).toContain(SMALL);
    expect(sent).toContain('10032×4178 px');
  });

  it('is judged by the route\'s hard limit, not the size we fit pictures to at entry', async () => {
    // Claude takes 8000 px on a side in a request of up to 20 pictures, DeepSeek 8192; the
    // 2000 px the composer fits to is no rejection, so a 3000 px tool picture goes out.
    const mid = pngHeader(3000, 1000);
    const wide = pngHeader(8100, 1000);
    const midMessages: Message[] = [
      history[0],
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, toolCallsForContext: [readCall('c1', mid, 900)] } as Message,
    ];
    const wideMessages: Message[] = [
      history[0],
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, toolCallsForContext: [readCall('c1', wide, 900)] } as Message,
    ];
    expect(await wire(midMessages, { model: 'deepseek-flash' })).toContain(mid);
    expect(await wire(midMessages, { model: 'claude-sonnet-4-5' })).toContain(mid);
    expect(await wire(midMessages, { model: 'gpt-4o' })).toContain(mid);
    expect(await wire(wideMessages, { model: 'deepseek-flash' })).toContain(wide);
    expect(await wire(wideMessages, { model: 'claude-sonnet-4-5' })).not.toContain(wide);
  });
});
