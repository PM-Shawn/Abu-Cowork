import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  USAGE_AGGREGATE_FIELDS,
  emptyUsageAggregate,
  emptyUsageHealth,
  getUsageSendFailures,
  queryUsageConversation,
  queryUsageHealth,
  queryUsageRange,
  recordUsageAttempt,
  resetUsageSendFailures,
} from './usageLedgerClient';
import { baseAttempt } from '../llm/__contractFixtures__/usageAttemptFixtures';

/**
 * renderer 一侧用量通道的行为（期 1 第 2 步）。
 *
 * 盯的是一件事：用量记账这条线上的任何失败，都不许冒到调用方那里去。
 * 调用它的是模型请求路径，抛出去就会打断用户正在进行的回答。
 */

describe('记一条用量尝试', () => {
  beforeEach(() => {
    resetUsageSendFailures();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ ok: true });
  });

  it('按约定的命令与参数发出', () => {
    const attempt = baseAttempt();
    recordUsageAttempt(attempt);
    expect(invoke).toHaveBeenCalledWith('usage_record', { attempt });
  });

  it('不返回任何东西，调用方无从等待', () => {
    expect(recordUsageAttempt(baseAttempt())).toBeUndefined();
  });

  it('送达之后主进程写失败，这边不再计一次', async () => {
    // 送达之后的失败由主进程的健康计数负责。两边都计，页面上那行
    // 「有 N 次请求未能记录」就会把同一次请求数成两次。
    vi.mocked(invoke).mockResolvedValue({ ok: false, code: 'readonly' });
    expect(() => recordUsageAttempt(baseAttempt())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(getUsageSendFailures()).toBe(0);
  });

  it('调用被拒绝时不产生未处理的拒绝', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('ipc down'));
    expect(() => recordUsageAttempt(baseAttempt())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(getUsageSendFailures()).toBe(1);
  });

  it('桥没就绪、invoke 同步抛出时也不抛给调用方', () => {
    vi.mocked(invoke).mockImplementation(() => {
      throw new Error('bridge not ready');
    });
    expect(() => recordUsageAttempt(baseAttempt())).not.toThrow();
    expect(getUsageSendFailures()).toBe(1);
  });

  it('成功时不累加失败计数', async () => {
    recordUsageAttempt(baseAttempt());
    await Promise.resolve();
    await Promise.resolve();
    expect(getUsageSendFailures()).toBe(0);
  });
});

describe('读用量', () => {
  beforeEach(() => {
    resetUsageSendFailures();
    vi.mocked(invoke).mockReset();
  });

  it('范围查询按约定的参数发出', async () => {
    vi.mocked(invoke).mockResolvedValue({
      available: true,
      byDay: [],
      bySource: [],
      totals: emptyUsageAggregate(),
      statsOriginLocalDate: null,
      health: emptyUsageHealth(),
    });
    await queryUsageRange('2026-09-01', '2026-09-15');
    expect(invoke).toHaveBeenCalledWith('usage_query_range', {
      fromLocalDate: '2026-09-01',
      toLocalDate: '2026-09-15',
    });
  });

  it('读失败时给出不可用，页面据此保留上一份快照', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('ipc down'));
    const result = await queryUsageRange('2026-09-01', '2026-09-15');
    expect(result.available).toBe(false);
    // 合计字段一个不少，页面上的每个数字都拿得到值。
    expect(Object.keys(result.totals).sort()).toEqual([...USAGE_AGGREGATE_FIELDS].sort());
  });

  it('会话查询读失败时同样给出不可用', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('ipc down'));
    const result = await queryUsageConversation('conv-0001');
    expect(result.available).toBe(false);
    expect(result.totals.attempts).toBe(0);
  });

  it('健康计数读失败时给出全零，不抛给页面', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('ipc down'));
    const health = await queryUsageHealth();
    expect(health).toEqual(emptyUsageHealth());
  });

  it('主进程回来的东西形状不对时按读不到处理，不让页面拿着它去读字段', async () => {
    // 旧版本的主进程不认识这些命令时会走通用兜底分支返回 undefined。
    // 页面白屏与用量记不上是两件事，后者只该显示一行提示。
    for (const bad of [undefined, null, 'ok', 42, {}, { totals: { attempts: 1 } }]) {
      vi.mocked(invoke).mockResolvedValue(bad);
      const range = await queryUsageRange('2026-09-01', '2026-09-15');
      expect(range.available).toBe(false);
      expect(range.byDay).toEqual([]);
      expect(Object.keys(range.totals).sort()).toEqual([...USAGE_AGGREGATE_FIELDS].sort());

      const conversation = await queryUsageConversation('conv-1');
      expect(conversation.available).toBe(false);
      expect(conversation.totals.attempts).toBe(0);

      expect(await queryUsageHealth()).toEqual(emptyUsageHealth());
    }
  });
});

describe('零值', () => {
  it('合计零值覆盖清单里的每一个字段', () => {
    const empty = emptyUsageAggregate();
    expect(Object.keys(empty).sort()).toEqual([...USAGE_AGGREGATE_FIELDS].sort());
    for (const field of USAGE_AGGREGATE_FIELDS) {
      expect(empty[field]).toBe(0);
    }
  });

  it('健康计数零值里没有失败，也没有停写原因', () => {
    const health = emptyUsageHealth();
    expect(health.writeFailures).toBe(0);
    expect(health.rejectedFrames).toBe(0);
    expect(health.degradedCode).toBeNull();
  });
});
