import type { ToolExecutionContext } from '../../types';
import type { RunPermissionCeiling } from '../permissions/runPermissionCeiling';
import type { IMContext } from './orchestrator';

/**
 * Who started THIS run. `'user'` = a human sent a message from the desktop
 * composer (or clicked retry/resume/continue); `'automation'` = the scheduler
 * tick, a trigger firing, an IM inbound message or a file watcher. Stamped by
 * the dispatch entry point that knows, never derived from the conversation
 * record — a scheduled conversation the user later types into is still a
 * human at the keyboard.
 */
export type RunInitiator = 'user' | 'automation';

export interface RunInteractionModeInput {
  authorizationScopeId?: string;
  runPermissionCeiling?: RunPermissionCeiling;
  imContext?: IMContext;
  triggerId?: string;
  scheduledTaskId?: string;
  initiatedBy?: RunInitiator;
}

/**
 * Derive whether a run may rely on interactive desktop affordances. Presence
 * is intentionally conservative: malformed legacy provenance such as an empty
 * id must stay background instead of silently widening authority.
 *
 * Precedence, strictest first:
 *   1. `initiatedBy: 'automation'` → background, whatever else is set.
 *   2. A scope / ceiling / IM context → background. These are positive
 *      "this run is fenced" markers a dispatch entry attaches on purpose;
 *      a human-typed send never carries them, so `initiatedBy: 'user'` must
 *      not be able to strip them.
 *   3. `initiatedBy: 'user'` → foreground. The conversation-record markers
 *      (`triggerId` / `scheduledTaskId`) describe where the conversation came
 *      from, not who is driving it now; a human who types into a scheduled
 *      task's conversation is watching the screen and gets the dialogs.
 *   4. Otherwise (no initiator known) the conversation-record markers decide,
 *      exactly as before — an unlabelled run in a scheduled conversation
 *      stays background.
 */
export function deriveRunInteractionMode(
  input: RunInteractionModeInput,
): NonNullable<ToolExecutionContext['interactionMode']> {
  if (input.initiatedBy === 'automation') return 'background';
  if (
    input.authorizationScopeId !== undefined
    || input.runPermissionCeiling !== undefined
    || input.imContext !== undefined
  ) {
    return 'background';
  }
  if (input.initiatedBy === 'user') return 'foreground';
  return input.triggerId !== undefined || input.scheduledTaskId !== undefined
    ? 'background'
    : 'foreground';
}
