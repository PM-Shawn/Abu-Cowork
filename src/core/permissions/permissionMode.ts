/**
 * Permission Mode System — controls tool execution confirmation behavior.
 *
 * Three tiers along a single autonomy axis (the workspace is the boundary):
 * - standard:   Inside the workspace, read/write/commands run freely. Escalations
 *               (writes to new directories, dangerous commands) require confirmation.
 * - smart:      Same boundary as standard, but escalations are routed to an AI
 *               reviewer instead of the user. (Reviewer lands in Phase 2; until then
 *               the gate degrades 'review' to 'confirm'.)
 * - autonomous: Everything runs automatically. Block-level commands, sensitive-path
 *               hard-blocks and the content guard still apply — they are enforced
 *               independently of the mode, not via these strategies.
 */

import type { ConfirmationInfo } from '../tools/registry';
import type { CmdBoundary } from './commandBoundary';

/** Permission mode determines how much autonomy the agent has before asking. */
export type PermissionMode = 'standard' | 'smart' | 'autonomous';

/**
 * Outcome of a permission decision:
 * - allow:   proceed without asking
 * - confirm: ask the user
 * - review:  route to the AI reviewer (Phase 2); degrades to 'confirm' until wired
 */
export type PermissionDecision = 'allow' | 'confirm' | 'review';

/**
 * Strategy interface for permission decisions.
 * Each mode implements this to decide how a tool call is gated.
 */
export interface PermissionStrategy {
  /**
   * Decide gating for the run_command tool.
   * @param boundary - whether the command writes outside the working dirs (best-effort)
   */
  decideCommand(info: ConfirmationInfo, readOnly: boolean, boundary?: CmdBoundary): PermissionDecision;

  /** Decide gating for file tools (read_file, write_file, edit_file, etc.). */
  decideFileAccess(capability: 'read' | 'write', needsPermission: boolean): PermissionDecision;

  /** Decide gating for MCP/other tools. */
  decideOtherTool(): PermissionDecision;
}

/** Whether a command's content classification counts as an escalation. */
function isRiskyCommand(level: ConfirmationInfo['level']): boolean {
  return level === 'danger' || level === 'warn';
}

/** standard: workspace-internal is free; escalations ask the user. Matches the old `default` behavior. */
const standardStrategy: PermissionStrategy = {
  decideCommand(info, readOnly, boundary) {
    if (readOnly) return 'allow';
    if (isRiskyCommand(info.level)) return 'confirm';
    // Safe content but writing outside the workspace → escalate.
    if (boundary === 'outside') return 'confirm';
    return 'allow';
  },
  decideFileAccess(_capability, needsPermission) {
    // needsPermission === true means the path isn't in an authorized working dir yet.
    return needsPermission ? 'confirm' : 'allow';
  },
  decideOtherTool() {
    return 'allow';
  },
};

/** smart: same boundary as standard, but escalations go to the AI reviewer. */
const smartStrategy: PermissionStrategy = {
  decideCommand(info, readOnly, boundary) {
    if (readOnly) return 'allow';
    return (isRiskyCommand(info.level) || boundary === 'outside') ? 'review' : 'allow';
  },
  decideFileAccess(_capability, needsPermission) {
    return needsPermission ? 'review' : 'allow';
  },
  decideOtherTool() {
    return 'allow';
  },
};

/** autonomous: everything proceeds. Block-level/sensitive-path/content-guard floors are enforced elsewhere. */
const autonomousStrategy: PermissionStrategy = {
  decideCommand() {
    return 'allow';
  },
  decideFileAccess() {
    return 'allow';
  },
  decideOtherTool() {
    return 'allow';
  },
};

/**
 * Get the permission strategy for a given mode. Unknown modes fall back to standard.
 */
export function getPermissionStrategy(mode: PermissionMode): PermissionStrategy {
  switch (mode) {
    case 'smart': return smartStrategy;
    case 'autonomous': return autonomousStrategy;
    case 'standard':
    default: return standardStrategy;
  }
}
