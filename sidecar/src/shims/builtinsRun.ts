/**
 * Sidecar-local replacement for `src/core/tools/builtins.ts`.
 *
 * `builtins.ts` is a barrel: it statically imports ALL ~19 tool-definition
 * files (fileTools/commandTools/agentTools/automationTools/mediaTools/
 * widgetTools/webTools/memoryTools/recallTool/updateSoulTool/systemTools/
 * skillEvalTools/skillViewTools/skillManageTool/toolSearchTool/todoTools/
 * orchestrationTools/askUserQuestionTool/computerTools) PLUS `toolRegistry`
 * from `./registry` — importing even ONE re-exported name drags the entire
 * cluster (confirmed by a real `npm run build:sidecar` run against this
 * exact redirect target, per this batch's coordinator). This shim redirects
 * the WHOLE module specifier, same as every other `SHIM_TARGETS` entry.
 *
 * Consumed export surface verified precisely (not guessed): `grep -n
 * "tools/builtins" src/core/agent/{agentLoop,toolExecutor,eventRouter}.ts`
 * → exactly 3 names — `clearAllSkillHooks` (agentLoop.ts) and
 * `setComputerUseBatchMode`/`setSkipAutoScreenshot` (toolExecutor.ts).
 * `clearSkillHooksByConversation` (builtins.ts's other re-export from
 * `agentTools.ts`) has exactly one importer repo-wide —
 * `src/stores/chatStore.ts` (shell-only, never reaches the sidecar bundle) —
 * so it's correctly omitted rather than speculatively duplicated.
 *
 * ── `setComputerUseBatchMode`/`setSkipAutoScreenshot` → real forwarding
 * shim ────────────────────────────────────────────────────────────────────
 * Both are re-exports of `src/core/tools/definitions/computerTools.ts`'s
 * flag setters (`(value: boolean) => { computerUseBatchMode = value }` /
 * `(value: boolean) => { skipAutoScreenshot = value }` — plain module-level
 * booleans, no store coupling). Forward as the SAME `cu.setState`
 * NOTIFICATION channel `computerUseStatusRun.ts` uses, with the action names
 * verified against `agentLoopRunner.ts`'s `CU_SET_STATE_ACTIONS` allowlist
 * (`setComputerUseBatchMode: (...args) => setComputerUseBatchMode(args[0] as
 * boolean)` / `setSkipAutoScreenshot: (...args) =>
 * setSkipAutoScreenshot(args[0] as boolean)`) — already fully covered
 * shell-side, no new wiring needed for these two.
 *
 * ── `clearAllSkillHooks` → real forwarding shim, NEW shell-side wiring
 * required (flagged prominently) ─────────────────────────────────────────
 * Read the real implementation (`agentTools.ts:20-30`): a module-level
 * `Map<string, () => void>` (`skillHookCleanups`), populated ONLY inside the
 * `use_skill` tool's `execute()` body (via `activateSkillHooks(skill)` from
 * `../../skill/skillHooks`). Since ALL tool execution — including
 * `use_skill`'s — always reverses to the shell via `tool.invoke` (never runs
 * in-process sidecar-side, per this whole batch's established design), a
 * purely LOCAL sidecar-side reimplementation of `skillHookCleanups` would be
 * permanently empty: nothing sidecar-side ever populates it, so
 * `clearAllSkillHooks()` would be a silent, always-a-no-op stub — exactly
 * the "silent no-op for behavior-bearing code" pattern this batch forbids
 * (skill-scoped PreToolUse/PostToolUse hooks activated during a sidecar-run
 * main loop would never get cleaned up at loop end, leaking across turns).
 *
 * So this forwards a NEW reverse NOTIFICATION, `skillHooks.clearAll`
 * (`{ runId }`, dual-context runId resolution — same pattern as
 * `permissionBridgeRun.ts`'s `resolveRunId()`), to the shell's REAL
 * `clearAllSkillHooks` (`agentTools.ts`'s real Map, which IS correctly
 * populated — `use_skill`'s execute() runs shell-side). ⚠️ **This requires a
 * new shell-side handler that does NOT exist yet** —
 * `src/core/agent/agentLoopRunner.ts` has no `skillHooks.clearAll` entry in
 * its `ensureHandlersRegistered()` as of this writing. Per this card's
 * explicit "don't touch agentLoopRunner.ts unless necessary, and describe
 * precisely if you do" instruction, and given a concurrent session is
 * actively wiring `build-sidecar.mjs`/related files in parallel with this
 * batch, the safest choice is to document the exact one-handler addition
 * needed rather than editing that file myself:
 *
 * ```ts
 * // in agentLoopRunner.ts's ensureHandlersRegistered():
 * onSidecarNotification('skillHooks.clearAll', handleSkillHooksClearAll);
 *
 * function handleSkillHooksClearAll(rawParams: unknown): void {
 *   const params = rawParams as { runId?: unknown } | null;
 *   if (!params || typeof params.runId !== 'string') return;
 *   clearAllSkillHooks(); // import { clearAllSkillHooks } from '../tools/builtins';
 * }
 * ```
 *
 * Mirrors `plan.clear`'s exact shape (single param, single real function
 * call, no allowlist needed since there's only one action) — `runId` is
 * informational only, same discipline as `approval.drain`'s, since
 * `skillHookCleanups` is a single GLOBAL map, not per-run.
 */
import { sendNotification } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';
import { getCurrentSubagentRunContext } from '../subagentRunContext';

function resolveRunId(): string {
  try {
    return getCurrentAgentRunContext().runId;
  } catch {
    try {
      return getCurrentSubagentRunContext().runId;
    } catch {
      throw new Error(
        '[sidecar] builtins shim function called outside both agentRunContext and subagentRunContext scopes — no run context available. This indicates a wiring bug.',
      );
    }
  }
}

/**
 * ⚠️ See module doc — requires a NOT-YET-BUILT shell-side
 * `skillHooks.clearAll` handler in `agentLoopRunner.ts` to actually take
 * effect. The notification is sent regardless (fire-and-forget, matching
 * every other `cu.setState`/`approval.drain`-style forward in this batch);
 * until that handler exists, this notification is silently dropped by
 * `sidecarManager.ts`'s "no registered handler for this notification
 * method" no-op path (same as any unrecognized notification method today).
 */
export function clearAllSkillHooks(): void {
  sendNotification('skillHooks.clearAll', { runId: resolveRunId() });
}

function setState(action: string, value: boolean): void {
  sendNotification('cu.setState', { action, args: [value] });
}

export function setComputerUseBatchMode(value: boolean): void {
  setState('setComputerUseBatchMode', value);
}

export function setSkipAutoScreenshot(value: boolean): void {
  setState('setSkipAutoScreenshot', value);
}
