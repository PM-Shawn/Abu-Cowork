import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  USAGE_FIXTURES,
  type UsageFixtureEntry,
} from './__contractFixtures__/usageFixtures';
import {
  UNKNOWN_TIME_ZONE,
  cacheBreakdownComplete,
  emptyAccountingUsage,
  localCalendarParts,
  mergeAccountingUsage,
  normalizeWireUsage,
  promptTokensOf,
  totalsComplete,
  type AccountingUsage,
} from './usageAccounting';

/**
 * 用量口径的契约测试（期 1 第 1 步）。
 *
 * 样例表在 `__contractFixtures__/usageFixtures.ts`，期 1 第 3 步的适配器流解析测试
 * 会读同一份表——两端任一单方面改动都会红，见该文件头部说明。
 */

function runFixture(entry: UsageFixtureEntry): AccountingUsage {
  return entry.events.reduce<AccountingUsage>(
    (acc, ev) => mergeAccountingUsage(acc, normalizeWireUsage(entry.protocol, ev.wire, ev.evidence)),
    emptyAccountingUsage(),
  );
}

describe('用量归一化：逐字段契约', () => {
  it.each(USAGE_FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, entry) => {
    expect(runFixture(entry)).toEqual(entry.expected);
  });

  it('样例表覆盖了 AccountingUsage 的每一个计数字段与每一种证据强度', () => {
    // 完整性对着**真实类型的 live 键集**比，不硬编码数量：
    // 新增一个计数字段而没人给它写样例，这里会红。
    const countFields = (Object.keys(emptyAccountingUsage()) as (keyof AccountingUsage)[]).filter(
      (k) => k !== 'evidence' && k !== 'invalidFields',
    );
    for (const field of countFields) {
      const covered = USAGE_FIXTURES.some((f) => f.expected[field] !== null);
      expect(covered, `没有任何样例让 ${String(field)} 取到已知值`).toBe(true);
      const coveredUnknown = USAGE_FIXTURES.some((f) => f.expected[field] === null);
      expect(coveredUnknown, `没有任何样例让 ${String(field)} 保持未知`).toBe(true);
    }

    expect(new Set(USAGE_FIXTURES.map((f) => f.protocol))).toEqual(
      new Set(['anthropic', 'openai-compatible']),
    );
    expect(new Set(USAGE_FIXTURES.map((f) => f.expected.evidence))).toEqual(
      new Set(['none', 'partial', 'final']),
    );
  });

  it('每条样例都写明了它盯的是什么', () => {
    for (const f of USAGE_FIXTURES) {
      expect(f.pins.length, `${f.name} 缺少 pins 说明`).toBeGreaterThan(20);
    }
  });
});

describe('累计快照语义', () => {
  it('后续事件缺字段时不覆盖已知值，且任何字段都不相加', () => {
    const start = normalizeWireUsage(
      'anthropic',
      { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 2 },
      'partial',
    );
    const tail = normalizeWireUsage('anthropic', { output_tokens: 40 }, 'final');
    const merged = mergeAccountingUsage(start, tail);

    expect(merged.uncachedInput).toBe(100);
    expect(merged.cacheRead).toBe(50);
    // 40 是累计值不是增量：不能变成 2 + 40。
    expect(merged.outputTotal).toBe(40);
  });

  it('证据强度只能变强，最终结算不会被随后的流内快照降级', () => {
    const final = normalizeWireUsage('openai-compatible', { prompt_tokens: 10, completion_tokens: 5 }, 'final');
    const late = normalizeWireUsage('openai-compatible', { completion_tokens: 6 }, 'partial');
    expect(mergeAccountingUsage(final, late).evidence).toBe('final');
  });

  it('同一次尝试重复并入同一份快照，结果不变（幂等）', () => {
    const snap = normalizeWireUsage(
      'anthropic',
      { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 1, output_tokens: 9 },
      'final',
    );
    const once = mergeAccountingUsage(emptyAccountingUsage(), snap);
    const twice = mergeAccountingUsage(once, snap);
    expect(twice).toEqual(once);
  });
});

describe('完整性判定', () => {
  it('流内累计值即便输入输出都有数，也不算总量完整', () => {
    const partial = normalizeWireUsage(
      'anthropic',
      { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 4 },
      'partial',
    );
    expect(partial.inputTotal).toBe(10);
    expect(partial.outputTotal).toBe(4);
    expect(totalsComplete(partial)).toBe(false);
  });

  it('缺缓存细分不等于总量未知——两个维度分开判', () => {
    const noCache = normalizeWireUsage(
      'openai-compatible',
      { prompt_tokens: 1000, completion_tokens: 200 },
      'final',
    );
    expect(totalsComplete(noCache)).toBe(true);
    expect(cacheBreakdownComplete(noCache)).toBe(false);
  });
});

describe('本地日历归属', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offsetMinutes 用 IANA 符号：UTC+8 为 +480，UTC-5 为 -300', () => {
    // 这个符号必须在协议层固定下来：只看字段名无法判断方向，而 JS 的
    // getTimezoneOffset() 对 UTC+8 返回 -480，与 IANA 习惯正好相反。
    const fixed = new Date('2026-09-15T00:00:00.000Z');
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);
    expect(localCalendarParts(fixed).offsetMinutes).toBe(480);

    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(300);
    expect(localCalendarParts(fixed).offsetMinutes).toBe(-300);
  });

  it('日期取本机时区的真实日历日，不经 UTC 折算', () => {
    // 对照组是 Intl 的独立实现（en-CA 即 YYYY-MM-DD），不是拿函数自己比自己。
    // 任何基于 toISOString() 的实现在非 UTC 机器上都会在这里红——
    // 反馈里"北京时间 07:51 被记到前一天"正是那种实现造成的。
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    for (const instant of [
      new Date(Date.UTC(2026, 8, 14, 23, 51)), // 东八区的次日凌晨
      new Date(Date.UTC(2026, 8, 15, 16, 5)), // 西半球的前一日傍晚
      new Date(Date.UTC(2026, 0, 1, 0, 0)), // 跨年边界
    ]) {
      expect(localCalendarParts(instant).localDate).toBe(fmt.format(instant));
    }
  });

  it('同一本地日内的午夜两端归同一天', () => {
    const justAfterMidnight = new Date(2026, 8, 15, 0, 5);
    const justBeforeMidnight = new Date(2026, 8, 15, 23, 55);
    expect(localCalendarParts(justAfterMidnight).localDate).toBe('2026-09-15');
    expect(localCalendarParts(justBeforeMidnight).localDate).toBe('2026-09-15');
  });

  it('时区标识是有效的 IANA 标识', () => {
    const { tzId } = localCalendarParts(new Date('2026-09-15T00:00:00.000Z'));
    expect(tzId.length).toBeGreaterThan(0);
    expect(() => new Intl.DateTimeFormat('en-CA', { timeZone: tzId })).not.toThrow();
  });
});

describe('时区名取不到的环境', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('用占位值顶上，tzId 仍是非空字符串，日期与偏移照常给出', () => {
    // 环境变量 TZ 写成运行时认不出的值时 timeZone 是 undefined。主进程的入口校验
    // 要求 tzId 非空，缺了它每一条用量都会被拒绝，账本永远是空的。
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: undefined,
    } as unknown as Intl.ResolvedDateTimeFormatOptions);

    const parts = localCalendarParts(new Date(2026, 8, 15, 7, 51));
    expect(parts.tzId).toBe(UNKNOWN_TIME_ZONE);
    expect(parts.tzId.length).toBeGreaterThan(0);
    expect(parts.localDate).toBe('2026-09-15');
    expect(Number.isSafeInteger(parts.offsetMinutes)).toBe(true);
  });
});

describe('给 token 估算器校准用的提示词大小', () => {
  it('Anthropic：输入不含缓存，三项加起来才是整段提示词', () => {
    // 开了提示缓存的长对话里 inputTokens 可以只有几百。直接拿它校准，
    // 估算比例会被拉到接近零，压缩就不再触发。
    expect(
      promptTokensOf('anthropic', {
        inputTokens: 600,
        cacheReadInputTokens: 48_000,
        cacheCreationInputTokens: 1_400,
      }),
    ).toBe(50_000);
  });

  it('Anthropic：缓存字段缺失时按零计', () => {
    expect(promptTokensOf('anthropic', { inputTokens: 1200 })).toBe(1200);
  });

  it('OpenAI 兼容协议：prompt_tokens 已含缓存读，不再加一次', () => {
    expect(
      promptTokensOf('openai-compatible', { inputTokens: 1000, cacheReadInputTokens: 800 }),
    ).toBe(1000);
  });
});

describe('不可信字段', () => {
  it.each([
    ['非有限值', { prompt_tokens: Number.NaN }],
    ['无穷大', { prompt_tokens: Number.POSITIVE_INFINITY }],
    ['小数', { prompt_tokens: 1.5 }],
    ['负数', { prompt_tokens: -1 }],
    ['超出安全整数', { prompt_tokens: Number.MAX_SAFE_INTEGER + 2 }],
    ['字符串', { prompt_tokens: '100' }],
  ])('%s 不进入可信计数，并记下字段名', (_label, wire) => {
    const usage = normalizeWireUsage('openai-compatible', wire as Record<string, unknown>, 'final');
    expect(usage.inputTotal).toBeNull();
    expect(usage.invalidFields).toContain('prompt_tokens');
  });

  it('未上报与乱报是两回事：缺字段不记入 invalidFields', () => {
    const usage = normalizeWireUsage('openai-compatible', { completion_tokens: 5 }, 'final');
    expect(usage.inputTotal).toBeNull();
    expect(usage.invalidFields).toEqual([]);
  });

  it('相加溢出安全整数范围时判总量未知', () => {
    const usage = normalizeWireUsage(
      'anthropic',
      {
        input_tokens: Number.MAX_SAFE_INTEGER,
        cache_read_input_tokens: Number.MAX_SAFE_INTEGER,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
      'final',
    );
    expect(usage.uncachedInput).toBe(Number.MAX_SAFE_INTEGER);
    expect(usage.inputTotal).toBeNull();
    expect(usage.invalidFields).toContain('inputTotal');
  });
});
