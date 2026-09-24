/**
 * 用量快照的出口（renderer 实现）。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 3 步）。
 *
 * 采集器在两个 adapter 内部，而 adapter 两个进程里都会跑：sidecar 在跑的时候
 * agent 主循环和模型请求都在 sidecar 里，没跑的时候在 renderer 里。所以"记到哪去"
 * 这一步按进程分开：本文件是 renderer 的实现，走既有的 invoke 桥交给主进程；
 * sidecar 的实现是 `sidecar/src/shims/usageSinkRun.ts`，把同一份快照编成 stdout 帧
 * 直接交给主进程，不经过 renderer。两份实现由 `scripts/build-sidecar.mjs` 在打包时替换。
 *
 * 这个模块只有一个导出，而且不抛出任何错误——用量记账不得打断正在进行的回答。
 */

import type { UsageAttempt } from './usageAccounting';
import { recordUsageAttempt } from '../usage/usageLedgerClient';

/** 把一份用量快照交出去。发出即返回，不等待，不抛出。 */
export function emitUsageAttempt(attempt: UsageAttempt): void {
  recordUsageAttempt(attempt);
}
