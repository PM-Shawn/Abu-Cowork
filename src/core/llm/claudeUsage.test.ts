import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent, TokenUsage } from '../../types';
import type { UsageAttempt } from './usageAccounting';

/**
 * Claude 适配器的用量采集（期 1 第 3 步）。
 *
 * 这里跑的是真实的适配器与真实的采集器，只把出口换成一个数组——出口背后是
 * 跨进程的 IPC 与 stdout 帧，那两段由各自的契约测试盯着。
 *
 * 盯两件事：结束事件必须带着流内已经拿到的缓存读写（反馈里"缓存命中率恒为零"
 * 的直接成因），以及 SDK 自己重试时账本里有两条尝试。
 */

vi.mock('./tauriFetch', () => ({
  getTauriFetch: vi.fn().mockResolvedValue(vi.fn()),
}));

const emitted: UsageAttempt[] = [];
vi.mock('./usageSink', () => ({
  emitUsageAttempt: (attempt: UsageAttempt) => {
    emitted.push(attempt);
  },
}));

/** SDK 每次真实请求都会调用注入的 fetch —— 尝试身份就铸在那一层。 */
let httpCallsPerCreate = 1;
let streamEvents: unknown[] = [];

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(options: { fetch: (...args: unknown[]) => unknown }) {
        mockCreate.mockImplementation(async () => {
          for (let i = 0; i < httpCallsPerCreate; i += 1) {
            options.fetch('https://api.anthropic.com/v1/messages', {});
          }
          return {
            [Symbol.asyncIterator]: async function* () {
              for (const event of streamEvents) yield event;
            },
          };
        });
      }
    },
    APIError: class MockAPIError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    },
  };
});

import { ClaudeAdapter } from './claude';

const FIXED_TIMESTAMP = 1_700_000_000_000;

const MESSAGE_START = {
  type: 'message_start',
  message: {
    model: 'claude-opus-5-20260101',
    usage: {
      input_tokens: 1000,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
      output_tokens: 1,
    },
  },
};

const MESSAGE_DELTA_DONE = {
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 500 },
};

async function runChat(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await new ClaudeAdapter().chat(
    [{ id: '1', role: 'user', content: '你好', timestamp: FIXED_TIMESTAMP }],
    {
      model: 'claude-opus-5',
      apiKey: 'k',
      accounting: {
        source: 'main',
        conversationId: 'conv-1',
        skill: null,
        providerInstanceId: 'provider-1',
      },
    },
    (event) => events.push(event),
  );
  return events;
}

beforeEach(() => {
  emitted.length = 0;
  httpCallsPerCreate = 1;
  streamEvents = [MESSAGE_START, MESSAGE_DELTA_DONE];
  vi.clearAllMocks();
});

describe('结束事件带着缓存读写', () => {
  it('done 的用量含缓存三项与输入总数，不只有输出', async () => {
    const events = await runChat();
    const done = events.find((e) => e.type === 'done') as
      | { type: 'done'; usage?: TokenUsage }
      | undefined;

    expect(done?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 800,
    });
  });

  it('结束事件不带输入时不把它补成 0', async () => {
    // message_delta 只报输出，这是 Anthropic 的常态。补 0 会让下游把输入算没。
    const events = await runChat();
    const done = events.find((e) => e.type === 'done') as { usage?: TokenUsage } | undefined;
    expect(done?.usage?.inputTokens).toBe(1000);
  });

  it('连接中途断了也把已经拿到的用量交出去', async () => {
    streamEvents = [MESSAGE_START];
    const events = await runChat();
    const done = events.find((e) => e.type === 'done') as { usage?: TokenUsage } | undefined;
    expect(done?.usage?.cacheReadInputTokens).toBe(800);
  });
});

describe('进账本的尝试', () => {
  it('一次请求一条尝试，用量按 Anthropic 口径归一化', async () => {
    await runChat();

    const ids = [...new Set(emitted.map((a) => a.attemptId))];
    expect(ids).toHaveLength(1);

    const last = emitted.at(-1)!;
    expect(last.outcome).toBe('succeeded');
    expect(last.protocol).toBe('anthropic');
    expect(last.source).toBe('main');
    expect(last.conversationId).toBe('conv-1');
    expect(last.servedModel).toBe('claude-opus-5-20260101');
    // input_tokens 不含缓存，所以总量是三项之和。
    expect(last.usage.inputTotal).toBe(2000);
    expect(last.usage.uncachedInput).toBe(1000);
    expect(last.usage.cacheRead).toBe(800);
    expect(last.usage.cacheWrite).toBe(200);
    expect(last.usage.outputTotal).toBe(500);
    expect(last.usage.evidence).toBe('final');
  });

  it('SDK 内部重试时账本里是两条尝试，前一条按失败结清', async () => {
    httpCallsPerCreate = 2;
    await runChat();

    const ids = [...new Set(emitted.map((a) => a.attemptId))];
    expect(ids).toHaveLength(2);
    expect(emitted.filter((a) => a.attemptId === ids[0]).at(-1)?.outcome).toBe('failed');
    expect(emitted.filter((a) => a.attemptId === ids[1]).at(-1)?.outcome).toBe('succeeded');
    // 两次尝试属于同一次逻辑调用。
    expect(new Set(emitted.map((a) => a.logicalCallId)).size).toBe(1);
  });

  it('流被切断时尝试记为中断，且带上已知的那部分用量', async () => {
    streamEvents = [MESSAGE_START];
    await runChat();

    const last = emitted.at(-1)!;
    expect(last.outcome).toBe('interrupted');
    expect(last.usage.cacheRead).toBe(800);
    // 没有最终结算证据，累计值不能冒充最终值。
    expect(last.usage.evidence).toBe('partial');
  });

  it('请求发出就先记一条，此时还没有任何用量', async () => {
    await runChat();
    const first = emitted[0];
    expect(first.revision).toBe(0);
    expect(first.outcome).toBe('running');
    expect(first.usage.evidence).toBe('none');
  });
});
