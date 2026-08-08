/**
 * Lightweight observability helper for OpenAI-compatible adapter edge cases.
 *
 * Reports control-flow anomalies (unknown finish_reason, content_filter, etc.)
 * — metadata only, never message content.
 *
 * Currently inert: the VITE_LANGFUSE_* direct-write channel it used to feed
 * was deleted with the client single-source decision (2026-08-09, keys must
 * never reach a client build). Call sites are kept; if anomaly telemetry is
 * needed again, route it through the trace sink in `./langfuse.ts`.
 */

export interface CompatEventPayload {
  /** Discriminator for the type of anomaly. */
  kind:
    | 'unknown_finish_reason'
    | 'dropped_tool_calls'
    | 'error_finish_reason'
    | 'content_filtered';
  /** The model ID from ChatOptions (e.g. 'gpt-4o', 'glm-5'). */
  modelId?: string;
  /** Hostname of the provider endpoint (e.g. 'api.openai.com'). */
  requestHost?: string;
  /** The raw finish_reason string received from the provider. */
  finishReason?: string;
  /** Number of buffered tool calls at the time of the anomaly. */
  toolCallCount?: number;
}

/** No-op (see module header). Never throws. */
export function observeCompatEvent(_evt: CompatEventPayload): void {}
