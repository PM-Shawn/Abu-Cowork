/**
 * Sidecar-local replacement for `src/core/agent/ports/workspaceReader.ts`.
 *
 * P1-3B-3A REWORK (same reasoning as `toolInvokerRun.ts` — see that file):
 * `agentLoop.ts` has no `workspaceReader` option field; its bare
 * `getWorkspaceReader().getCurrentPath()` calls are always reached on the
 * main-loop path (entry fallback + `mcpChanged` re-derivation, see design
 * doc §1 fact 5). Resolves the current run's `WorkspaceReader` (entry
 * snapshot, updated by `state.convPatch`'s `workspacePath` field — see
 * `conversationRunMirror.ts`) from the ambient `agentRunContext`. Subagent
 * code still resolves its own `SubagentLoopOptions.workspaceReader` first
 * (unchanged, P1-3a), so it never reaches this bare getter.
 */
import type { WorkspaceReader } from '@/core/agent/ports/workspaceReader';
import { getCurrentAgentRunContext } from '../agentRunContext';
import type { ShimThrowKind } from './shimThrowKind';

/**
 * 唯一一处抛出错误在 `setWorkspaceReader()`。sidecar 里 workspaceReader 读的是
 * 当前这次运行的工作区路径快照，由 `agentRunContext.run()` 注入，没有模块级的值
 * 可以替换，有人调用这个设值函数就说明接线接错了。
 */
export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';

export function getWorkspaceReader(): WorkspaceReader {
  return getCurrentAgentRunContext().workspaceReader;
}

export function setWorkspaceReader(_reader: WorkspaceReader): void {
  throw new Error(
    '[sidecar] setWorkspaceReader() called inside the sidecar bundle — workspaceReader is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
