import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviewAction } from './reviewer';
import { llmCall } from '../llm/llmCall';

vi.mock('../llm/llmCall', () => ({ llmCall: vi.fn() }));

const mockLlmCall = vi.mocked(llmCall);
const ctx = { kind: 'command' as const, detail: 'cp x ~/Desktop/y', staticReason: '写入工作区外' };

describe('reviewer', () => {
  beforeEach(() => mockLlmCall.mockReset());

  it('low / medium risk → allow', async () => {
    mockLlmCall.mockResolvedValue({ text: '{"risk":"low","reason":"符合意图"}', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('allow');
    mockLlmCall.mockResolvedValue({ text: '{"risk":"medium","reason":"可控"}', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('allow');
  });

  it('high risk → escalate to user', async () => {
    mockLlmCall.mockResolvedValue({ text: '{"risk":"high","reason":"不确定"}', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('escalate');
  });

  it('critical risk → deny (and surfaces reason)', async () => {
    mockLlmCall.mockResolvedValue({ text: 'noise {"risk":"critical","reason":"疑似外泄"} trailing', toolCalls: [] });
    const v = await reviewAction(ctx);
    expect(v.decision).toBe('deny');
    expect(v.reason).toBe('疑似外泄');
  });

  it('parses JSON with full-width CJK punctuation', async () => {
    mockLlmCall.mockResolvedValue({ text: '{"risk"："low"，"reason":"符合意图"}', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('allow');
  });

  it('parses JSON wrapped in a markdown code fence', async () => {
    mockLlmCall.mockResolvedValue({ text: '```json\n{"risk":"critical","reason":"外泄"}\n```', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('deny');
  });

  it('parses final JSON after a reasoning preamble with stray braces', async () => {
    mockLlmCall.mockResolvedValue({ text: '<think>consider {x}</think> 结论:{"risk":"high","reason":"不确定"}', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('escalate');
  });

  it('empty response (reasoning-model starvation) → escalate', async () => {
    mockLlmCall.mockResolvedValue({ text: '   ', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('escalate');
  });

  it('unparseable response → escalate (conservative, never silently allows)', async () => {
    mockLlmCall.mockResolvedValue({ text: 'looks fine to me', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('escalate');
  });

  it('unrecognized risk value → escalate', async () => {
    mockLlmCall.mockResolvedValue({ text: '{"risk":"banana"}', toolCalls: [] });
    expect((await reviewAction(ctx)).decision).toBe('escalate');
  });

  it('llmCall throws → escalate, never silently allows', async () => {
    mockLlmCall.mockRejectedValueOnce(new Error('network down'));
    await expect(reviewAction(ctx)).resolves.toMatchObject({ decision: 'escalate' });
  });

  it('reviews on the conversation\'s own model, not the default', async () => {
    mockLlmCall.mockResolvedValue({ text: '{"risk":"low","reason":"ok"}', toolCalls: [] });
    await reviewAction({ ...ctx, conversationId: 'conv-42' });
    expect(mockLlmCall).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-42' }));
  });
});
