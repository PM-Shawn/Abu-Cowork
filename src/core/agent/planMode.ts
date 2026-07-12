/**
 * Plan Mode — per-conversation state and gate decision logic.
 *
 * State is transient (in-memory Map), not persisted — plan mode resets on restart.
 * The pattern mirrors permissionBridge.ts loopContexts and other module-level Maps
 * used for non-reactive agent state.
 *
 * UI wiring and loop integration are intentionally absent here (later slices).
 */
import { TOOL_NAMES } from '@/core/tools/toolNames';

// ── State Type ──

export type PlanModeState = 'off' | 'planning' | 'approved';

// ── Per-conversation transient state ──

/** Module-level singleton — supports concurrent conversations. */
const planModeMap = new Map<string, PlanModeState>();

/**
 * Get the plan mode state for a conversation.
 * Returns `'off'` if no entry exists.
 */
export function getPlanMode(conversationId: string): PlanModeState {
  return planModeMap.get(conversationId) ?? 'off';
}

/**
 * Set the plan mode state for a conversation.
 */
export function setPlanMode(conversationId: string, state: PlanModeState): void {
  planModeMap.set(conversationId, state);
}

/**
 * Clear the plan mode entry for a conversation, resetting it to `'off'`.
 * Called on conversation delete or explicit reset.
 */
export function clearPlanMode(conversationId: string): void {
  planModeMap.delete(conversationId);
}

// ── Read-only fallback allowlist ──

/**
 * Tools that are considered read-only for plan gate purposes, even if their
 * `ToolDefinition.readOnly` field is absent or undefined.
 *
 * These are tools that observe the world but don't mutate it, making them
 * safe to run while the agent is still in the planning phase.
 */
export const READONLY_FALLBACK_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAMES.REPORT_PLAN,
  TOOL_NAMES.ASK_USER_QUESTION,
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
  TOOL_NAMES.WEB_SEARCH,
  TOOL_NAMES.HTTP_FETCH,
  TOOL_NAMES.READ_MEMORY,
  TOOL_NAMES.RECALL,
  TOOL_NAMES.READ_SKILL_FILE,
  TOOL_NAMES.SKILL_VIEW,
  TOOL_NAMES.TOOL_SEARCH,
  TOOL_NAMES.GET_SYSTEM_INFO,
  TOOL_NAMES.CLIPBOARD_READ,
  // Inline visualization: read_me only returns static guidelines text;
  // show_widget renders in-conversation and mutates nothing on disk.
  TOOL_NAMES.SHOW_WIDGET,
  TOOL_NAMES.READ_ME,
]);

// ── Gate Decision ──

export interface PlanGateParams {
  toolName: string;
  /** From ToolDefinition.readOnly — undefined if not declared on the tool. */
  toolReadOnly: boolean | undefined;
  planMode: PlanModeState;
}

export interface PlanGateResult {
  allow: boolean;
  reason?: string;
}

/**
 * Pure gate decision: should this tool call be allowed given the current plan mode?
 *
 * - `'off'` or `'approved'` → always allow.
 * - `'planning'` → allow only if the tool is read-only (via explicit flag or fallback set);
 *   otherwise block with a user-facing reason.
 */
export function evaluatePlanGate(params: PlanGateParams): PlanGateResult {
  const { toolName, toolReadOnly, planMode } = params;

  if (planMode === 'off' || planMode === 'approved') {
    return { allow: true };
  }

  // planMode === 'planning'
  if (toolReadOnly === true || READONLY_FALLBACK_TOOLS.has(toolName)) {
    return { allow: true };
  }

  return {
    allow: false,
    reason: '计划模式:批准前仅允许只读操作,请先用 report_plan 提交计划等待用户批准。',
  };
}
