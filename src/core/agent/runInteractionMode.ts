import type { ToolExecutionContext } from '../../types';
import type { RunPermissionCeiling } from '../permissions/runPermissionCeiling';
import type { IMContext } from './orchestrator';

export interface RunInteractionModeInput {
  authorizationScopeId?: string;
  runPermissionCeiling?: RunPermissionCeiling;
  imContext?: IMContext;
  triggerId?: string;
  scheduledTaskId?: string;
}

/**
 * Derive whether a run may rely on interactive desktop affordances. Presence
 * is intentionally conservative: malformed legacy provenance such as an empty
 * id must stay background instead of silently widening authority.
 */
export function deriveRunInteractionMode(
  input: RunInteractionModeInput,
): NonNullable<ToolExecutionContext['interactionMode']> {
  return input.authorizationScopeId !== undefined
    || input.runPermissionCeiling !== undefined
    || input.imContext !== undefined
    || input.triggerId !== undefined
    || input.scheduledTaskId !== undefined
    ? 'background'
    : 'foreground';
}
