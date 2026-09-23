import { describe, it, expect } from 'vitest';
import { createUsageRecorder, type UsageAccountingContext } from './usageRecorder';
import type { UsageAttempt } from './usageAccounting';

/**
 * 采集器的行为（期 1 第 3 步）。
 *
 * 盯三件事：一次真实的 HTTP 请求对应账本里一条尝试；同一次尝试的多次上报是修订，
 * 数字不相加；任何路径下尝试都不会停在「进行中」。
 */

function setup(overrides: { accounting?: UsageAccountingContext } = {}) {
  const emitted: UsageAttempt[] = [];
  let clock = 1_789_000_000_000;
  let idSeq = 0;
  const recorder = createUsageRecorder({
    protocol: 'anthropic',
    requestedModel: 'claude-opus-5',
    accounting: overrides.accounting ?? {
      source: 'main',
      conversationId: 'conv-1',
      skill: null,
      providerInstanceId: 'provider-1',
    },
    sink: (attempt) => emitted.push(attempt),
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    newId: () => {
      idSeq += 1;
      return `id-${idSeq}`;
    },
  });
  return { recorder, emitted };
}

describe('一次请求一条尝试', () => {
  it('请求发出就记一条，此时用量还全是未知', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].revision).toBe(0);
    expect(emitted[0].outcome).toBe('running');
    expect(emitted[0].endedAtUtc).toBeNull();
    expect(emitted[0].usage.inputTotal).toBeNull();
    expect(emitted[0].usage.evidence).toBe('none');
  });

  it('没发出过请求就收尾，什么都不记', () => {
    const { recorder, emitted } = setup();
    recorder.settle('failed');
    expect(emitted).toEqual([]);
  });

  it('同一次尝试的多次上报共用一个身份，revision 递增', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.observeUsage({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, 'partial');
    recorder.observeUsage({ output_tokens: 500 }, 'final');
    recorder.settle('succeeded');

    expect(new Set(emitted.map((a) => a.attemptId)).size).toBe(1);
    expect(emitted.map((a) => a.revision)).toEqual([0, 1, 2, 3]);
  });

  it('后来的事件缺字段不覆盖已知值，也不相加', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.observeUsage({ input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 }, 'partial');
    recorder.observeUsage({ output_tokens: 500 }, 'final');
    recorder.settle('succeeded');

    const last = emitted[emitted.length - 1];
    expect(last.usage.uncachedInput).toBe(100);
    expect(last.usage.cacheRead).toBe(50);
    expect(last.usage.cacheWrite).toBe(10);
    // 500 是累计值：不能变成 1 + 500。
    expect(last.usage.outputTotal).toBe(500);
    expect(last.usage.evidence).toBe('final');
  });
});

describe('重试各成一条尝试', () => {
  it('第二次请求另起身份，上一条按失败结清', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.beginAttempt();
    recorder.observeUsage({ input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 }, 'final');
    recorder.settle('succeeded');

    const ids = [...new Set(emitted.map((a) => a.attemptId))];
    expect(ids).toHaveLength(2);

    const firstFinal = emitted.filter((a) => a.attemptId === ids[0]).at(-1);
    expect(firstFinal?.outcome).toBe('failed');
    expect(firstFinal?.endedAtUtc).not.toBeNull();

    const secondFinal = emitted.filter((a) => a.attemptId === ids[1]).at(-1);
    expect(secondFinal?.outcome).toBe('succeeded');
    expect(secondFinal?.usage.outputTotal).toBe(2);
  });

  it('两次尝试属于同一次逻辑调用', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.beginAttempt();
    expect(new Set(emitted.map((a) => a.logicalCallId)).size).toBe(1);
  });

  it('重试不继承上一次的用量', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.observeUsage({ input_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 }, 'partial');
    recorder.beginAttempt();

    expect(emitted.at(-1)?.usage.uncachedInput).toBeNull();
    expect(emitted.at(-1)?.revision).toBe(0);
  });
});

describe('收尾', () => {
  it('结清是幂等的，第一个结果说了算', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.settle('cancelled');
    const countAfterFirst = emitted.length;
    recorder.settle('failed');
    recorder.settle('succeeded');

    expect(emitted).toHaveLength(countAfterFirst);
    expect(emitted.at(-1)?.outcome).toBe('cancelled');
  });

  it('尾部用量排在结束之后才到：用量并入，结果与结束时间都保持不变', () => {
    // OpenAI 协议开了 include_usage 之后，usage 块排在带 finish_reason 的结束块
    // **之后**到达。适配器在结束块上就已经结清，这条迟到的用量是同一次尝试的又一条
    // 修订——它必须带着已经定下来的结果和结束时间，账本按 revision 取最新，
    // 写回 null 就等于把一次已完成的请求改回了没结束。
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.settle('succeeded');
    const settled = emitted.at(-1)!;
    expect(settled.endedAtUtc).not.toBeNull();

    recorder.observeUsage({ input_tokens: 1200, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 300 }, 'final');

    const late = emitted.at(-1)!;
    expect(late.attemptId).toBe(settled.attemptId);
    expect(late.revision).toBe(settled.revision + 1);
    expect(late.outcome).toBe('succeeded');
    expect(late.endedAtUtc).toBe(settled.endedAtUtc);
    expect(late.usage.outputTotal).toBe(300);
    expect(late.usage.evidence).toBe('final');
  });

  it('重试另起的那次尝试从没有结束时间开始', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    recorder.beginAttempt();
    expect(emitted.at(-1)?.outcome).toBe('running');
    expect(emitted.at(-1)?.endedAtUtc).toBeNull();
  });

  it('取消与失败在账本里是两种结果', () => {
    const cancelled = setup();
    cancelled.recorder.beginAttempt();
    cancelled.recorder.settle('cancelled');
    expect(cancelled.emitted.at(-1)?.outcome).toBe('cancelled');

    const failed = setup();
    failed.recorder.beginAttempt();
    failed.recorder.settle('failed');
    expect(failed.emitted.at(-1)?.outcome).toBe('failed');
  });
});

describe('身份字段', () => {
  it('来源、会话、技能、服务商都照调用方给的记', () => {
    const { recorder, emitted } = setup({
      accounting: {
        source: 'compaction',
        conversationId: 'conv-9',
        skill: 'code-review',
        providerInstanceId: 'provider-9',
      },
    });
    recorder.beginAttempt();

    expect(emitted[0]).toMatchObject({
      source: 'compaction',
      conversationId: 'conv-9',
      skill: 'code-review',
      providerInstanceId: 'provider-9',
      protocol: 'anthropic',
      requestedModel: 'claude-opus-5',
    });
  });

  it('调用方没给记账身份时按来源不明记，不是丢掉这次请求', () => {
    const emitted: UsageAttempt[] = [];
    const recorder = createUsageRecorder({
      protocol: 'openai-compatible',
      requestedModel: 'gpt-6-astra',
      sink: (attempt) => emitted.push(attempt),
      now: () => new Date('2026-09-15T04:00:00.000Z'),
      newId: () => 'id-x',
    });
    recorder.beginAttempt();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].source).toBe('other');
    expect(emitted[0].conversationId).toBeNull();
    expect(emitted[0].providerInstanceId).toBe('unknown');
  });

  it('provider 实际服务的模型按上报记，没上报就保持未知', () => {
    const { recorder, emitted } = setup();
    recorder.beginAttempt();
    expect(emitted[0].servedModel).toBeNull();

    recorder.noteServedModel('claude-opus-5-20260101');
    recorder.settle('succeeded');
    expect(emitted.at(-1)?.servedModel).toBe('claude-opus-5-20260101');
  });

  it('本地日历日取请求开始的时刻', () => {
    const emitted: UsageAttempt[] = [];
    const startedAt = new Date(2026, 8, 15, 7, 51);
    const recorder = createUsageRecorder({
      protocol: 'anthropic',
      requestedModel: 'claude-opus-5',
      sink: (attempt) => emitted.push(attempt),
      now: () => startedAt,
      newId: () => 'id-x',
    });
    recorder.beginAttempt();

    expect(emitted[0].localDate).toBe('2026-09-15');
    expect(emitted[0].startedAtUtc).toBe(startedAt.getTime());
  });
});

describe('用量上报很密的网关', () => {
  function setupWithClock() {
    const emitted: UsageAttempt[] = [];
    const clock = { ms: 1_789_000_000_000 };
    let idSeq = 0;
    const recorder = createUsageRecorder({
      protocol: 'openai-compatible',
      requestedModel: 'gpt-6-astra',
      sink: (attempt) => emitted.push(attempt),
      now: () => new Date(clock.ms),
      newId: () => `id-${(idSeq += 1)}`,
    });
    return { recorder, emitted, clock };
  }

  it('数字没变的重复上报不再发出快照', () => {
    const { recorder, emitted, clock } = setupWithClock();
    recorder.beginAttempt();
    clock.ms += 5000;
    recorder.observeUsage({ prompt_tokens: 100, completion_tokens: 10 }, 'final');
    const after = emitted.length;
    for (let i = 0; i < 500; i += 1) {
      clock.ms += 5000;
      recorder.observeUsage({ prompt_tokens: 100, completion_tokens: 10 }, 'final');
    }
    expect(emitted).toHaveLength(after);
  });

  it('每个分块都在涨的累计用量限到每秒至多一份，结清时带上最新的数字', () => {
    const { recorder, emitted, clock } = setupWithClock();
    recorder.beginAttempt();
    // 两秒之内来了 2000 份，每份的输出数都比上一份大。
    for (let i = 1; i <= 2000; i += 1) {
      clock.ms += 1;
      recorder.observeUsage({ prompt_tokens: 100, completion_tokens: i }, 'final');
    }
    recorder.settle('succeeded');

    // 一份开始、至多三份中间值、一份结清。
    expect(emitted.length).toBeLessThanOrEqual(5);
    expect(emitted.at(-1)?.outcome).toBe('succeeded');
    expect(emitted.at(-1)?.usage.outputTotal).toBe(2000);
  });
});

describe('采集器自己出问题不影响调用方', () => {
  it('铸造身份时抛出，模型请求路径上看不到任何异常', () => {
    const recorder = createUsageRecorder({
      protocol: 'anthropic',
      requestedModel: 'claude-opus-5',
      sink: () => {},
      now: () => new Date('2026-09-15T04:00:00.000Z'),
      newId: () => {
        throw new TypeError('crypto.randomUUID is not a function');
      },
    });

    // beginAttempt 在 fetch 包装层里调用：这里抛出，模型请求就直接失败了。
    expect(() => recorder.beginAttempt()).not.toThrow();
    expect(() => recorder.observeUsage({ input_tokens: 1 }, 'final')).not.toThrow();
    expect(() => recorder.settle('succeeded')).not.toThrow();
  });

  it('构造采集器这一步不铸造任何身份', () => {
    let minted = 0;
    createUsageRecorder({
      protocol: 'anthropic',
      requestedModel: 'claude-opus-5',
      sink: () => {},
      newId: () => `id-${(minted += 1)}`,
    });
    expect(minted).toBe(0);
  });
});

describe('出口出问题不影响调用方', () => {
  it('出口抛出时采集器自己吞掉，不冒到模型请求路径上', () => {
    const recorder = createUsageRecorder({
      protocol: 'anthropic',
      requestedModel: 'claude-opus-5',
      sink: () => {
        throw new Error('sink is down');
      },
      now: () => new Date('2026-09-15T04:00:00.000Z'),
      newId: () => 'id-x',
    });

    expect(() => recorder.beginAttempt()).not.toThrow();
    expect(() => recorder.observeUsage({ input_tokens: 1 }, 'final')).not.toThrow();
    expect(() => recorder.settle('succeeded')).not.toThrow();
  });
});
