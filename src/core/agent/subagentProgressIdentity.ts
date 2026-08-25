import type { SubagentLoopOptions, SubagentProgressEvent } from './subagentLoop';
import { encodeBoundedIdentityPart } from '@/utils/boundedIdentity';

let progressScopeCounter = 0;

export const SUBAGENT_PROGRESS_TOOL_CALL_ID_MAX_BYTES = 2_048;

const SUBAGENT_PROGRESS_TOOL_CALL_ID_PREFIX = 'subagent-v1:';
const SUBAGENT_PROGRESS_RUN_ID_MAX_BYTES = 512;

/**
 * Mint an app-owned identity for one subagent loop. Provider tool-call ids are
 * only unique within a single model run, so every top-level, nested, and
 * transport-fallback loop needs its own namespace before progress reaches the
 * parent conversation.
 */
export function createSubagentProgressScopeId(): string {
  progressScopeCounter += 1;
  return `sar-${Date.now().toString(36)}-${progressScopeCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Provider tool-call ids are unique only inside one model run. Once progress
 * leaves that run and joins the parent conversation, namespace the id with the
 * app-owned subagent run id so separate agents may both legitimately emit
 * values such as `call_1` without colliding in persistence or replay.
 */
export function makeSubagentProgressToolCallId(runId: string, providerToolCallId: string): string {
  const encodedRunId = encodeBoundedIdentityPart(runId, SUBAGENT_PROGRESS_RUN_ID_MAX_BYTES);
  const providerBytes = Math.max(
    0,
    SUBAGENT_PROGRESS_TOOL_CALL_ID_MAX_BYTES
      - SUBAGENT_PROGRESS_TOOL_CALL_ID_PREFIX.length
      - encodedRunId.length
      - 1,
  );
  const encodedProviderId = encodeBoundedIdentityPart(providerToolCallId, providerBytes);
  return `${SUBAGENT_PROGRESS_TOOL_CALL_ID_PREFIX}${encodedRunId}:${encodedProviderId}`;
}

export function scopeSubagentProgressEvent(
  runId: string,
  event: SubagentProgressEvent,
): SubagentProgressEvent {
  if (event.type === 'turn-complete') return event;
  return {
    ...event,
    id: makeSubagentProgressToolCallId(runId, event.id),
  };
}

/**
 * Wrap one loop's progress callback in an app-owned namespace. Keeping this in
 * a runtime-neutral production module lets both the shell selector and the
 * in-sidecar nested-run shim apply exactly the same identity boundary.
 */
export function scopeSubagentLoopProgress(
  options: SubagentLoopOptions,
  scopeId: string = createSubagentProgressScopeId(),
): SubagentLoopOptions {
  if (!options.onProgress) return options;
  return {
    ...options,
    onProgress: (event) => options.onProgress?.(scopeSubagentProgressEvent(scopeId, event)),
  };
}
