/**
 * sidecar 侧的用量帧编码。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 3 步）。
 * 解码端在 `electron/usageAttemptFrame.cjs`，两端读同一份样例表
 * （`src/core/llm/__contractFixtures__/usageAttemptFixtures.ts`），由
 * `electron/usageAttemptFrame.contract.test.ts` 与 `sidecar/src/usageFrame.contract.test.ts`
 * 各跑一遍——任一端单方面改帧格式都会红。
 *
 * 为什么不直接复用主进程那份实现：那是 Electron 主进程的 CommonJS 模块，
 * sidecar 是独立打包的 ESM 产物，两边不共享模块图。共享的是样例表与断言。
 */

import type { UsageAttempt } from '@/core/llm/usageAccounting';

/**
 * 帧标记。与 `electron/usageAttemptFrame.cjs` 的 `USAGE_FRAME_MARKER` 必须一致。
 *
 * 主进程按**顶层键**判定，不是按"这行里含有这个串"——sidecar 的 stdout 同时承载
 * JSON-RPC，而 RPC 载荷里可以出现任意文本（模型回答、工具结果）。
 */
export const USAGE_FRAME_MARKER = '__abu_usage__';

/** 帧版本。与快照的 `schemaVersion` 同步。 */
export const USAGE_FRAME_VERSION = 1;

/** 把一份快照编成一行 stdout 帧（不含换行符）。 */
export function encodeUsageFrame(attempt: UsageAttempt): string {
  return JSON.stringify({ [USAGE_FRAME_MARKER]: USAGE_FRAME_VERSION, attempt });
}
