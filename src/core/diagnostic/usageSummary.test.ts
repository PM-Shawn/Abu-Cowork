import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  USAGE_AGGREGATE_FIELDS,
  emptyUsageAggregate,
  emptyUsageHealth,
  emptyUsageRangeResult,
  recordUsageAttempt,
  resetUsageSendFailures,
  type UsageAggregate,
  type UsageRangeResult,
} from '@/core/usage/usageLedgerClient';
import { baseAttempt } from '@/core/llm/__contractFixtures__/usageAttemptFixtures';
import {
  USAGE_DIAGNOSTIC_RECENT_DAYS,
  buildUsageDiagnosticSummary,
  collectUsageDiagnosticSummary,
} from './usageSummary';

/**
 * 诊断包里的用量汇总。
 *
 * 两件事要守住：汇总里的数字与账本返回的一致；除了范围汇总、覆盖、失败计数和
 * 错误码之外，账本返回的其他内容不进入诊断包。
 */

function aggregate(overrides: Partial<UsageAggregate>): UsageAggregate {
  return { ...emptyUsageAggregate(), ...overrides };
}

function rangeResult(): UsageRangeResult {
  return {
    available: true,
    byDay: [
      { localDate: '2026-09-05', ...aggregate({ attempts: 1, inputKnownSum: 10 }) },
      { localDate: '2026-09-06', ...aggregate({ attempts: 2, inputKnownSum: 20 }) },
      { localDate: '2026-10-05', ...aggregate({ attempts: 4, inputKnownSum: 40, outputUnknownAttempts: 1 }) },
    ],
    bySource: [
      { source: 'main', ...aggregate({ attempts: 5, inputKnownSum: 50 }) },
      { source: 'compaction', ...aggregate({ attempts: 2, inputKnownSum: 20 }) },
    ],
    byModel: [{ requestedModel: 'claude-sonnet-5', ...aggregate({ attempts: 7 }) }],
    bySkill: [{ skill: 'my-private-skill', ...aggregate({ attempts: 3 }) }],
    totals: aggregate({
      attempts: 7,
      inputKnownSum: 70,
      outputUnknownAttempts: 1,
      cacheComparableAttempts: 6,
      incompleteAttempts: 1,
    }),
    statsOriginLocalDate: '2026-09-05',
    health: {
      writeFailures: 3,
      rejectedFrames: 1,
      firstFailureAtUtc: 1_760_000_000_000,
      lastFailureAtUtc: 1_760_000_600_000,
      lastErrorCode: 'SQLITE_CANTOPEN',
      degradedCode: null,
    },
  };
}

const OPTIONS = { todayLocalDate: '2026-10-05', recentFromLocalDate: '2026-09-06', rendererSendFailures: 2 };

describe('诊断包的用量汇总', () => {
  describe('buildUsageDiagnosticSummary', () => {
    it('带上全部范围的合计与按来源的分组', () => {
      const summary = buildUsageDiagnosticSummary(rangeResult(), OPTIONS);

      expect(summary.schemaVersion).toBe(1);
      expect(summary.available).toBe(true);
      expect(summary.statsOriginLocalDate).toBe('2026-09-05');
      expect(summary.allTime.fromLocalDate).toBe('0000-01-01');
      expect(summary.allTime.toLocalDate).toBe('9999-12-31');
      expect(summary.allTime.totals).toEqual(rangeResult().totals);
      expect(summary.allTime.bySource).toEqual(rangeResult().bySource);
    });

    it('逐日汇总只留最近的窗口，窗口两端的日期都算在内', () => {
      const summary = buildUsageDiagnosticSummary(rangeResult(), OPTIONS);

      expect(summary.recentDays.fromLocalDate).toBe('2026-09-06');
      expect(summary.recentDays.toLocalDate).toBe('2026-10-05');
      expect(summary.recentDays.byDay.map((row) => row.localDate)).toEqual(['2026-09-06', '2026-10-05']);
    });

    it('日期晚于今天的记录不进逐日窗口，合计里照常有它', () => {
      const range = rangeResult();
      range.byDay.push({ localDate: '2026-10-09', ...aggregate({ attempts: 3 }) });
      range.totals = aggregate({ attempts: 10 });

      const summary = buildUsageDiagnosticSummary(range, OPTIONS);

      expect(summary.recentDays.byDay.map((row) => row.localDate)).toEqual(['2026-09-06', '2026-10-05']);
      expect(summary.allTime.totals.attempts).toBe(10);
    });

    it('带上失败计数、错误码与 renderer 一侧没送到的次数', () => {
      const summary = buildUsageDiagnosticSummary(rangeResult(), OPTIONS);

      expect(summary.health).toEqual(rangeResult().health);
      expect(summary.rendererSendFailures).toBe(2);
    });

    it('不带模型名与技能名', () => {
      const text = JSON.stringify(buildUsageDiagnosticSummary(rangeResult(), OPTIONS));

      expect(text).not.toContain('claude-sonnet-5');
      expect(text).not.toContain('my-private-skill');
      expect(text).not.toContain('byModel');
      expect(text).not.toContain('bySkill');
    });

    it('账本多返回的字段不进入诊断包', () => {
      const range = rangeResult();
      const leaky = {
        ...range,
        totals: { ...range.totals, conversationId: 'conv-secret' },
        bySource: [{ ...range.bySource[0], lastPrompt: 'secret prompt' }],
        byDay: [{ ...range.byDay[2], conversationId: 'conv-secret' }],
        health: { ...range.health, lastErrorMessage: '/Users/someone/private/usage.sqlite' },
      } as unknown as UsageRangeResult;

      const summary = buildUsageDiagnosticSummary(leaky, OPTIONS);
      const text = JSON.stringify(summary);

      expect(text).not.toContain('conv-secret');
      expect(text).not.toContain('secret prompt');
      expect(text).not.toContain('/Users/someone');
      expect(Object.keys(summary.allTime.totals).sort()).toEqual([...USAGE_AGGREGATE_FIELDS].sort());
      expect(Object.keys(summary.health).sort()).toEqual(Object.keys(emptyUsageHealth()).sort());
    });

    it('账本读不到时仍给出完整的形状，available 为 false', () => {
      const summary = buildUsageDiagnosticSummary(emptyUsageRangeResult(), { ...OPTIONS, rendererSendFailures: 0 });

      expect(summary.available).toBe(false);
      expect(summary.statsOriginLocalDate).toBeNull();
      expect(summary.allTime.totals).toEqual(emptyUsageAggregate());
      expect(summary.allTime.bySource).toEqual([]);
      expect(summary.recentDays.byDay).toEqual([]);
      expect(summary.health).toEqual(emptyUsageHealth());
    });
  });

  describe('collectUsageDiagnosticSummary', () => {
    // 本地时间 2026-10-05 中午。用本地时间构造，结果不随运行机器的时区变化。
    const NOON = new Date(2026, 9, 5, 12, 0, 0);

    beforeEach(() => {
      resetUsageSendFailures();
      vi.mocked(invoke).mockReset();
    });

    it('查询账本里的全部日期，逐日窗口是含今天在内的最近 30 天', async () => {
      vi.mocked(invoke).mockResolvedValue(rangeResult());

      const summary = await collectUsageDiagnosticSummary(NOON);

      expect(invoke).toHaveBeenCalledWith('usage_query_range', {
        fromLocalDate: '0000-01-01',
        toLocalDate: '9999-12-31',
      });
      expect(summary.recentDays.toLocalDate).toBe('2026-10-05');
      expect(USAGE_DIAGNOSTIC_RECENT_DAYS).toBe(30);
      expect(summary.recentDays.fromLocalDate).toBe('2026-09-06');
      expect(summary.recentDays.byDay.map((row) => row.localDate)).toEqual(['2026-09-06', '2026-10-05']);
    });

    it('主进程不认识查询命令时，给出 available 为 false 的汇总', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);

      const summary = await collectUsageDiagnosticSummary(NOON);

      expect(summary.available).toBe(false);
      expect(summary.allTime.totals.attempts).toBe(0);
    });

    it('查询被拒绝时不向调用方抛出错误', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('ipc down'));

      await expect(collectUsageDiagnosticSummary(NOON)).resolves.toMatchObject({ available: false });
    });

    it('带上本次运行里 renderer 没送到的次数', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('ipc down'));
      recordUsageAttempt(baseAttempt());
      await Promise.resolve();
      await Promise.resolve();
      vi.mocked(invoke).mockResolvedValue(rangeResult());

      const summary = await collectUsageDiagnosticSummary(NOON);

      expect(summary.rendererSendFailures).toBe(1);
    });
  });
});
