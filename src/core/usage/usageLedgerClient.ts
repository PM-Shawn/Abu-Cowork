/**
 * renderer 侧的用量账本客户端。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 2 步）。
 * 主进程一侧是 `electron/usageDb.cjs`，命令经 `electron/tauriHost.cjs` 派发。
 *
 * ## 这条通道管什么
 *
 * sidecar 在跑的时候 agent 主循环就在 sidecar 里，用量经 stdout 帧直接进主进程
 * （`electron/mcpBridge.cjs`），**不经过 renderer**。renderer 只负责两件事：
 * 自己发起的模型请求走这里记账，以及用量页从这里读数。
 *
 * ## 写入不等结果
 *
 * `recordUsageAttempt` 没有返回值也不接受 await。用量记账不得阻塞发送、不得打断
 * 正在进行的回答，也不得因为记账失败额外触发任何模型重试（任务书 U05）。
 * 发送失败只累加本进程的计数，交给页面和主进程的健康计数一起显示。
 */

import { invoke } from '@tauri-apps/api/core';
import type { UsageAttempt } from '../llm/usageAccounting';

/**
 * 汇总字段的清单。类型由它派生，契约断言也读它——新增一个字段而主进程没跟上，
 * 或者主进程多给一个字段而这边不认识，都会在契约测试里露出来。
 */
export const USAGE_AGGREGATE_FIELDS = [
  'attempts',
  'inputKnownSum',
  'inputUnknownAttempts',
  'outputKnownSum',
  'outputUnknownAttempts',
  'cacheReadKnownSum',
  'cacheWriteKnownSum',
  'reasoningKnownSum',
  'cacheComparableAttempts',
  'cacheReadComparableSum',
  'inputComparableSum',
  'incompleteAttempts',
] as const;

export type UsageAggregateField = (typeof USAGE_AGGREGATE_FIELDS)[number];

/**
 * 一段范围内的用量汇总。
 *
 * `*KnownSum` 只累加已知值，`*UnknownAttempts` 是该字段未知的尝试数——
 * 两个数字分开给，页面才能说出「已知用量 X，另有 N 次未能取到用量」
 * （任务书 U03）。
 */
export type UsageAggregate = Record<UsageAggregateField, number>;

export interface UsageDayAggregate extends UsageAggregate {
  localDate: string;
}

export interface UsageSourceAggregate extends UsageAggregate {
  /** 采集时记下的原始来源，页面自己决定并成哪几组展示。 */
  source: string;
}

export interface UsageModelAggregate extends UsageAggregate {
  /** 请求时指定的模型，不是 provider 实际服务的那个。 */
  requestedModel: string;
}

export interface UsageSkillAggregate extends UsageAggregate {
  skill: string;
}

/** 主进程的健康计数，页面据此显示「有 N 次请求未能记录」那一行。 */
export interface UsageHealth {
  writeFailures: number;
  rejectedFrames: number;
  firstFailureAtUtc: number | null;
  lastFailureAtUtc: number | null;
  lastErrorCode: string | null;
  /** 库打不开或版本不认识时的停写原因，为 null 表示账本正常。 */
  degradedCode: string | null;
}

export interface UsageRangeResult {
  /** false 表示这次没取到数：页面保留上一份快照并标注暂未更新，不清成 0。 */
  available: boolean;
  byDay: UsageDayAggregate[];
  bySource: UsageSourceAggregate[];
  byModel: UsageModelAggregate[];
  bySkill: UsageSkillAggregate[];
  totals: UsageAggregate;
  /** 全表最小的本地日期。页面用它显示统计起点，与当前筛选范围无关。 */
  statsOriginLocalDate: string | null;
  health: UsageHealth;
}

export interface UsageConversationResult {
  available: boolean;
  totals: UsageAggregate;
}

export function emptyUsageAggregate(): UsageAggregate {
  return Object.fromEntries(USAGE_AGGREGATE_FIELDS.map((field) => [field, 0])) as UsageAggregate;
}

/**
 * 健康计数的零值。契约测试拿它的键集与主进程返回的键集比对——
 * 这是**活的**键集：给 `UsageHealth` 加字段而这里没跟上，类型检查就会红。
 */
export function emptyUsageHealth(): UsageHealth {
  return {
    writeFailures: 0,
    rejectedFrames: 0,
    firstFailureAtUtc: null,
    lastFailureAtUtc: null,
    lastErrorCode: null,
    degradedCode: null,
  };
}

/**
 * renderer 这一侧没能送到主进程的次数。
 *
 * 主进程的健康计数只数得到已经送达的那些：送达之后写失败或被拒，由它计数。
 * IPC 本身失败的那些只有这里知道，所以单独数一份，用量页把两边加在一起显示。
 */
let sendFailures = 0;

export function getUsageSendFailures(): number {
  return sendFailures;
}

/** 仅供测试重置。 */
export function resetUsageSendFailures(): void {
  sendFailures = 0;
}

/**
 * 记一条用量尝试。发出即返回，不等待主进程，也不向调用方抛出任何错误。
 */
export function recordUsageAttempt(attempt: UsageAttempt): void {
  let pending: unknown;
  try {
    pending = invoke('usage_record', { attempt });
  } catch {
    // invoke 在桥没就绪时会同步抛出。
    sendFailures += 1;
    return;
  }
  if (pending && typeof (pending as Promise<unknown>).then === 'function') {
    // 送达之后的失败（`ok: false`）主进程自己已经计过数，这里只数没送到的。
    (pending as Promise<unknown>).then(undefined, () => {
      sendFailures += 1;
    });
  }
}

async function invokeUsage(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const result = invoke(cmd, args);
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    return await (result as Promise<unknown>);
  }
  return result;
}

/**
 * 主进程回来的东西也是跨进程输入，形状要核对过才用。
 *
 * 旧版本的主进程不认识这些命令时会走到通用的兜底分支并返回 `undefined`，
 * 页面拿它去读字段就会当场白屏——而用量页白屏与用量记不上是两件不同的事，
 * 后者只该显示一行提示（任务书 U05）。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAggregate(value: unknown): value is UsageAggregate {
  return isRecord(value) && USAGE_AGGREGATE_FIELDS.every((field) => typeof value[field] === 'number');
}

/** 读一段日期范围的汇总。读失败给出 `available: false`，不抛给页面。 */
/** 读不到时的范围结果：各分组为空，合计全零，`available` 为 false。 */
export function emptyUsageRangeResult(): UsageRangeResult {
  return {
    available: false,
    byDay: [],
    bySource: [],
    byModel: [],
    bySkill: [],
    totals: emptyUsageAggregate(),
    statsOriginLocalDate: null,
    health: emptyUsageHealth(),
  };
}

export async function queryUsageRange(
  fromLocalDate: string,
  toLocalDate: string,
): Promise<UsageRangeResult> {
  try {
    const raw = await invokeUsage('usage_query_range', { fromLocalDate, toLocalDate });
    if (!isRecord(raw) || !Array.isArray(raw.byDay) || !isAggregate(raw.totals)) {
      return emptyUsageRangeResult();
    }
    return raw as unknown as UsageRangeResult;
  } catch {
    return emptyUsageRangeResult();
  }
}

/** 读单个会话的合计，会话小标签用。 */
export async function queryUsageConversation(
  conversationId: string,
): Promise<UsageConversationResult> {
  try {
    const raw = await invokeUsage('usage_query_conversation', { conversationId });
    if (!isRecord(raw) || !isAggregate(raw.totals)) {
      return { available: false, totals: emptyUsageAggregate() };
    }
    return { available: raw.available === true, totals: raw.totals };
  } catch {
    return { available: false, totals: emptyUsageAggregate() };
  }
}

/** 单独读健康计数。 */
export async function queryUsageHealth(): Promise<UsageHealth> {
  try {
    const raw = await invokeUsage('usage_health', {});
    if (!isRecord(raw) || typeof raw.writeFailures !== 'number') return emptyUsageHealth();
    return raw as unknown as UsageHealth;
  } catch {
    return emptyUsageHealth();
  }
}
