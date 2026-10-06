/**
 * Sidecar-local replacement for `src/core/enterprise/llm-resolver.ts`'s
 * `resolveEffectiveLlmCreds`. The real function reads
 * `useEnterpriseStore.getState()` (a Zustand webview store) on every call —
 * not importable in the sidecar bundle.
 *
 * P1-3B-3B REWORK (same reasoning as `i18nRun.ts`'s dual-context rework —
 * see that file's doc): creds are PRE-RESOLVED shell-side at dispatch time
 * and pushed as `resolvedCreds` on BOTH the subagent path (`subagentRunner.ts`'s
 * `buildSubagentRunParams()`, P1-3a, unchanged) and the MAIN loop path
 * (`agentLoopHost.ts`'s `AgentRunParams.resolvedCreds`, P1-3B-3A). `agentLoop.ts`
 * calls the bare `resolveEffectiveLlmCreds` at 5 call sites (verified: `grep -n
 * "resolveEffectiveLlmCreds(" src/core/agent/agentLoop.ts` — model-selection,
 * compression, compaction, main chat, and output-recovery creds, all with the
 * same 2-arg `(personalApiKey, personalBaseUrl)` shape `subagentLoop.ts` uses),
 * so this shim must resolve correctly for the main loop too, not just the
 * subagent mini-loop.
 *
 * Try `agentRunContext` first (the more common case going forward — every
 * sidecar-run main loop, plus any subagent nested under one via
 * `shims/subagentRunnerRun.ts`, which shares the PARENT's `agentRunContext`
 * scope rather than opening its own `subagentRunContext` — see that shim's
 * doc), fall back to `subagentRunContext` (a top-level `subagent.run` RPC,
 * P1-3a, unchanged). Throw if neither is active — same "escalate cleanly,
 * never silently wrong" discipline as `i18nRun.ts`.
 *
 * ⚠️ KNOWN, DOCUMENTED BEHAVIOR DIFFERENCE from the in-process path (carried
 * over from P1-3a, applies equally to the main loop now): both hosts resolve
 * creds ONCE, shell-side, before the run starts, and this shim returns that
 * SAME frozen value on every call for the run's whole duration — in-process,
 * each call re-reads the LIVE enterprise store. A long-running main-loop run
 * could in theory span longer than a subagent run, but an enterprise gateway
 * virtual key does not rotate mid-run in practice, so this remains a
 * deliberate simplification, not an oversight — see P1-3a-REPORT.md's
 * projection table and `agentRunContext.ts`'s own `resolvedCreds` doc.
 * `personalApiKey`/`personalBaseUrl` are accepted (to match the real
 * function's signature — call sites are unchanged) but IGNORED: the frozen
 * value already has the right answer baked in.
 */
import { getCurrentAgentRunContext } from '../agentRunContext';
import { getCurrentSubagentRunContext } from '../subagentRunContext';
import type { ShimThrowKind } from './shimThrowKind';

/**
 * 唯一一处抛出错误在 `resolveEffectiveLlmCreds()`：两种运行上下文都取不到凭据，
 * 说明调用来自一次运行的作用域之外。凭据在运行开始前由 shell 算好并随运行参数传入，
 * 作用域之内每次调用都能取到。
 */
export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';

export function resolveEffectiveLlmCreds(
  _personalApiKey: string,
  _personalBaseUrl: string | undefined,
): { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean } {
  try {
    return getCurrentAgentRunContext().resolvedCreds;
  } catch {
    try {
      return getCurrentSubagentRunContext().resolvedCreds;
    } catch {
      throw new Error(
        '[sidecar] resolveEffectiveLlmCreds() called outside both agentRunContext and subagentRunContext scopes — no run context available. This indicates a wiring bug.',
      );
    }
  }
}
