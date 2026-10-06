/**
 * Sidecar-local replacement for `src/core/agent/ports/chatDelta.ts`.
 *
 * REAL behavior shim (not bundle-graph-only, unlike the 3a port shims for
 * settingsReader) — `agentLoop.ts` calls `getChatDelta()` BARE dozens of
 * times throughout its body (verified by grep, not assumed — see
 * P1-3B-3A-REPORT.md's inventory); there is no `AgentLoopOptions.chatDelta`
 * injection field for it to prefer, so this getter is genuinely reached on
 * every sidecar-run main loop. `getChatDelta()` resolves the CURRENT run's
 * `ChatDelta` (a `createFrameChatDelta(push, onLocalApply)` from
 * `portFrameSenders.ts`, constructed per-run by `agentLoopHost.ts`) from the
 * ambient `agentRunContext` (P1-3B-3A item 2) — never a process-wide slot,
 * so two concurrent runs never see each other's chatDelta.
 *
 * `setChatDelta` is NOT part of this module's real surface — nothing
 * sidecar-side should ever call it (injection happens via
 * `agentRunContext.run(...)`, not slot-swapping); kept as a throwing stub
 * purely so the shim's export surface still type-matches the real module's
 * shape for anything that might statically reference it.
 */
import type { ChatDelta } from '@/core/agent/ports/chatDelta';
import { getCurrentAgentRunContext } from '../agentRunContext';
import type { ShimThrowKind } from './shimThrowKind';

/**
 * 唯一一处抛出错误在 `setChatDelta()`。sidecar 里每次运行的 chatDelta 由
 * `agentLoopHost.ts` 创建并经 `agentRunContext.run()` 注入，两次并发的运行互不可见，
 * 没有模块级的值可以替换，有人调用这个设值函数就说明接线接错了。
 */
export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';

export function getChatDelta(): ChatDelta {
  return getCurrentAgentRunContext().chatDelta;
}

export function setChatDelta(_delta: ChatDelta): void {
  throw new Error(
    '[sidecar] setChatDelta() called inside the sidecar bundle — chatDelta is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
