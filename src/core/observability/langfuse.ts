/**
 * Langfuse observability client (Phase A: dev self-test).
 *
 * Abu runs in a Tauri WebView. The Langfuse SDK's default transport is the
 * WebView's global fetch, which is subject to CORS — a self-hosted Langfuse
 * won't set CORS headers for the `tauri://` origin. We subclass Langfuse and
 * route its `fetch` through `getTauriFetch()` (Rust-side HTTP, no CORS, and
 * localhost requests additionally strip the injected Origin header).
 *
 * Disabled (all calls become no-ops) when VITE_LANGFUSE_* keys are absent.
 */

import { Langfuse } from 'langfuse';
import type { LangfuseTraceClient } from 'langfuse';
import type { TokenUsage } from '../../types';
import { getTauriFetch } from '../llm/tauriFetch';

// Structural match for langfuse-core's LangfuseFetchOptions (not re-exported by
// the `langfuse` package). Method parameter bivariance lets this override the
// base `fetch`; a standard `Response` satisfies the base's LangfuseFetchResponse.
interface TauriFetchOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

class TauriLangfuse extends Langfuse {
  async fetch(url: string, options: TauriFetchOptions): Promise<Response> {
    const tauriFetch = await getTauriFetch();
    return tauriFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });
  }
}

let _client: Langfuse | null | undefined;

/**
 * Returns a lazily-initialised Langfuse client, or null when observability is
 * not configured. The result is cached (including the null case) so callers can
 * invoke this on every turn cheaply.
 */
export function getLangfuse(): Langfuse | null {
  if (_client !== undefined) return _client;

  const publicKey = import.meta.env.VITE_LANGFUSE_PUBLIC_KEY;
  const secretKey = import.meta.env.VITE_LANGFUSE_SECRET_KEY;
  const baseUrl = import.meta.env.VITE_LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey || !baseUrl) {
    _client = null;
    return null;
  }

  _client = new TauriLangfuse({
    publicKey,
    secretKey,
    baseUrl,
    // Desktop client: keep memory persistence, don't touch localStorage.
    persistence: 'memory',
  });
  return _client;
}

export function isObservabilityEnabled(): boolean {
  return getLangfuse() !== null;
}

// --- Trace lifecycle, keyed by conversationId -----------------------------
// One trace per runAgentLoop run. Deep call sites (generations, tool spans)
// look the trace up by conversationId instead of threading a handle through
// many function signatures — mirrors the codebase's per-conversation
// module-level singleton pattern (e.g. AbortController maps).

const _traces = new Map<string, LangfuseTraceClient>();

interface EndableGeneration {
  end(data?: { output?: unknown; usage?: TokenUsage; costUsd?: number; level?: 'ERROR'; statusMessage?: string }): void;
}
interface EndableSpan {
  end(data?: { output?: unknown; level?: 'ERROR'; statusMessage?: string }): void;
}
const NOOP_GENERATION: EndableGeneration = { end() {} };
const NOOP_SPAN: EndableSpan = { end() {} };

function mapUsage(usage?: TokenUsage, costUsd?: number) {
  if (!usage && costUsd === undefined) return undefined;
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  const hasTokens = input !== undefined || output !== undefined;
  return {
    input,
    output,
    total: hasTokens ? (input ?? 0) + (output ?? 0) : undefined,
    unit: 'TOKENS' as const,
    totalCost: costUsd,
  };
}

/** Open a trace for a conversation run. No-op when observability is disabled. */
export function startConversationTrace(
  conversationId: string,
  data: { name?: string; input?: unknown; metadata?: Record<string, unknown> },
): void {
  const lf = getLangfuse();
  if (!lf) return;
  _traces.set(
    conversationId,
    lf.trace({
      name: data.name ?? 'abu',
      sessionId: conversationId,
      input: data.input,
      metadata: data.metadata,
    }),
  );
}

/** Close a conversation's trace and flush. Fire-and-forget (never throws). */
export function endConversationTrace(
  conversationId: string,
  data?: { output?: unknown; error?: string },
): void {
  const trace = _traces.get(conversationId);
  if (!trace) return;
  _traces.delete(conversationId);
  try {
    trace.update({
      output: data?.error
        ? { error: data.error, ...(data.output !== undefined ? { result: data.output } : {}) }
        : data?.output,
    });
  } catch { /* best-effort */ }
  void getLangfuse()?.flushAsync().catch(() => {});
}

/** Record one LLM turn as a generation. Returns a no-op handle when disabled. */
export function startGeneration(
  conversationId: string,
  data: { name?: string; model: string; input: unknown; startTime?: Date },
): EndableGeneration {
  const trace = _traces.get(conversationId);
  if (!trace) return NOOP_GENERATION;
  const gen = trace.generation({
    name: data.name,
    model: data.model,
    input: data.input,
    startTime: data.startTime,
  });
  return {
    end(end) {
      try {
        gen.end({
          output: end?.output,
          usage: mapUsage(end?.usage, end?.costUsd),
          ...(end?.level === 'ERROR' ? { level: 'ERROR', statusMessage: end?.statusMessage } : {}),
        });
      } catch { /* best-effort */ }
    },
  };
}

/** Record one tool execution as a span. Returns a no-op handle when disabled. */
export function startToolSpan(
  conversationId: string,
  data: { name: string; input?: unknown },
): EndableSpan {
  const trace = _traces.get(conversationId);
  if (!trace) return NOOP_SPAN;
  const span = trace.span({ name: data.name, input: data.input });
  return {
    end(end) {
      try {
        span.end({
          output: end?.output,
          ...(end?.level === 'ERROR' ? { level: 'ERROR', statusMessage: end?.statusMessage } : {}),
        });
      } catch { /* best-effort */ }
    },
  };
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

/**
 * Start a subagent observability span. If the parent conversation trace exists,
 * creates a child span on it; otherwise creates a standalone trace + span.
 * Returns a no-op handle when observability is disabled. Never throws.
 */
export function startSubagentSpan(
  parentConversationId: string | null,
  data: { agentName: string; task: string },
): EndableSubagentSpan {
  const lf = getLangfuse();
  if (!lf) return NOOP_SUBAGENT_SPAN;

  try {
    const spanName = `subagent:${data.agentName}`;
    const spanInput = { task: data.task };

    let span: ReturnType<LangfuseTraceClient['span']>;
    let standaloneTrace: LangfuseTraceClient | null = null;

    const parentTrace = parentConversationId ? _traces.get(parentConversationId) : undefined;
    if (parentTrace) {
      span = parentTrace.span({ name: spanName, input: spanInput });
    } else {
      standaloneTrace = lf.trace({ name: spanName, input: spanInput });
      span = standaloneTrace.span({ name: spanName, input: spanInput });
    }

    return {
      end(end) {
        try {
          span.end({
            output: end?.output,
            metadata: {
              ...(end?.tokenUsage !== undefined ? { tokenUsage: end.tokenUsage } : {}),
              ...(end?.toolCallCount !== undefined ? { toolCallCount: end.toolCallCount } : {}),
              ...(end?.turnCount !== undefined ? { turnCount: end.turnCount } : {}),
              ...(end?.duration !== undefined ? { duration: end.duration } : {}),
            },
            ...(end?.error ? { level: 'ERROR' as const, statusMessage: end.error } : {}),
          });
          if (standaloneTrace) {
            void lf.flushAsync().catch(() => {});
          }
        } catch { /* best-effort */ }
      },
    };
  } catch {
    return NOOP_SUBAGENT_SPAN;
  }
}

/**
 * Dev-only smoke test: emit one trace with a child generation + tool span and
 * flush synchronously. Verifies the Tauri→Langfuse transport (Phase A step 1).
 * Returns the trace URL on success.
 */
export async function langfuseSpike(): Promise<{ ok: true; traceUrl: string } | { ok: false; error: string }> {
  const lf = getLangfuse();
  if (!lf) {
    return { ok: false, error: 'Langfuse 未启用：在 .env.local 配置 VITE_LANGFUSE_PUBLIC_KEY / SECRET_KEY / BASE_URL' };
  }
  try {
    const trace = lf.trace({
      name: 'abu-spike',
      input: { hello: 'from tauri webview' },
      metadata: { source: 'langfuseSpike' },
    });
    trace.generation({
      name: 'spike-generation',
      model: 'spike-model',
      input: [{ role: 'user', content: 'ping' }],
    }).end({ output: 'pong' });
    trace.span({ name: 'spike-tool', input: { tool: 'noop' } }).end({ output: { ok: true } });
    trace.update({ output: { done: true } });

    await lf.flushAsync();
    return { ok: true, traceUrl: trace.getTraceUrl() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

if (import.meta.env.DEV) {
  (globalThis as typeof globalThis & { __abuLangfuseSpike?: typeof langfuseSpike }).__abuLangfuseSpike =
    langfuseSpike;
}
