/**
 * Per-run ambient context for concurrent MAIN agent-loop runs inside the
 * sidecar — P1-3B-3A item 2. Generalizes `subagentRunContext.ts`'s
 * AsyncLocalStorage pattern (see that file's doc for the full rationale)
 * from the subagent mini-loop to the full main loop.
 *
 * Unlike `subagentLoop.ts` (which resolves its ports via injected
 * `SubagentLoopOptions` fields, resolved ONCE into locals — see P1-3a),
 * `agentLoop.ts` reads 8 of its ports via bare MODULE GETTERS scattered
 * throughout the whole function body — `getChatDelta()`/
 * `getConversationReader()`/`getExecutionPort()`/`getAbortRegistry()`/
 * `getScratchpadPort()`/`getCapsPort()`/`getWorkspaceReader()`/
 * `getToolInvoker()` (verified by grep — dozens of call sites, not just at
 * entry; see P1-3B-3A-REPORT.md's inventory). Concurrent main-loop runs
 * share one sidecar process, so these getters must resolve PER-RUN, not to
 * a single process-wide slot — cross-run contamination (run A's chatDelta
 * writes landing on run B's conversation) is unacceptable.
 *
 * `agentLoopHost.ts` wraps each run's `runAgentLoop(...)` call in
 * `agentRunContext.run(ctx, () => ...)`; every async function called
 * transitively from inside that callback (including cross-run-interleaved
 * `tool.invoke`/`hook.emit` reverse-RPC callbacks) sees the SAME `ctx` via
 * `getCurrentAgentRunContext()`, even across `await` boundaries — while a
 * DIFFERENT concurrent run's calls see ITS OWN context, never this one's.
 *
 * `settingsReader` is deliberately NOT part of this per-run context —
 * `agentLoop.ts`'s only bare `getSettingsReader()` call
 * (`options?.settingsReader ?? getSettingsReader()`) is provably dead once
 * `agentLoopHost.ts` always injects `options.settingsReader` (mirroring the
 * exact reasoning `settingsReaderRun.ts` already documents for the subagent
 * path — see that shim, UNCHANGED by this batch). Settings instead live in
 * `sidecar/src/settingsMirror.ts`, a SIDECAR-GLOBAL (not per-run) mirror —
 * see that module's doc.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatDelta } from '@/core/agent/ports/chatDelta';
import type { ConversationReader } from '@/core/agent/ports/conversationReader';
import type { ExecutionPort } from '@/core/agent/ports/executionPort';
import type { AbortRegistry } from '@/core/agent/ports/abortRegistry';
import type { ScratchpadPort } from '@/core/agent/ports/scratchpadPort';
import type { CapsPort } from '@/core/agent/ports/capsPort';
import type { WorkspaceReader } from '@/core/agent/ports/workspaceReader';
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';
import type { PortFrame } from './portFrameCoalescer';

export interface AgentRunContext {
  runId: string;
  conversationId: string;
  chatDelta: ChatDelta;
  conversationReader: ConversationReader;
  executionPort: ExecutionPort;
  abortRegistry: AbortRegistry;
  scratchpadPort: ScratchpadPort;
  capsPort: CapsPort;
  workspaceReader: WorkspaceReader;
  toolInvoker: ToolInvoker;
  /**
   * Raw frame-push escape hatch for shims outside the 3 named ports above
   * that still need to ship a `p:'session'` frame through this run's SAME
   * coalescer/`agent.delta` stream — e.g. `shims/conversationStorageRun.ts`'s
   * `replaceMessageById` (see `frameApplier.ts`'s existing `session` port
   * handling). Wired by `agentLoopHost.ts` to the SAME `push` callback
   * `chatDelta`/`executionPort`/`scratchpadPort` already use, so frame order
   * across all 4 sources is preserved by the single coalescer's FIFO.
   */
  pushFrame: (frame: PortFrame) => void;
  /**
   * Pre-resolved shell-side at `agent.run` dispatch time (same
   * "frozen for the whole run" simplification `subagentRunContext.ts`'s
   * `resolvedCreds` documents — a long-running main loop's enterprise
   * gateway key does not rotate mid-run in practice either). Consumed by
   * `shims/enterpriseCredsRun.ts`, which now checks `subagentRunContext`
   * FIRST (top-level `subagent.run` RPC, unchanged from P1-3a) and falls
   * back to THIS context (main-loop run, and any nested subagent delegated
   * from it via `shims/subagentRunnerRun.ts` — which runs inside the SAME
   * `agentRunContext` scope, no separate `subagentRunContext.run()` wrapper,
   * so it correctly inherits the parent run's creds).
   */
  resolvedCreds: { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean; traceMetadata?: Record<string, string | undefined> };
  /** Resolved once at `agent.run` dispatch time — consumed by `shims/i18nRun.ts`'s full-dict `getLocale()`. */
  locale: string;
}

export const agentRunContext = new AsyncLocalStorage<AgentRunContext>();

/**
 * Read the current run's context. Throws when called outside an active
 * `agentRunContext.run(...)` scope — every main-loop code path that reaches
 * one of the ALS-backed port shims is, by construction (per
 * `agentLoopHost.ts`'s wiring), inside that scope, so reaching this outside
 * one always indicates a wiring bug, not a legitimate "no context" case.
 */
export function getCurrentAgentRunContext(): AgentRunContext {
  const store = agentRunContext.getStore();
  if (!store) {
    throw new Error(
      '[sidecar] agent run context accessed outside agentLoopHost.ts\'s AsyncLocalStorage scope — this indicates a wiring bug (a port shim was called from code not running inside agentRunContext.run()).',
    );
  }
  return store;
}
