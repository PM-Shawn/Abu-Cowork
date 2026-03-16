/**
 * Context Window Manager — prevent context overflow
 *
 * Strategy:
 * 1. Always keep system prompt
 * 2. Always keep first user message (task context)
 * 3. Keep last 4 complete conversation rounds
 * 4. Older messages: keep user messages, compress assistant to summary
 * 5. If still over limit, drop middle messages keeping first + last
 */

import type { Message, ToolCallForContext, ToolResultContent } from '../../types';
import { estimateTokens, estimateMessageTokens } from './tokenEstimator';
import { getMessageText, identifyRounds, RECENT_ROUNDS_TO_KEEP } from './contextUtils';

const ASSISTANT_SUMMARY_MAX_CHARS = 200;

/**
 * Maximum number of recent screenshots to keep in conversation history.
 * Older screenshots are replaced with a text placeholder to save tokens.
 * Each screenshot image is ~100K+ tokens — keeping too many quickly overflows context.
 */
const MAX_RECENT_SCREENSHOTS = 2;

/**
 * Strip old screenshot images from messages, keeping only the N most recent.
 * This prevents context overflow from accumulated screenshot base64 data.
 * Modifies messages in-place for efficiency (called before LLM send).
 */
export function trimOldScreenshots(messages: Message[]): Message[] {
  // Collect all screenshot image locations (message index + toolCall index)
  const imageLocations: { msgIdx: number; tcIdx: number }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;
    for (let j = 0; j < msg.toolCalls.length; j++) {
      const tc = msg.toolCalls[j];
      if (tc.resultContent && Array.isArray(tc.resultContent) && tc.resultContent.some((b: ToolResultContent) => b.type === 'image')) {
        imageLocations.push({ msgIdx: i, tcIdx: j });
      }
    }
  }

  if (imageLocations.length <= MAX_RECENT_SCREENSHOTS) return messages;

  // Strip images from older screenshots, keep only the most recent N
  const toStrip = imageLocations.slice(0, -MAX_RECENT_SCREENSHOTS);
  const result = messages.map((msg, i) => {
    const strippedTcIndices = toStrip.filter(loc => loc.msgIdx === i).map(loc => loc.tcIdx);
    if (strippedTcIndices.length === 0) return msg;

    // Clone message and strip images from old tool calls
    const newToolCalls = msg.toolCalls!.map((tc, j) => {
      if (!strippedTcIndices.includes(j)) return tc;
      // Replace image content with text placeholder, keep text parts
      const textParts = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'text') || [];
      const imageCount = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'image').length || 0;
      return {
        ...tc,
        resultContent: [
          ...textParts,
          { type: 'text' as const, text: `[${imageCount} screenshot(s) removed from history to save context]` },
        ],
      };
    });

    // Also strip from toolCallsForContext if present
    const newToolCallsForContext = msg.toolCallsForContext?.map((tc, j) => {
      if (!strippedTcIndices.includes(j)) return tc;
      const textParts = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'text') || [];
      return {
        ...tc,
        resultContent: [
          ...textParts,
          { type: 'text' as const, text: `[screenshot removed from history]` },
        ],
      };
    });

    return { ...msg, toolCalls: newToolCalls, toolCallsForContext: newToolCallsForContext || msg.toolCallsForContext };
  });

  return result;
}

/**
 * Compress an assistant message to a brief summary
 */
function compressAssistantMessage(msg: Message): Message {
  const text = getMessageText(msg.content);
  const truncatedText = text.length > ASSISTANT_SUMMARY_MAX_CHARS
    ? text.slice(0, ASSISTANT_SUMMARY_MAX_CHARS) + '...'
    : text;

  // Summarize tool calls
  const toolSummary = msg.toolCallsForContext?.map(
    (tc: ToolCallForContext) => `[${tc.name}]`
  ).join(', ') || msg.toolCalls?.map(
    (tc) => `[${tc.name}]`
  ).join(', ') || '';

  const compressed = toolSummary
    ? `${toolSummary}\n${truncatedText}`
    : truncatedText;

  return {
    ...msg,
    content: compressed,
    thinking: undefined,
    toolCalls: undefined,
    toolCallsForContext: undefined,
  };
}

/**
 * Prepare messages for LLM call, fitting within context window limit
 *
 * @param messages Full conversation messages
 * @param systemPrompt The system prompt text
 * @param contextWindowSize Total context window size (tokens)
 * @param reserveForOutput Tokens to reserve for model output
 * @returns Trimmed messages array
 */
export function prepareContextMessages(
  messages: Message[],
  systemPrompt: string,
  contextWindowSize: number,
  reserveForOutput: number
): Message[] {
  const maxInputTokens = contextWindowSize - reserveForOutput;
  const systemTokens = estimateTokens(systemPrompt);

  // Fast path: everything fits
  const totalTokens = systemTokens + estimateMessageTokens(messages);
  if (totalTokens <= maxInputTokens) {
    return messages;
  }

  const rounds = identifyRounds(messages);
  if (rounds.length <= 1) return messages; // Can't compress further

  // Always keep the first round (task context) and recent rounds
  const firstRound = rounds[0];
  const recentRounds = rounds.slice(-RECENT_ROUNDS_TO_KEEP);
  const middleRounds = rounds.slice(1, -RECENT_ROUNDS_TO_KEEP);

  // If no middle rounds, we can only return what we have
  if (middleRounds.length === 0) {
    return messages;
  }

  // Step 1: Compress middle assistant messages, keep user messages
  const compressedMiddle: Message[] = [];
  for (const round of middleRounds) {
    for (const msg of round) {
      if (msg.role === 'user') {
        compressedMiddle.push(msg);
      } else if (msg.role === 'assistant') {
        compressedMiddle.push(compressAssistantMessage(msg));
      }
    }
  }

  const result1 = [
    ...firstRound,
    ...compressedMiddle,
    ...recentRounds.flat(),
  ];

  const tokens1 = systemTokens + estimateMessageTokens(result1);
  if (tokens1 <= maxInputTokens) {
    return result1;
  }

  // Step 2: Drop middle entirely, keep first + recent
  const result2 = [
    ...firstRound,
    ...recentRounds.flat(),
  ];

  const tokens2 = systemTokens + estimateMessageTokens(result2);
  if (tokens2 <= maxInputTokens) {
    return result2;
  }

  // Step 3: Aggressive — keep first user message + last 2 rounds
  const lastTwoRounds = rounds.slice(-2);
  const firstUserMsg = messages.find((m) => m.role === 'user');
  const result3 = firstUserMsg
    ? [firstUserMsg, ...lastTwoRounds.flat()]
    : lastTwoRounds.flat();

  return result3;
}
