/**
 * Sidecar-local replacement for `src/core/agent/ports/conversationReader.ts`.
 *
 * REAL behavior shim, same reasoning as `chatDeltaRun.ts` — `agentLoop.ts`
 * (and `toolExecutor.ts`, `plannedStepsPrompt.ts`) call `getConversationReader()`
 * BARE dozens of times, no options-injection field exists for it. Resolves
 * the current run's `ConversationReader` (the conversation run-mirror, see
 * `sidecar/src/conversationRunMirror.ts`) from the ambient `agentRunContext`.
 */
import type { ConversationReader } from '@/core/agent/ports/conversationReader';
import { getCurrentAgentRunContext } from '../agentRunContext';
import type { ShimThrowKind } from './shimThrowKind';

/**
 * 唯一一处抛出错误在 `setConversationReader()`。sidecar 里 conversationReader 读的是
 * 当前这次运行的会话镜像，由 `agentRunContext.run()` 注入，没有模块级的值可以替换，
 * 有人调用这个设值函数就说明接线接错了。
 */
export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';

export function getConversationReader(): ConversationReader {
  return getCurrentAgentRunContext().conversationReader;
}

export function setConversationReader(_reader: ConversationReader): void {
  throw new Error(
    '[sidecar] setConversationReader() called inside the sidecar bundle — conversationReader is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
