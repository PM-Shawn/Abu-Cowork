/**
 * Sidecar-local replacement for `src/core/agent/ports/scratchpadPort.ts`.
 *
 * REAL behavior shim — `agentLoop.ts`'s `createEventRouter` call threads
 * `getScratchpadPort().addEntry` in as `addScratchpadEntry`. Resolves the
 * current run's `ScratchpadPort` (a `createFrameScratchpadPort(push)` from
 * `portFrameSenders.ts`) from the ambient `agentRunContext`.
 *
 * `applyScratchpadEntryWithId` (the real module's shell-side id-preserving
 * apply seam) is deliberately not re-exported — shell-only, consumed by
 * `frameApplier.ts`, never reachable from the sidecar bundle.
 */
import type { ScratchpadPort } from '@/core/agent/ports/scratchpadPort';
import { getCurrentAgentRunContext } from '../agentRunContext';
import type { ShimThrowKind } from './shimThrowKind';

/**
 * 唯一一处抛出错误在 `setScratchpadPort()`。sidecar 里 scratchpadPort 把条目编成帧
 * 发给 shell，每次运行各有一个，由 `agentRunContext.run()` 注入，没有模块级的值
 * 可以替换，有人调用这个设值函数就说明接线接错了。
 */
export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';

export function getScratchpadPort(): ScratchpadPort {
  return getCurrentAgentRunContext().scratchpadPort;
}

export function setScratchpadPort(_port: ScratchpadPort): void {
  throw new Error(
    '[sidecar] setScratchpadPort() called inside the sidecar bundle — scratchpadPort is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
