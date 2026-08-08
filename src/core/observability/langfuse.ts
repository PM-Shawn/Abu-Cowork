/**
 * Client-side trace event port (client single-source model, 2026-08-09).
 *
 * The enterprise gateway's Langfuse callback is OFF — the client is the sole
 * trace source. Loop/tool/subagent spans travel over the lifecycle-hook bus
 * (collected by the enterprise module); LLM generations are emitted HERE, at
 * the agent-loop call sites, into whatever sink is registered. Enterprise
 * builds register a sink that batches generations to the Console relay
 * (`/api/client/v1/trace/spans`) — the Langfuse keys stay server-side, no
 * key material ever reaches a client build.
 *
 * OSS default: no sink registered → every call is a no-op (zero collection,
 * the CLAUDE.md privacy red line). The former VITE_LANGFUSE_* direct-write
 * dev channel and the `langfuse` SDK dependency are deleted with the same
 * decision — a client build must not even contain a path that could carry
 * keys.
 *
 * Known limit (unchanged from the sidecar design's §6 "本期明确不做"):
 * sidecar-run loops replace this module with a no-op shim, so their
 * generations are not reported; their loop/tool spans still arrive via the
 * lifecycle-hook bridge.
 */

import type { TokenUsage } from '../../types';

/** One finished LLM call, full content — consumed by the enterprise sink. */
export interface GenerationEvent {
  conversationId: string;
  name?: string;
  model: string;
  input: unknown;
  output?: unknown;
  usage?: TokenUsage;
  costUsd?: number;
  /** epoch ms */
  startTime: number;
  /** epoch ms */
  endTime: number;
  error?: string;
}

export interface TraceSink {
  onGeneration(event: GenerationEvent): void;
}

let _sink: TraceSink | null = null;

/** Register the active trace sink (enterprise builds). Returns unregister. */
export function registerTraceSink(sink: TraceSink): () => void {
  _sink = sink;
  return () => {
    if (_sink === sink) _sink = null;
  };
}

export function isObservabilityEnabled(): boolean {
  return _sink !== null;
}

// --- API kept stable for existing call sites ------------------------------
// agentLoop/toolExecutor/subagentLoop call these unconditionally; with no
// sink they are free no-ops. Loop/tool/subagent spans are NOT emitted here —
// the lifecycle-hook bus is their single source (it also covers sidecar-run
// loops, which this module cannot).

interface EndableGeneration {
  end(data?: { output?: unknown; usage?: TokenUsage; costUsd?: number; level?: 'ERROR'; statusMessage?: string }): void;
}
interface EndableSpan {
  end(data?: { output?: unknown; level?: 'ERROR'; statusMessage?: string }): void;
}
const NOOP_GENERATION: EndableGeneration = { end() {} };
const NOOP_SPAN: EndableSpan = { end() {} };

/** Trace lifecycle is owned by the lifecycle-hook bus (agentStart/agentEnd). */
export function startConversationTrace(
  _conversationId: string,
  _data: { name?: string; input?: unknown; metadata?: Record<string, unknown> },
): void {}

export function endConversationTrace(
  _conversationId: string,
  _data?: { output?: unknown; error?: string },
): void {}

/** Record one LLM turn as a generation. Returns a no-op handle when no sink. */
export function startGeneration(
  conversationId: string,
  data: { name?: string; model: string; input: unknown; startTime?: Date },
): EndableGeneration {
  const sink = _sink;
  if (!sink) return NOOP_GENERATION;
  const startTime = data.startTime?.getTime() ?? Date.now();
  return {
    end(end) {
      try {
        sink.onGeneration({
          conversationId,
          name: data.name,
          model: data.model,
          input: data.input,
          output: end?.output,
          usage: end?.usage,
          costUsd: end?.costUsd,
          startTime,
          endTime: Date.now(),
          ...(end?.level === 'ERROR' ? { error: end?.statusMessage ?? 'error' } : {}),
        });
      } catch { /* best-effort */ }
    },
  };
}

/** Tool spans are reported via the postToolCall lifecycle hook, not here. */
export function startToolSpan(
  _conversationId: string,
  _data: { name: string; input?: unknown },
): EndableSpan {
  return NOOP_SPAN;
}

/** Handle returned by startSubagentSpan */
export interface EndableSubagentSpan {
  end(data?: {
    output?: unknown;
    tokenUsage?: { input: number; output: number };
    toolCallCount?: number;
    turnCount?: number;
    duration?: number;
    error?: string;
  }): void;
}

const NOOP_SUBAGENT_SPAN: EndableSubagentSpan = { end() {} };

/** Subagent spans are reported via the subagentEnd lifecycle hook, not here. */
export function startSubagentSpan(
  _parentConversationId: string | null,
  _data: { agentName: string; task: string },
): EndableSubagentSpan {
  return NOOP_SUBAGENT_SPAN;
}
