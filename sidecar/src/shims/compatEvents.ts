/**
 * Sidecar shim for `src/core/observability/compatEvents.ts`.
 *
 * The real module reports OpenAI-compatible-adapter edge cases to Langfuse.
 * Langfuse client setup and the OSS-privacy no-op gate live shell-side only;
 * the sidecar doesn't carry Langfuse credentials or an initialized client.
 * Swapped in at bundle time by `scripts/build-sidecar.mjs`. No-op — matches
 * the real module's "silently do nothing when observability is disabled"
 * behavior, which is always true here.
 */

export interface CompatEventPayload {
  kind:
    | 'unknown_finish_reason'
    | 'dropped_tool_calls'
    | 'error_finish_reason'
    | 'content_filtered';
  modelId?: string;
  requestHost?: string;
  finishReason?: string;
  toolCallCount?: number;
}

export function observeCompatEvent(_evt: CompatEventPayload): void {
  // Intentional no-op — see module doc.
}
