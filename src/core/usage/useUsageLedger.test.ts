// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  DAILY_WINDOW_DAYS,
  localDateBefore,
  localToday,
  useUsageLedger,
} from './useUsageLedger';
import * as client from './usageLedgerClient';
import { emptyUsageAggregate, emptyUsageHealth, type UsageRangeResult } from './usageLedgerClient';

/**
 * 用量页的数据来源（期 1 第 4 步）。
 *
 * 盯三件事：日期一律按本机时区的真实日历日；读不到时保留上一份结果并标注暂未更新，
 * 用户的统计不会被清成零；晚到的旧查询结果写不进当前的时间段。
 */

function result(overrides: Partial<UsageRangeResult> = {}): UsageRangeResult {
  return {
    available: true,
    byDay: [],
    bySource: [],
    byModel: [],
    bySkill: [],
    totals: emptyUsageAggregate(),
    statsOriginLocalDate: null,
    health: emptyUsageHealth(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('本地日历日', () => {
  it('取本机时区的日历日，不是 UTC 折算', () => {
    // 对照组是 Intl 的独立实现（en-CA 即 YYYY-MM-DD）。任何基于 toISOString()
    // 的实现都会在非 UTC 机器上与它分岔——反馈里"凌晨被记到前一天"正是那种实现。
    const instant = new Date('2026-09-14T23:51:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(instant);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      expect(localToday()).toBe(fmt.format(instant));
    } finally {
      vi.useRealTimers();
    }
  });

  it('往前数天数也按本地日历走', () => {
    const base = new Date(2026, 8, 15, 12, 0);
    expect(localDateBefore(0, base)).toBe('2026-09-15');
    expect(localDateBefore(1, base)).toBe('2026-09-14');
    expect(localDateBefore(15, base)).toBe('2026-08-31');
  });

  it('热图窗口是 52 周', () => {
    expect(DAILY_WINDOW_DAYS).toBe(364);
  });
});

describe('取数', () => {
  it('按所选时间段与近 52 周各取一次', async () => {
    const spy = vi.spyOn(client, 'queryUsageRange').mockResolvedValue(result());
    renderHook(() => useUsageLedger('today'));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const today = localToday();
    expect(spy).toHaveBeenCalledWith(today, today);
    expect(spy).toHaveBeenCalledWith(localDateBefore(DAILY_WINDOW_DAYS - 1), today);
  });

  it('「全部」的起点不设下界，终点是今天', async () => {
    const spy = vi.spyOn(client, 'queryUsageRange').mockResolvedValue(result());
    renderHook(() => useUsageLedger('all'));

    await waitFor(() => expect(spy).toHaveBeenCalledWith('0000-01-01', localToday()));
  });
});

describe('快速切换时间段', () => {
  it('先点的时间段后返回时，它的结果不会盖掉当前时间段', async () => {
    // 「全部」是全表扫描，比「今日」慢。用户打开页面立刻点「今日」，
    // 两个查询的返回顺序就与点击顺序相反。
    let releaseAll: (value: UsageRangeResult) => void = () => {};
    const allTime = result({ totals: { ...emptyUsageAggregate(), attempts: 999 } });
    const today = result({ totals: { ...emptyUsageAggregate(), attempts: 7 } });
    const todayDate = localToday();

    vi.spyOn(client, 'queryUsageRange').mockImplementation((from: string, to: string) => {
      if (from === '0000-01-01') {
        return new Promise<UsageRangeResult>((resolve) => {
          releaseAll = resolve;
        });
      }
      if (from === todayDate && to === todayDate) return Promise.resolve(today);
      return Promise.resolve(result());
    });

    const { result: hook, rerender } = renderHook(({ p }) => useUsageLedger(p), {
      initialProps: { p: 'all' as 'all' | 'today' },
    });
    rerender({ p: 'today' });
    await waitFor(() => expect(hook.current.period.totals.attempts).toBe(7));

    releaseAll(allTime);
    await Promise.resolve();
    await Promise.resolve();
    expect(hook.current.period.totals.attempts).toBe(7);
  });

  it('切换时间段不重取近 52 周的逐日数据', async () => {
    const spy = vi.spyOn(client, 'queryUsageRange').mockResolvedValue(result());
    const { rerender } = renderHook(({ p }) => useUsageLedger(p), {
      initialProps: { p: 'all' as 'all' | 'week' },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    rerender({ p: 'week' });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    const dailyFrom = localDateBefore(DAILY_WINDOW_DAYS - 1);
    expect(spy.mock.calls.filter(([from]) => from === dailyFrom)).toHaveLength(1);
  });
});

describe('读不到的时候', () => {
  it('保留上一份结果并标注暂未更新，不清成零', async () => {
    const filled = result({
      byDay: [{ localDate: '2026-09-15', ...emptyUsageAggregate(), attempts: 3 }],
      totals: { ...emptyUsageAggregate(), attempts: 3, inputKnownSum: 1234 },
      statsOriginLocalDate: '2026-09-01',
    });
    const spy = vi.spyOn(client, 'queryUsageRange').mockResolvedValue(filled);
    const { result: hook, rerender } = renderHook(({ p }) => useUsageLedger(p), {
      initialProps: { p: 'all' as const },
    });

    await waitFor(() => expect(hook.current.period.totals.attempts).toBe(3));
    expect(hook.current.stale).toBe(false);

    // 下一次取数失败：数字必须原样留着。
    spy.mockResolvedValue(result({ available: false, totals: emptyUsageAggregate() }));
    hook.current.refresh();

    await waitFor(() => expect(hook.current.stale).toBe(true));
    expect(hook.current.period.totals.attempts).toBe(3);
    expect(hook.current.period.totals.inputKnownSum).toBe(1234);
    expect(hook.current.period.statsOriginLocalDate).toBe('2026-09-01');
    rerender({ p: 'all' as const });
  });

  it('库停写时健康计数仍然刷新，页面说得出原因', async () => {
    const spy = vi.spyOn(client, 'queryUsageRange').mockResolvedValue(result());
    const { result: hook } = renderHook(() => useUsageLedger('all'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    spy.mockResolvedValue(
      result({
        available: false,
        health: { ...emptyUsageHealth(), degradedCode: 'corrupt', writeFailures: 2 },
      }),
    );
    hook.current.refresh();

    await waitFor(() => expect(hook.current.period.health.degradedCode).toBe('corrupt'));
    expect(hook.current.period.health.writeFailures).toBe(2);
  });
});
