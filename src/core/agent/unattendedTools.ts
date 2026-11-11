import type { ToolExecutionContext } from '../../types';
import { TOOL_NAMES } from '../tools/toolNames';

/**
 * Tools that wait for a person at the desktop: `request_workspace` opens a
 * folder picker and `ask_user_question` a choice card, and either hangs until
 * its timeout when nobody is looking. A run with nobody present must not be
 * offered them.
 *
 * Applied in one place, the agent loop, for every run whose interaction mode is
 * 'background' (scheduled tasks, triggers, the file watcher, IM), so an entry
 * point added later cannot forget it.
 */
export const UNATTENDED_BLOCKED_TOOLS: readonly string[] = [
  TOOL_NAMES.REQUEST_WORKSPACE,
  TOOL_NAMES.ASK_USER_QUESTION,
];

/**
 * `blocked` plus the unattended tools when the run is in 'background' mode;
 * `blocked` itself (same reference) for a foreground run, and for a background
 * run that already lists them all.
 */
export function withUnattendedBlockedTools(
  blocked: string[] | undefined,
  interactionMode: ToolExecutionContext['interactionMode'],
): string[] | undefined {
  if (interactionMode !== 'background') return blocked;
  const missing = UNATTENDED_BLOCKED_TOOLS.filter((name) => !blocked?.includes(name));
  return missing.length === 0 ? blocked : [...(blocked ?? []), ...missing];
}
