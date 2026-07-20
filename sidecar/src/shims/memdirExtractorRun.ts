/**
 * Sidecar-local replacement for `src/core/memdir/extractor.ts`.
 *
 * THROWING bundle-graph-only shim, DELIBERATE per design doc §6 "本期明确不做"
 * ("压缩·extractor·标题 llmCall 旁路（维持 P1-1 本地路径）") — memory
 * extraction is explicitly out of scope for the whole 3b initiative, not a
 * gap discovered and silently patched over here.
 *
 * Reachability: ONLY via `agentLoop.ts`'s single dynamic-import call site
 * (`import('../memdir/extractor').then(({ extractMemoriesFromConversation })
 * => extractMemoriesFromConversation(conversationId, wsPath)).catch(() =>
 * {})`) — verified by grep, one call site, always inside the
 * `interactiveDesktop` gate. The real module reaches directly into
 * `useChatStore`/`settingsStore` (bare Zustand imports, NOT the relocated
 * `settingsSelectors.ts`) AND constructs `ClaudeAdapter`/
 * `OpenAICompatibleAdapter` directly — a self-contained mini-LLM-call module
 * that bypasses every port this batch built, exactly the class of thing §6
 * excludes.
 *
 * SAFE degradation, not silent: the ONLY call site already wraps the whole
 * chain in `.catch(() => {})` — a rejected import (this shim throwing)
 * resolves to a caught, swallowed rejection, same as any other extraction
 * failure the real module could itself produce (network error, LLM call
 * failure, etc. — extraction failure is ALREADY a tolerated, non-fatal
 * outcome in the real code path, not a new failure mode this shim invents).
 * Net effect: memory auto-extraction silently does not happen for
 * sidecar-run main-loop turns this batch — a real, documented feature
 * regression (not a correctness bug), to be revisited when compression/
 * extractor/title generation get their own sidecar treatment (see design
 * doc §6).
 */
export async function extractMemoriesFromConversation(
  _conversationId: string,
  _workspacePath: string | null,
): Promise<void> {
  throw new Error(
    '[sidecar] memdir/extractor.ts reached inside the sidecar bundle — memory extraction is explicitly out of scope for this batch (design doc §6). The sole call site already wraps this in .catch(() => {}), so this is a safe, documented feature gap, not a crash.',
  );
}
