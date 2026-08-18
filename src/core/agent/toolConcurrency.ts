/**
 * Concurrency-aware tool batch scheduling.
 *
 * Consumes each tool's `isConcurrencySafe` metadata (see
 * `ToolDefinition.isConcurrencySafe` in `@/types`) so a batch of tool calls
 * collected from a single LLM turn is neither always fully parallel nor
 * always fully serial. Mirrors Claude Code's approach (reverse-engineered):
 *
 * (a) Safety is decided PER CALL against its resolved input, not just the
 *     tool name — e.g. `run_command` is only concurrency-safe when the
 *     specific command is read-only (see `commandTools.ts`'s
 *     `isConcurrencySafe: (input) => isReadOnlyCommand(...)`). A tool with no
 *     definition, or whose `isConcurrencySafe` throws while inspecting the
 *     input, is treated as unsafe (fail-closed) — an unparsable input is
 *     never assumed safe.
 * (b) Batching is a reduce over the ORIGINAL call order: consecutive
 *     concurrency-safe calls merge into one parallel batch; a
 *     concurrency-unsafe call always starts (and is alone in) its own
 *     serial batch — it never merges with a neighboring unsafe call, so
 *     relative execution order among unsafe calls is preserved exactly as
 *     the model emitted them.
 */

import type { ToolCall, ToolDefinition } from '../../types';

export interface ConcurrencyBatch {
  /** Whether this batch's calls may run in parallel with each other. */
  safe: boolean;
  calls: ToolCall[];
}

/**
 * Resolve whether a single tool call is concurrency-safe, using the same
 * defensive shape as `agentLoopRunner.ts`'s `isToolCallReplaySafe` (kept
 * identical on purpose — one fail-closed pattern for `isConcurrencySafe`
 * across the codebase, not two divergent ones):
 * - No matching tool definition → unsafe.
 * - `isConcurrencySafe` is a function → call it with the resolved input;
 *   any thrown error (e.g. malformed/unparsable input) → unsafe.
 * - `isConcurrencySafe` is a static boolean → use it as-is.
 * - `undefined` → unsafe (matches `ToolDefinition.isConcurrencySafe`'s
 *   documented fail-closed default).
 */
export function resolveToolConcurrencySafety(
  tool: ToolDefinition | undefined,
  input: Record<string, unknown>,
): boolean {
  if (!tool) return false;
  try {
    return typeof tool.isConcurrencySafe === 'function'
      ? tool.isConcurrencySafe(input) === true
      : tool.isConcurrencySafe === true;
  } catch {
    return false;
  }
}

/**
 * Group a batch of tool calls (in original order) into execution batches.
 *
 * `isSafe` is injected rather than resolved internally so callers can look
 * up tool definitions however they see fit (e.g. `ToolInvoker.getAllTools()`)
 * and so this function stays a pure, easily-testable reducer.
 */
export function groupToolCallsByConcurrency(
  toolCalls: ToolCall[],
  isSafe: (toolCall: ToolCall) => boolean,
): ConcurrencyBatch[] {
  return toolCalls.reduce<ConcurrencyBatch[]>((batches, toolCall) => {
    const safe = isSafe(toolCall);
    const previous = batches[batches.length - 1];
    if (safe && previous?.safe) {
      previous.calls.push(toolCall);
    } else {
      batches.push({ safe, calls: [toolCall] });
    }
    return batches;
  }, []);
}
