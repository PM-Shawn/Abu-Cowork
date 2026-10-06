/**
 * 诊断包里的用量汇总（`usage/summary.json`）。
 *
 * 用量账本在主进程的 `usage.sqlite` 里，不属于任何 Zustand store，`collect.ts` 的
 * `PERSISTED_STORE_KEYS` 管不到它，所以单独取一次。
 *
 * 只输出四类内容：范围汇总、覆盖（各项未知的次数与可比的次数）、失败计数、稳定的
 * 错误码。不输出会话 id、模型名、技能名，也不输出任何请求内容。字段逐个挑选，
 * 主进程以后多返回的字段不会自动进入诊断包。
 */

import { localDateOf } from '@/core/llm/usageAccounting';
import {
  USAGE_AGGREGATE_FIELDS,
  getUsageSendFailures,
  queryUsageRange,
  type UsageAggregate,
  type UsageHealth,
  type UsageRangeResult,
} from '@/core/usage/usageLedgerClient';
import { localDateBefore } from '@/core/usage/useUsageLedger';

/** 逐日汇总只带最近这么多天，足够看出哪一天开始记不上。 */
export const USAGE_DIAGNOSTIC_RECENT_DAYS = 30;

/**
 * 「全部」范围的两端。上限取到最大的日期：系统时钟被调快过的机器上，账本里会有
 * 日期晚于今天的记录，诊断时要看得到它们。
 */
const ALL_TIME_FROM_LOCAL_DATE = '0000-01-01';
const ALL_TIME_TO_LOCAL_DATE = '9999-12-31';

export interface UsageDiagnosticSummary {
  schemaVersion: 1;
  /** false 表示这次没能从账本读到数，下面的合计都是零值。 */
  available: boolean;
  /** 账本里最早一条记录的本地日期。 */
  statsOriginLocalDate: string | null;
  allTime: {
    fromLocalDate: string;
    toLocalDate: string;
    totals: UsageAggregate;
    bySource: Array<UsageAggregate & { source: string }>;
  };
  recentDays: {
    fromLocalDate: string;
    toLocalDate: string;
    byDay: Array<UsageAggregate & { localDate: string }>;
  };
  /** 主进程的健康计数：写入失败、被拒绝的帧、首末失败时间、错误码、停写原因。 */
  health: UsageHealth;
  /** renderer 这一侧没能送到主进程的次数，只统计本次运行。 */
  rendererSendFailures: number;
}

function pickAggregate(row: UsageAggregate): UsageAggregate {
  return Object.fromEntries(USAGE_AGGREGATE_FIELDS.map((field) => [field, row[field]])) as UsageAggregate;
}

function pickHealth(health: UsageHealth): UsageHealth {
  return {
    writeFailures: health.writeFailures,
    rejectedFrames: health.rejectedFrames,
    firstFailureAtUtc: health.firstFailureAtUtc,
    lastFailureAtUtc: health.lastFailureAtUtc,
    lastErrorCode: health.lastErrorCode,
    degradedCode: health.degradedCode,
  };
}

/** 把一次「全部范围」的查询结果整理成诊断包里的汇总。 */
export function buildUsageDiagnosticSummary(
  range: UsageRangeResult,
  options: { todayLocalDate: string; recentFromLocalDate: string; rendererSendFailures: number },
): UsageDiagnosticSummary {
  return {
    schemaVersion: 1,
    available: range.available,
    statsOriginLocalDate: range.statsOriginLocalDate,
    allTime: {
      fromLocalDate: ALL_TIME_FROM_LOCAL_DATE,
      toLocalDate: ALL_TIME_TO_LOCAL_DATE,
      totals: pickAggregate(range.totals),
      bySource: range.bySource.map((row) => ({ source: row.source, ...pickAggregate(row) })),
    },
    recentDays: {
      fromLocalDate: options.recentFromLocalDate,
      toLocalDate: options.todayLocalDate,
      byDay: range.byDay
        .filter((row) => row.localDate >= options.recentFromLocalDate && row.localDate <= options.todayLocalDate)
        .map((row) => ({ localDate: row.localDate, ...pickAggregate(row) })),
    },
    health: pickHealth(range.health),
    rendererSendFailures: options.rendererSendFailures,
  };
}

/** 从账本读一次并整理。账本读不到时 `available` 为 false，不向调用方抛出错误。 */
export async function collectUsageDiagnosticSummary(now: Date = new Date()): Promise<UsageDiagnosticSummary> {
  const range = await queryUsageRange(ALL_TIME_FROM_LOCAL_DATE, ALL_TIME_TO_LOCAL_DATE);
  return buildUsageDiagnosticSummary(range, {
    todayLocalDate: localDateOf(now),
    recentFromLocalDate: localDateBefore(USAGE_DIAGNOSTIC_RECENT_DAYS - 1, now),
    rendererSendFailures: getUsageSendFailures(),
  });
}
