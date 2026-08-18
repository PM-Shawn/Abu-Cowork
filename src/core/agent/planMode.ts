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
  notifySubscribers(conversationId, state);
}

/**
 * Clear the plan mode entry for a conversation, resetting it to `'off'`.
 * Called on conversation delete or explicit reset.
 */
export function clearPlanMode(conversationId: string): void {
  planModeMap.delete(conversationId);
  notifySubscribers(conversationId, null);
}

// ── P1-3b-2 mirror seams ────────────────────────────────────────────────
//
// planMode is one of the two ports that needs a bidirectional mirror once
// the main agent loop can run in the sidecar (docs/2026-07-20-phase1-p3b-
// loop-entry-design.md §3 "planMode" row): the shell writes via
// setPlanMode/clearPlanMode (report_plan tool, memoryTools.ts — always
// shell-side per §2 雷3) and must push that change to the sidecar as a
// `state.planMode` notification; the sidecar's own entry-point clear
// (agentLoop.ts's per-run reset) must be mirrored back into this shell-side
// map via a `plan.clear` notification WITHOUT re-triggering the
// shell→sidecar push (that would be a notify-loop — see applyPlanModeState).
//
// Zero behavior when no subscriber is registered — onPlanModeChange is an
// empty no-op until 3b-3 calls it, and setPlanMode/clearPlanMode's own
// state-map behavior is byte-identical to before this batch either way.

type PlanModeChangeListener = (conversationId: string, mode: PlanModeState | null) => void;

const planModeListeners = new Set<PlanModeChangeListener>();

function notifySubscribers(conversationId: string, mode: PlanModeState | null): void {
  for (const listener of planModeListeners) {
    listener(conversationId, mode);
  }
}

/**
 * Subscribe to plan-mode changes — invoked synchronously inside
 * setPlanMode/clearPlanMode (never inside applyPlanModeState, see below).
 * Returns an unsubscribe function.
 */
export function onPlanModeChange(cb: PlanModeChangeListener): () => void {
  planModeListeners.add(cb);
  return () => {
    planModeListeners.delete(cb);
  };
}

/**
 * Mirror-apply a plan-mode state received FROM the sidecar (a `plan.clear`/
 * `state.planMode` notification), without notifying subscribers — applying
 * a mirrored update must not echo back out over the same channel it just
 * came in on (see this module's mirror-seam doc comment above).
 *
 * `mode: null` mirrors clearPlanMode's delete-the-entry behavior;
 * a non-null mode mirrors setPlanMode's set-the-entry behavior.
 */
export function applyPlanModeState(conversationId: string, mode: PlanModeState | null): void {
  if (mode === null) {
    planModeMap.delete(conversationId);
  } else {
    planModeMap.set(conversationId, mode);
  }
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
  TOOL_NAMES.CAPABILITY_SNAPSHOT,
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
