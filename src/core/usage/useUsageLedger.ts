/**
 * 用量页的数据来源（期 1 第 4 步）。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`。
 *
 * 三条规则写在这里，页面只管渲染：
 *  - 日期一律按本机时区的真实日历日，与账本里的 `localDate` 同一个算法。
 *  - 读失败保留上一份结果并标注暂未更新，绝不清成零（任务书 U05）。
 *  - 页面长开跨午夜自动重新取数，今天的格子跟着日期走。
 *
 * 两组数据分开取：所选时间段的汇总随时间段切换重取；近 52 周的逐日数据只随
 * 本地日期变化重取，切换时间段不动它。每次取数各带自己的作废标记，
 * 晚到的旧结果写不进状态——快速连点两个时间段时，先点的那个查询可能后返回。
 */

import { useCallback, useEffect, useState } from 'react';
import { localDateOf } from '../llm/usageAccounting';
import { emptyUsageRangeResult, queryUsageRange, type UsageRangeResult } from './usageLedgerClient';

export type UsagePeriod = 'today' | 'week' | 'month' | 'all';

/** 本机时区的今天。 */
export function localToday(): string {
  return localDateOf(new Date());
}

/** 本机时区的某一天，`base` 之前 `daysBefore` 天。 */
export function localDateBefore(daysBefore: number, base: Date = new Date()): string {
  const d = new Date(base);
  d.setDate(d.getDate() - daysBefore);
  return localDateOf(d);
}

/** 热图与每日条形图要看的窗口：52 周。 */
export const DAILY_WINDOW_DAYS = 364;

function rangeFor(period: UsagePeriod): { from: string; to: string } {
  const today = localToday();
  if (period === 'today') return { from: today, to: today };
  if (period === 'week') return { from: localDateBefore(6), to: today };
  if (period === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: '0000-01-01', to: today };
}

export interface UsageLedgerView {
  /** 所选时间段的汇总、按模型与按技能分组。 */
  period: UsageRangeResult;
  /** 近 52 周的逐日汇总，热图与每日条形图用。 */
  daily: UsageRangeResult;
  /** 上一次取数没成功，界面上显示的是此前的结果。 */
  stale: boolean;
  refresh: () => void;
}

interface Slot {
  result: UsageRangeResult;
  stale: boolean;
}

function emptySlot(): Slot {
  return { result: emptyUsageRangeResult(), stale: false };
}

/** 取不到就保留上一份数字，只刷新健康计数——库停写时页面得说得出原因。 */
function applyResult(prev: Slot, next: UsageRangeResult): Slot {
  if (next.available) return { result: next, stale: false };
  return { result: { ...prev.result, health: next.health }, stale: true };
}

export function useUsageLedger(period: UsagePeriod): UsageLedgerView {
  const [periodSlot, setPeriodSlot] = useState<Slot>(emptySlot);
  const [dailySlot, setDailySlot] = useState<Slot>(emptySlot);
  const [day, setDay] = useState(localToday);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const span = rangeFor(period);
    void queryUsageRange(span.from, span.to).then((next) => {
      if (!cancelled) setPeriodSlot((prev) => applyResult(prev, next));
    });
    return () => {
      cancelled = true;
    };
  }, [period, day, tick]);

  useEffect(() => {
    let cancelled = false;
    void queryUsageRange(localDateBefore(DAILY_WINDOW_DAYS - 1), localToday()).then((next) => {
      if (!cancelled) setDailySlot((prev) => applyResult(prev, next));
    });
    return () => {
      cancelled = true;
    };
  }, [day, tick]);

  // 跨午夜：只在本地日历日真的变了才重新取数。
  useEffect(() => {
    const timer = setInterval(() => {
      const now = localToday();
      setDay((prev) => (prev === now ? prev : now));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return {
    period: periodSlot.result,
    daily: dailySlot.result,
    stale: periodSlot.stale || dailySlot.stale,
    refresh,
  };
}
