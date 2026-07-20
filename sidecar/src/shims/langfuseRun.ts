/**
 * Sidecar-local replacement for `src/core/observability/langfuse.ts`.
 *
 * P1-3B-3A EXTENSION: P1-3a only needed `startSubagentSpan` (the sole export
 * `subagentLoop.ts` imports). Now that `agentLoop.ts`/`toolExecutor.ts` are
 * ALSO reachable (the main loop), they need `startConversationTrace`/
 * `endConversationTrace`/`startGeneration` (agentLoop.ts) and
 * `startToolSpan` (toolExecutor.ts) too — verified by the actual
 * `npm run build:sidecar` failure (`No matching export in
 * "shims/langfuseRun.ts"`), not guessed. Same legitimate-no-op reasoning as
 * `startSubagentSpan` already established: losing a Langfuse trace for a
 * sidecar-run main loop doesn't change what the loop DOES, only what gets
 * observed about it afterward — same "no-op safe" class the P1-1 langfuse
 * shim already uses for `llmHost.ts`, and unchanged from the design doc's
 * §6 "本期明确不做" ("langfuse 跨进程" is explicitly out of scope for the
 * whole 3b initiative).
 *
 * `EndableGeneration`/`EndableSpan` are NOT exported by the real module
 * (private `interface`s) — declared locally here with the identical
 * structural shape (`{ end(...): void }`) rather than importing, matching
 * the already-established `EndableSubagentSpan` treatment for the one type
 * that IS exported.
 */
import type { EndableSubagentSpan } from '@/core/observability/langfuse';

interface EndableGeneration {
  end(data?: { output?: unknown; usage?: unknown; error?: string }): void;
}
interface EndableSpan {
  end(data?: { output?: unknown; error?: string }): void;
}

const NOOP_SUBAGENT_SPAN: EndableSubagentSpan = { end() {} };
const NOOP_GENERATION: EndableGeneration = { end() {} };
const NOOP_SPAN: EndableSpan = { end() {} };

export function startSubagentSpan(
  _parentConversationId: string | null,
  _data: { agentName: string; task: string },
): EndableSubagentSpan {
  return NOOP_SUBAGENT_SPAN;
}

export function startConversationTrace(
  _conversationId: string,
  _data: { name?: string; input?: unknown; metadata?: Record<string, unknown> },
): void {
  // Intentional no-op — see module doc.
}

export function endConversationTrace(
  _conversationId: string,
  _data?: { output?: unknown; error?: string },
): void {
  // Intentional no-op — see module doc.
}

export function startGeneration(
  _conversationId: string,
  _data: { name?: string; model: string; input: unknown; startTime?: Date },
): EndableGeneration {
  return NOOP_GENERATION;
}

export function startToolSpan(
  _conversationId: string,
  _data: { name: string; input?: unknown },
): EndableSpan {
  return NOOP_SPAN;
}
