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

/**
 * `agentLoop.ts` also imports `EnterpriseLlmUnavailableError` by name (from
 * the SAME module specifier, `../enterprise/llm-resolver`) for `err
 * instanceof EnterpriseLlmUnavailableError` checks (verified: `grep -n
 * "EnterpriseLlmUnavailableError" src/core/agent/agentLoop.ts` — 3 sites,
 * all `instanceof`, none construct/throw it). This shim's
 * `resolveEffectiveLlmCreds` never throws it (dispatch-time enterprise-gateway
 * failures are handled shell-side, before an `agent.run`/`subagent.run` is
 * ever sent — see `subagentRunner.ts`'s `buildSubagentRunParams` catch for
 * the established precedent), so the `instanceof` checks below always
 * evaluate `false` in the sidecar — correct, not a gap: there is no
 * legitimate way for this specific error to originate sidecar-side. The
 * class must still exist and be exported (byte-identical shape — a plain
 * `Error` subclass) purely so the import resolves and the `instanceof`
 * check itself doesn't throw a ReferenceError.
 */
export class EnterpriseLlmUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'EnterpriseLlmUnavailableError';
  }
}

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
