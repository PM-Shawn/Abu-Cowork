/**
 * Sidecar-local replacement for `src/core/observability/langfuse.ts`'s
 * `startSubagentSpan` — the only export `subagentLoop.ts` imports from that
 * module. The real module imports `getTauriFetch()` (Tauri-coupled) and the
 * `langfuse` SDK; observability for sidecar-run subagents is out of scope
 * for P1-3a (per the design doc's §3 "本期明确不做" — no new cross-process
 * telemetry plumbing this phase). This is a legitimate no-op shim (NOT a
 * violation of the "no silent no-op for behavior-bearing paths" rule):
 * losing a Langfuse trace for sidecar-run subagents doesn't change what the
 * subagent DOES, only what gets observed about it afterward — same
 * "no-op safe" class as the langfuse shim P1-1 already uses for llmHost.ts.
 */
import type { EndableSubagentSpan } from '@/core/observability/langfuse';

const NOOP_SUBAGENT_SPAN: EndableSubagentSpan = { end() {} };

export function startSubagentSpan(
  _parentConversationId: string | null,
  _data: { agentName: string; task: string },
): EndableSubagentSpan {
  return NOOP_SUBAGENT_SPAN;
}
