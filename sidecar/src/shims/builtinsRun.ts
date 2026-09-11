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
 * The live sidecar import surface is
 * `clearSkillHooksByLoop` (agentLoop.ts) plus
 * `setComputerUseBatchMode`/`setSkipAutoScreenshot` (toolExecutor.ts).
 * `clearAllSkillHooks` remains as a compatibility export for older callers.
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
 * Skill hooks live in the shell because `use_skill` executes there. Both
 * cleanup exports therefore forward the legacy `skillHooks.clearAll` wire
 * notification with only the trusted run-context id. The shell handler maps
 * that id back to its session-owned conversation and drops unknown/stale ids;
 * the sidecar's conversation argument is deliberately not authority-bearing.
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

function notifySkillHookCleanup(): void {
  sendNotification('skillHooks.clearAll', { runId: resolveRunId() });
}

export function clearSkillHooksByConversation(_conversationId: string): void {
  notifySkillHookCleanup();
}

export function clearSkillHooksByLoop(_loopId: string): void {
  notifySkillHookCleanup();
}

export function clearAllSkillHooks(): void {
  notifySkillHookCleanup();
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
