import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

import { OpenAICompatibleAdapter } from './openai-compatible';
import { resolveCapabilities } from './modelCapabilities';

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

describe('OpenAICompatibleAdapter — stripped image (empty base64) must not reach a vision model', () => {
  beforeEach(() => mockFetch.mockReset());

  // A persisted user-uploaded image whose base64 was stripped on disk (only
  // filePath survived) and was NOT rehydrated. Safety net: the serializer must
  // never emit `data:<mime>;base64,` with empty payload — that bricks the turn.
  const strippedMessages: Message[] = [
    {
      id: 'u1', role: 'user', timestamp: 1,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, filePath: 'D:/abu/shot.png' },
        { type: 'text', text: '看看这张图' },
      ],
    } as unknown as Message,
  ];

  it('drops the empty image instead of sending invalid base64 (vision model)', async () => {
    mockFetch.mockResolvedValueOnce(makeSSEResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await new OpenAICompatibleAdapter().chat(strippedMessages, opts({ supportsVision: true }), () => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const wire = JSON.stringify(body.messages);
    expect(wire).not.toContain('base64,"'); // no empty-payload data URI
    expect(wire).not.toContain('image_url');
    expect(wire).toContain('看看这张图'); // text still delivered
    expect(wire).toContain('could not be loaded'); // placeholder, not silent drop
  });
});

// The two tests above prove the serializer honours the `supportsVision` flag it is
// handed. This one closes the remaining link: that the *model id* Abu ships resolves
// to that flag, so declaring a route vision-capable actually changes the bytes on the
// wire. Without it, overlay/deepseek.json could say vision:true while images still
// got stripped, and every unit test above would stay green.
describe('OpenAICompatibleAdapter — DeepSeek vision route carries images end to end', () => {
  beforeEach(() => mockFetch.mockReset());

  const userImage: Message[] = [
    {
      id: 'u1', role: 'user', timestamp: 1,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64PNG' } },
        { type: 'text', text: '这张图里是什么' },
      ],
    } as unknown as Message,
  ];

  type WirePart = { type: string; text?: string };

  // The serializer collapses an all-text user message to a bare string and only
  // emits a parts array when a non-text part (i.e. an image) survives, so read
  // both shapes rather than assuming one.
  async function sendAs(modelId: string): Promise<{ wire: string; userText: string }> {
    mockFetch.mockResolvedValueOnce(makeSSEResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await new OpenAICompatibleAdapter().chat(
      userImage,
      opts({ model: modelId, supportsVision: resolveCapabilities(modelId).vision }),
      () => {},
    );
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string).messages as
      { role: string; content: string | WirePart[] }[];
    const content = sent.find((m) => m.role === 'user')?.content ?? '';
    return {
      wire: JSON.stringify(sent),
      userText: typeof content === 'string'
        ? content
        : content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
    };
  }

  it('deepseek-v4-flash-vision-exp receives the image as an image_url data URL', async () => {
    const { wire } = await sendAs('deepseek-v4-flash-vision-exp');
    expect(wire).toContain('image_url');
    expect(wire).toContain('data:image/png;base64,BASE64PNG');
    expect(wire).toContain('这张图里是什么');
  });

  it('deepseek-v4-flash gets the text plus an explicit no-vision note, never the image', async () => {
    const prompt = '这张图里是什么';
    const { wire, userText } = await sendAs('deepseek-v4-flash');
    expect(wire).not.toContain('image_url');
    expect(wire).not.toContain('BASE64PNG');
    expect(userText).toContain(prompt);

    // Degrades loudly: a note rides along so the model knows an image was dropped,
    // rather than silently seeing a picture-less prompt and inventing a description.
    // Asserted as "carries more than the user's own words" rather than by matching
    // the note's text, because its wording — and its language — is owned by
    // messageNormalizer and may be rewritten without changing this contract.
    expect(userText.replace(prompt, '').trim().length).toBeGreaterThan(0);
  });
});
