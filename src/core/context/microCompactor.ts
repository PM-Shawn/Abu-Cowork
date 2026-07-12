/**
 * Micro-Compaction — compress individual large tool results before sending to LLM.
 *
 * Unlike the full context compressor (contextCompressor.ts) which summarizes entire
 * conversation history, micro-compaction targets individual oversized tool results
 * using fast rule-based truncation (no LLM call needed).
 *
 * Key principle: chatStore keeps the ORIGINAL full result for user display.
 * Micro-compaction only affects the messages sent to the LLM in the next turn.
 */

import type { Message, ToolCallForContext } from '../../types';

/**
 * Tools whose results should NOT be micro-compacted.
 * These either have very short results or contain structural information
 * that breaks when truncated. All other tools are compacted by default.
 */
const SKIP_COMPACT = new Set<string>([
  'report_plan',       // Plan steps — structure matters
  'recall',            // Memory content — already concise
  'get_system_info',   // System info — always short
  'clipboard_read',    // Clipboard — typically short
  'system_notify',     // Notification — very short
  'update_memory',     // Memory write result — very short
  'computer',          // Screenshot results — images, not compactable text
]);

/**
 * Character threshold for triggering micro-compaction on a single tool result.
 * ~1500 tokens at 4 chars/token. Results below this pass through unchanged.
 */
const MICRO_COMPACT_CHAR_THRESHOLD = 6000;

/** How many characters to keep from the head of the result */
const HEAD_KEEP_CHARS = 1500;

/** How many characters to keep from the tail of the result */
const TAIL_KEEP_CHARS = 500;

/**
 * Check if a tool result should be micro-compacted.
 */
export function shouldMicroCompact(toolName: string, resultText: string): boolean {
  if (SKIP_COMPACT.has(toolName)) return false;
  return resultText.length > MICRO_COMPACT_CHAR_THRESHOLD;
}

/**
 * Truncate a large tool result, keeping head + tail with a truncation marker.
 * The marker tells the LLM that information was removed and it can re-call the tool if needed.
 */
export function microCompactResult(toolName: string, resultText: string): string {
  if (!shouldMicroCompact(toolName, resultText)) return resultText;

  const removedChars = resultText.length - HEAD_KEEP_CHARS - TAIL_KEEP_CHARS;
  const head = resultText.slice(0, HEAD_KEEP_CHARS);
  const tail = resultText.slice(-TAIL_KEEP_CHARS);

  return `${head}\n\n[... ${removedChars} characters truncated for context management. Call the tool again if you need the full content ...]\n\n${tail}`;
}

/**
 * Apply micro-compaction to tool results in a message array.
 *
 * Returns a NEW array with compacted messages — does NOT modify the input array.
 * Only affects `toolCallsForContext` (the version sent to the LLM), not `toolCalls`
 * (the version shown in UI), preserving the separation already in the codebase.
 *
 * @param messages - Messages to process (from conversation history)
 * @param skipRecentRounds - Number of recent message rounds to skip (keep full results for recent context)
 * @returns New message array with large tool results compacted
 */
export function applyMicroCompaction(messages: Message[], skipRecentRounds: number = 2): Message[] {
  if (messages.length === 0) return messages;

  // Don't compact the most recent messages — the LLM may need full context for its current task
  const skipFromEnd = Math.min(skipRecentRounds * 2, messages.length); // 2 msgs per round (user+assistant)
  const cutoff = messages.length - skipFromEnd;

  return messages.map((msg, idx) => {
    // Skip recent messages
    if (idx >= cutoff) return msg;

    // Only process assistant messages with tool calls
    if (msg.role !== 'assistant') return msg;
    const tcSource = msg.toolCallsForContext || msg.toolCalls;
    if (!tcSource || tcSource.length === 0) return msg;

    // Check if any tool results need compaction
    let needsCompaction = false;
    for (const tc of tcSource) {
      const result = 'result' in tc ? (tc.result as string | undefined) : undefined;
      if (result && shouldMicroCompact(tc.name, result)) {
        needsCompaction = true;
        break;
      }
    }
    if (!needsCompaction) return msg;

    // Create compacted copy of toolCallsForContext
    const compactedToolCalls: ToolCallForContext[] = (tcSource as ToolCallForContext[]).map(tc => {
      const result = tc.result as string | undefined;
      if (!result || !shouldMicroCompact(tc.name, result)) return tc;
      return {
        ...tc,
        result: microCompactResult(tc.name, result),
      };
    });

    return {
      ...msg,
      toolCallsForContext: compactedToolCalls,
    };
  });
}
