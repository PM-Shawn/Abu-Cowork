/**
 * 用量采集器：把 provider 报来的数字变成一条条尝试快照交给账本。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 3 步）。
 *
 * ## 为什么在 provider 边界
 *
 * 聊天模型的请求有好几条入口：主循环、子代理、压缩、记忆提取、技能辅助、自检，
 * 它们各自构造 adapter。采集点放在两个 adapter 内部，三件事就由结构保证：
 *  - 所有聊天模型请求都从这两个类出去，哪条入口都绕不开采集；
 *  - `SidecarLLMAdapter` 只是转发器，自己不发 HTTP，也就不会重复计数；
 *  - SDK 内部重试与限额重试各自是一次真实的 HTTP 请求，由 fetch 包装层各铸一个
 *    尝试身份，它们在账本里各占一条。
 *
 * 范围只到聊天模型。图片生成（`src/core/tools/definitions/mediaTools.ts`）自己发请求，
 * 不经过这两个类，它的用量不在这本账里。
 *
 * ## 尝试与逻辑调用
 *
 * 一次 `chat()` 是一次**逻辑调用**（`logicalCallId`）。它内部真实发出的每一次
 * HTTP 请求是一次**尝试**（`attemptId`）。页面上的计数标签是"请求尝试"，
 * 一条用户消息可能触发多次——这正是用户需要能自己解释的那个差额（任务书 U02）。
 *
 * ## 不阻塞、不抛出
 *
 * 所有方法都不返回结果、不接受 await，内部任何失败都被吞在采集器里。
 * 用量记账失败必须允许继续聊天（任务书 U05）。
 */

import {
  emptyAccountingUsage,
  localCalendarParts,
  mergeAccountingUsage,
  normalizeWireUsage,
  type AccountingUsage,
  type UsageAttempt,
  type UsageEvidence,
  type UsageProtocol,
  type UsageSource,
  type WireUsage,
} from './usageAccounting';
import { emitUsageAttempt } from './usageSink';

/** 一次模型请求的记账身份，由调用方在 `ChatOptions.accounting` 上给出。 */
export interface UsageAccountingContext {
  /** 这次请求属于哪条路径。页面按它分组，让用户能解释请求数（任务书 U02）。 */
  source: UsageSource;
  conversationId: string | null;
  /** 技能辅助调用所属的技能名，其余为 null。 */
  skill: string | null;
  /** Abu 自己的服务商配置 id。不写 URL、不写密钥。 */
  providerInstanceId: string;
}

export type UsageOutcome = UsageAttempt['outcome'];

export interface UsageAttemptRecorder {
  /**
   * 一次真实的 HTTP 请求开始。铸一个新的尝试身份并立刻记一条进行中的快照。
   *
   * 上一次尝试如果还没收尾，说明它失败了才会有这一次重试——先把它按失败结清。
   */
  beginAttempt(): void;
  /** provider 报来的一组线路用量。归一化后并入当前尝试。 */
  observeUsage(wire: WireUsage, evidence: UsageEvidence): void;
  /** provider 实际服务的模型。未知就不要调用，不回填成请求的模型。 */
  noteServedModel(model: string): void;
  /** 收尾。没有开始过任何尝试时什么都不做——请求还没发出去就失败了，没有尝试可记。 */
  settle(outcome: UsageOutcome): void;
}

export interface UsageRecorderDeps {
  protocol: UsageProtocol;
  requestedModel: string;
  /** 缺省时按 `other` 记账：宁可记成来源不明，也不静默丢掉一次请求。 */
  accounting?: UsageAccountingContext;
  sink: (attempt: UsageAttempt) => void;
  now?: () => Date;
  newId?: () => string;
}

const DEFAULT_CONTEXT: UsageAccountingContext = {
  source: 'other',
  conversationId: null,
  skill: null,
  providerInstanceId: 'unknown',
};

/**
 * 尝试身份。`crypto.randomUUID` 只在安全上下文里存在，取不到时用仓库通用的
 * 时间加随机数的写法——身份只要求在本机的账本里不重复。
 */
function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * 采集器挂在模型请求路径上：`beginAttempt` 在 fetch 包装层里调用，那里抛出的任何
 * 错误都会让这次模型请求直接失败。所以每个入口整体包一层，记账出什么问题都
 * 不影响请求本身（任务书 U05）。
 */
function guarded(run: () => void): void {
  try {
    run();
  } catch {
    // 记账失败由出口与主进程各自计数，这里只负责把它挡在请求路径之外。
  }
}

/** 同一次尝试里，因用量变化而发出快照的最小间隔。 */
const USAGE_EMIT_INTERVAL_MS = 1000;

/** 收尾状态：已经结清的尝试不再改写。 */
const TERMINAL_OUTCOMES: ReadonlySet<UsageOutcome> = new Set<UsageOutcome>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export function createUsageRecorder(deps: UsageRecorderDeps): UsageAttemptRecorder {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultNewId;
  const context = deps.accounting ?? DEFAULT_CONTEXT;

  /** 第一次尝试开始时才铸造：构造采集器这一步不做任何可能抛出的事。 */
  let logicalCallId: string | null = null;
  let attemptId: string | null = null;
  let revision = 0;
  let startedAt: Date | null = null;
  let calendar: ReturnType<typeof localCalendarParts> | null = null;
  let usage: AccountingUsage = emptyAccountingUsage();
  let servedModel: string | null = null;
  let outcome: UsageOutcome = 'running';
  /**
   * 结清时刻。结清之后还会有修订：OpenAI 协议的尾部 usage 排在结束块**之后**到达，
   * 那条修订必须带着已经定下来的结束时间，不能把它写回 null。
   */
  let endedAtUtc: number | null = null;
  /** 上一次因用量变化而发出快照的时刻，限流用。每次新尝试清零。 */
  let lastUsageEmitMs = 0;

  function snapshot(): UsageAttempt {
    return {
      schemaVersion: 1,
      attemptId: attemptId as string,
      logicalCallId: logicalCallId as string,
      revision,
      providerInstanceId: context.providerInstanceId,
      protocol: deps.protocol,
      requestedModel: deps.requestedModel,
      servedModel,
      source: context.source,
      conversationId: context.conversationId,
      skill: context.skill,
      startedAtUtc: (startedAt as Date).getTime(),
      localDate: (calendar as ReturnType<typeof localCalendarParts>).localDate,
      tzId: (calendar as ReturnType<typeof localCalendarParts>).tzId,
      offsetMinutes: (calendar as ReturnType<typeof localCalendarParts>).offsetMinutes,
      endedAtUtc,
      outcome,
      usage,
    };
  }

  function emit(): void {
    if (attemptId === null) return;
    const next = snapshot();
    revision += 1;
    deps.sink(next);
  }

  return {
    beginAttempt(): void {
      guarded(() => {
        if (attemptId !== null && !TERMINAL_OUTCOMES.has(outcome)) {
          // 只有失败才会有下一次尝试：SDK 的内部重试与限额重试都是这个形状。
          outcome = 'failed';
          endedAtUtc = now().getTime();
          emit();
        }
        if (logicalCallId === null) logicalCallId = newId();
        attemptId = newId();
        revision = 0;
        startedAt = now();
        calendar = localCalendarParts(startedAt);
        usage = emptyAccountingUsage();
        servedModel = null;
        outcome = 'running';
        endedAtUtc = null;
        lastUsageEmitMs = 0;
        // 发出即记：请求已经交给传输层，此时还没有任何用量，但这次尝试确实发生了。
        // 这时就记一条，崩溃或断线之后账本里仍然查得到这次尝试。
        emit();
      });
    },

    observeUsage(wire: WireUsage, evidence: UsageEvidence): void {
      guarded(() => {
        if (attemptId === null) return;
        const merged = mergeAccountingUsage(usage, normalizeWireUsage(deps.protocol, wire, evidence));
        // 有些网关在每个增量分块上都带一份累计 usage，一条回答就是上千份，而每发一份
        // 都是一次跨进程写库。数字没变不发；变了也限到每秒至多一份——中间值只是进度，
        // 结清时发出的那一份带着最新的数字。结清之后才到的用量（OpenAI 协议的尾部
        // usage）没有后续的结清来带它，立即发出。
        if (JSON.stringify(merged) === JSON.stringify(usage)) return;
        usage = merged;
        const nowMs = now().getTime();
        if (!TERMINAL_OUTCOMES.has(outcome) && nowMs - lastUsageEmitMs < USAGE_EMIT_INTERVAL_MS) return;
        lastUsageEmitMs = nowMs;
        emit();
      });
    },

    noteServedModel(model: string): void {
      if (attemptId === null || typeof model !== 'string' || model.length === 0) return;
      if (servedModel === model) return;
      servedModel = model;
    },

    settle(next: UsageOutcome): void {
      guarded(() => {
        if (attemptId === null) return;
        if (TERMINAL_OUTCOMES.has(outcome)) return;
        outcome = next;
        endedAtUtc = now().getTime();
        emit();
      });
    },
  };
}

/** adapter 用的构造入口：出口按进程取（renderer 走 IPC，sidecar 走 stdout 帧）。 */
export function createDefaultUsageRecorder(
  deps: Omit<UsageRecorderDeps, 'sink'>,
): UsageAttemptRecorder {
  return createUsageRecorder({ ...deps, sink: emitUsageAttempt });
}
