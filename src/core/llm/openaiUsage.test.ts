import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamEvent } from '../../types';
import type { ChatOptions } from './adapter';
import type { UsageAttempt } from './usageAccounting';

/**
 * OpenAI 兼容适配器的用量采集（期 1 第 3 步）。
 *
 * 盯三件事：尾部 usage 按 OpenAI 口径归一化（`prompt_tokens` 已含缓存读，
 * 不能再加一次）；限额重试在账本里是两条尝试；企业网关上的 Claude 同时报缓存写时
 * 总量判未知而分项照实保留。
 */

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

const emitted: UsageAttempt[] = [];
vi.mock('./usageSink', () => ({
  emitUsageAttempt: (attempt: UsageAttempt) => {
    emitted.push(attempt);
  },
}));

import { OpenAICompatibleAdapter } from './openai-compatible';

const FIXED_TIMESTAMP = 1_700_000_000_000;

const userMessage: Message = {
  id: 'm1',
  role: 'user',
  content: '你好',
  timestamp: FIXED_TIMESTAMP,
};

function makeOptions(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return {
    model: 'gpt-6-astra',
    apiKey: 'test-key',
    baseUrl: 'https://api.test.example.com/v1',
    maxTokens: 100,
    accounting: {
      source: 'main',
      conversationId: 'conv-1',
      skill: null,
      providerInstanceId: 'provider-1',
    },
    ...overrides,
  };
}

function sseResponse(chunks: unknown[]): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function usageChunk(usage: Record<string, unknown>): unknown {
  return { model: 'gpt-6-astra-2026', choices: [{ delta: {}, finish_reason: null }], usage };
}

const STOP_CHUNK = { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] };

async function runChat(overrides: Partial<ChatOptions> = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await new OpenAICompatibleAdapter().chat(
    [userMessage],
    makeOptions(overrides),
    (e) => events.push(e),
  );
  return events;
}

beforeEach(() => {
  emitted.length = 0;
  mockFetch.mockReset();
});

describe('尾部结算', () => {
  it('prompt_tokens 已含缓存读，未缓存部分由相减得出', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        usageChunk({
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 800 },
          completion_tokens_details: { reasoning_tokens: 120 },
        }),
        STOP_CHUNK,
      ]),
    );
    await runChat();

    const last = emitted.at(-1)!;
    expect(last.protocol).toBe('openai-compatible');
    expect(last.outcome).toBe('succeeded');
    expect(last.usage.inputTotal).toBe(1000);
    expect(last.usage.uncachedInput).toBe(200);
    expect(last.usage.cacheRead).toBe(800);
    // OpenAI 侧没有缓存写概念，保持未知，不补零。
    expect(last.usage.cacheWrite).toBeNull();
    expect(last.usage.outputTotal).toBe(500);
    expect(last.usage.reasoningOutput).toBe(120);
    expect(last.usage.evidence).toBe('final');
  });

  it('usage 块排在结束块之后（OpenAI 的标准顺序）时照样并入同一次尝试', async () => {
    // 开了 include_usage 之后，usage 是结束块后面单独的一块、choices 为空。
    // 适配器在结束块上就结清了，这块迟到的用量不能丢，也不能把结束时间写回空。
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        STOP_CHUNK,
        { model: 'gpt-6-astra-2026', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 } } },
      ]),
    );
    await runChat();

    expect(new Set(emitted.map((a) => a.attemptId)).size).toBe(1);
    const last = emitted.at(-1)!;
    expect(last.outcome).toBe('succeeded');
    expect(last.endedAtUtc).not.toBeNull();
    expect(last.usage.inputTotal).toBe(1200);
    expect(last.usage.cacheRead).toBe(400);
    expect(last.usage.outputTotal).toBe(300);
    expect(last.usage.evidence).toBe('final');
  });

  it('记下 provider 实际服务的模型', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([usageChunk({ prompt_tokens: 10, completion_tokens: 2 }), STOP_CHUNK]),
    );
    await runChat();
    expect(emitted.at(-1)?.servedModel).toBe('gpt-6-astra-2026');
  });

  it('企业网关上的 Claude 同时报缓存写时，总量判未知，分项照实保留', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        usageChunk({
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 800 },
          cache_creation_input_tokens: 200,
        }),
        STOP_CHUNK,
      ]),
    );
    await runChat();

    const last = emitted.at(-1)!;
    // 无法判断 prompt_tokens 是否已含缓存写，就不给一个构成不明的总量。
    expect(last.usage.inputTotal).toBeNull();
    expect(last.usage.uncachedInput).toBeNull();
    expect(last.usage.cacheRead).toBe(800);
    expect(last.usage.cacheWrite).toBe(200);
  });

  it('provider 一个用量字段都没给时，全部保持未知，不变成一排零', async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([STOP_CHUNK]));
    await runChat();

    const last = emitted.at(-1)!;
    expect(last.outcome).toBe('succeeded');
    expect(last.usage.inputTotal).toBeNull();
    expect(last.usage.outputTotal).toBeNull();
    expect(last.usage.evidence).toBe('none');
  });
});

describe('尝试身份', () => {
  it('一次请求一条尝试', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([usageChunk({ prompt_tokens: 10, completion_tokens: 2 }), STOP_CHUNK]),
    );
    await runChat();
    expect(new Set(emitted.map((a) => a.attemptId)).size).toBe(1);
  });

  it('限额重试是第二条尝试，前一条按失败结清', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              param: 'max_tokens',
              message: 'max_tokens too large: 100. This model supports at most 64.',
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        sseResponse([usageChunk({ prompt_tokens: 10, completion_tokens: 2 }), STOP_CHUNK]),
      );

    await runChat();

    const ids = [...new Set(emitted.map((a) => a.attemptId))];
    expect(ids).toHaveLength(2);
    expect(emitted.filter((a) => a.attemptId === ids[0]).at(-1)?.outcome).toBe('failed');
    expect(emitted.filter((a) => a.attemptId === ids[1]).at(-1)?.outcome).toBe('succeeded');
    expect(new Set(emitted.map((a) => a.logicalCallId)).size).toBe(1);
  });

  it('请求失败时尝试记为失败，不停在进行中', async () => {
    mockFetch.mockResolvedValueOnce(new Response('bad key', { status: 401 }));
    await expect(runChat()).rejects.toThrow();

    expect(emitted.at(-1)?.outcome).toBe('failed');
    expect(emitted.at(-1)?.endedAtUtc).not.toBeNull();
  });

  it('用户取消时记为取消，与失败分开', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementationOnce(() => {
      controller.abort();
      const err = new Error('Request cancelled');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(runChat({ signal: controller.signal })).rejects.toThrow();
    expect(emitted.at(-1)?.outcome).toBe('cancelled');
  });

  it('调用方没给记账身份时按来源不明记，请求不会从账本里消失', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([usageChunk({ prompt_tokens: 10, completion_tokens: 2 }), STOP_CHUNK]),
    );
    await runChat({ accounting: undefined });

    expect(emitted.at(-1)?.source).toBe('other');
    expect(emitted.at(-1)?.providerInstanceId).toBe('unknown');
  });
});
