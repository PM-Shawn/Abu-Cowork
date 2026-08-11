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
import { emitHook } from '@/core/agent/lifecycleHooks';

interface EndableGeneration {
  end(data?: {
    output?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
    costUsd?: number;
    level?: 'ERROR';
    statusMessage?: string;
  }): void;
}
interface EndableSpan {
  end(data?: { output?: unknown; error?: string }): void;
}

const NOOP_SUBAGENT_SPAN: EndableSubagentSpan = { end() {} };
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

// Generations from sidecar-run loops DO get reported — over the lifecycle
// hook bridge (hook.notify → renderer hookBridge → renderer hook bus), the
// same transport postToolCall already uses. The renderer-side enterprise
// collector listens for 'llmGeneration'; in OSS builds nothing listens and
// the event dies in the local bus, preserving zero-collection. Content is
// JSON-serialized and capped so the RPC frame stays bounded.
const GENERATION_CONTENT_CHARS = 200_000;

function serializeCapped(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > 0 ? s.slice(0, GENERATION_CONTENT_CHARS) : undefined;
}

export function startGeneration(
  conversationId: string,
  data: { name?: string; model: string; input: unknown; startTime?: Date },
): EndableGeneration {
  const startTime = data.startTime?.getTime() ?? Date.now();
  return {
    end(end) {
      try {
        const endTime = Date.now();
        void emitHook({
          type: 'llmGeneration',
          timestamp: endTime,
          conversationId,
          model: data.model,
          name: data.name,
          input: serializeCapped(data.input),
          output: serializeCapped(end?.output),
          usage: end?.usage,
          costUsd: end?.costUsd,
          startTime,
          endTime,
          ...(end?.level === 'ERROR' ? { error: end?.statusMessage ?? 'error' } : {}),
        });
      } catch { /* best-effort — a lost generation must never break the loop */ }
    },
  };
}

export function startToolSpan(
  _conversationId: string,
  _data: { name: string; input?: unknown },
): EndableSpan {
  return NOOP_SPAN;
}
