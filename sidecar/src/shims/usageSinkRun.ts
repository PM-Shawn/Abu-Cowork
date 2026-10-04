/**
 * `src/core/llm/usageSink.ts` 的 sidecar 实现。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 3 步）。
 *
 * 把快照编成一行 stdout 帧，主进程在 `electron/mcpBridge.cjs` 的行循环里拦下来
 * 直接写进 `usage.sqlite`。
 *
 * 这条通道**不经过 renderer**：renderer 刷新、卡住或者没有订阅的时候，
 * 用户的对话仍在 sidecar 里正常进行，用量也要照常记上。
 *
 * stdout 同时是 JSON-RPC 通道，所以帧必须能与 RPC 消息区分：判据是顶层键
 * `__abu_usage__`，见 `sidecar/src/usageFrame.ts` 与主进程的解码端。
 */

import type { UsageAttempt } from '@/core/llm/usageAccounting';
import { encodeUsageFrame } from '../usageFrame';

/** 把一份用量快照写成一行 stdout 帧。写完即返回，不等待主进程确认。 */
export function emitUsageAttempt(attempt: UsageAttempt): void {
  process.stdout.write(`${encodeUsageFrame(attempt)}\n`);
}
