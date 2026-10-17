import type { Message } from '@/types';
import type { DetailBlock } from '@/types/execution';

/** What handleStepError puts before a failed step's message in toolCallsForContext. */
const STEP_ERROR_PREFIX = 'Error: ';
const FULL_TEXT_BLOCKS: ReadonlySet<DetailBlock['type']> = new Set(['result', 'error', 'json']);

/**
 * Each step's result as Abu read it, by tool call id. The router appends it to
 * the turn's last assistant message when the step ends, and it is saved with
 * the conversation, so the same map serves a live turn and a reopened one.
 */
export function collectToolResultTexts(messages: readonly Message[]): Map<string, string> {
  const byToolCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const context of message.toolCallsForContext ?? []) {
      if (context.id) byToolCallId.set(context.id, context.result);
    }
  }
  return byToolCallId;
}

/**
 * The whole text a detail block can show: undefined when the block keeps its
 * own view, null when only part of it is left and the rest is not in the
 * conversation.
 */
export function blockFullText(
  block: DetailBlock,
  step: { toolCallId?: string; status: string; toolResult?: string },
  toolResults: ReadonlyMap<string, string> | undefined,
): string | null | undefined {
  if (!toolResults || !FULL_TEXT_BLOCKS.has(block.type)) return undefined;
  const stored = step.toolCallId ? toolResults.get(step.toolCallId) : undefined;
  if (stored !== undefined) {
    return step.status === 'error' && stored.startsWith(STEP_ERROR_PREFIX) ? stored.slice(STEP_ERROR_PREFIX.length) : stored;
  }
  if (block.type !== 'error' && step.toolResult !== undefined) return step.toolResult;
  return block.isTruncated ? null : block.content;
}
