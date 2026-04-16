import type {
  Message,
  ToolCallForContext,
} from '../../../../src/types';

const SKIP_COMPACT = new Set<string>([
  'report_plan',
  'recall',
  'get_system_info',
  'clipboard_read',
  'system_notify',
  'update_memory',
  'todo_write',
  'computer',
]);

const MICRO_COMPACT_CHAR_THRESHOLD = 6000;
const HEAD_KEEP_CHARS = 1500;
const TAIL_KEEP_CHARS = 500;

export function shouldMicroCompact(toolName: string, resultText: string): boolean {
  if (SKIP_COMPACT.has(toolName)) return false;
  return resultText.length > MICRO_COMPACT_CHAR_THRESHOLD;
}

export function microCompactResult(toolName: string, resultText: string): string {
  if (!shouldMicroCompact(toolName, resultText)) return resultText;
  const removedChars = resultText.length - HEAD_KEEP_CHARS - TAIL_KEEP_CHARS;
  const head = resultText.slice(0, HEAD_KEEP_CHARS);
  const tail = resultText.slice(-TAIL_KEEP_CHARS);
  return `${head}\n\n[... ${removedChars} characters truncated for context management. Call the tool again if you need the full content ...]\n\n${tail}`;
}

export function applyMicroCompaction(messages: Message[], skipRecentRounds = 2): Message[] {
  if (messages.length === 0) return messages;
  const skipFromEnd = Math.min(skipRecentRounds * 2, messages.length);
  const cutoff = messages.length - skipFromEnd;

  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg;
    if (msg.role !== 'assistant') return msg;
    const tcSource = msg.toolCallsForContext || msg.toolCalls;
    if (!tcSource || tcSource.length === 0) return msg;

    let needsCompaction = false;
    for (const tc of tcSource) {
      const result = 'result' in tc ? (tc.result as string | undefined) : undefined;
      if (result && shouldMicroCompact(tc.name, result)) {
        needsCompaction = true;
        break;
      }
    }
    if (!needsCompaction) return msg;

    const compactedToolCalls: ToolCallForContext[] = (tcSource as ToolCallForContext[]).map(
      (tc) => {
        const result = tc.result as string | undefined;
        if (!result || !shouldMicroCompact(tc.name, result)) return tc;
        return { ...tc, result: microCompactResult(tc.name, result) };
      }
    );

    return { ...msg, toolCallsForContext: compactedToolCalls };
  });
}
