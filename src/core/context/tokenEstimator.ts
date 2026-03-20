/**
 * Token Estimator — character-level token estimation
 *
 * Uses simple heuristics:
 * - English text: ~4 characters per token
 * - Chinese text: ~1.5 characters per token
 * - Mixed: weighted average based on character distribution
 */

import type { Message, MessageContent, ToolDefinition } from '../../types';
import { getMessageText } from './contextUtils';

// CJK Unicode ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;

/**
 * Calibration: ratio of actual API tokens to estimated tokens.
 * Updated after each LLM call to improve accuracy for subsequent estimates.
 * Uses exponential moving average to smooth out variance.
 */
let calibrationRatio = 1.0;
const CALIBRATION_ALPHA = 0.3; // Weight for new observation (0.3 = 30% new, 70% history)

/**
 * Update calibration ratio based on actual API usage.
 * Call this after each LLM call with the actual inputTokens from the API response.
 */
export function calibrateFromUsage(estimatedTokens: number, actualTokens: number): void {
  if (estimatedTokens <= 0 || actualTokens <= 0) return;
  const newRatio = actualTokens / estimatedTokens;
  // Exponential moving average
  calibrationRatio = CALIBRATION_ALPHA * newRatio + (1 - CALIBRATION_ALPHA) * calibrationRatio;
}

/**
 * Get the current calibration ratio.
 * Values > 1 mean estimates are too low, < 1 mean estimates are too high.
 */
export function getCalibrationRatio(): number {
  return calibrationRatio;
}

/**
 * Reset calibration (e.g., when switching providers).
 */
export function resetCalibration(): void {
  calibrationRatio = 1.0;
}

/**
 * Estimate token count for a string
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkCount = text.length - cjkCount;

  // CJK: ~1.5 chars/token, Non-CJK: ~4 chars/token
  const cjkTokens = cjkCount / 1.5;
  const nonCjkTokens = nonCjkCount / 4;

  return Math.ceil((cjkTokens + nonCjkTokens) * calibrationRatio);
}

// Approximate tokens per image (Anthropic vision: ~1600 tokens per image)
const TOKENS_PER_IMAGE = 1600;

/**
 * Count image blocks in message content
 */
function countImages(content: string | MessageContent[]): number {
  if (typeof content === 'string') return 0;
  return content.filter((c) => c.type === 'image').length;
}

/**
 * Estimate tokens for an array of messages (including tool calls)
 */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;

  for (const msg of messages) {
    // Message text content
    total += estimateTokens(getMessageText(msg.content));

    // Image content (~1600 tokens per image)
    total += countImages(msg.content) * TOKENS_PER_IMAGE;

    // Thinking content
    if (msg.thinking) {
      total += estimateTokens(msg.thinking);
    }

    // Tool calls
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(tc.name);
        total += estimateTokens(JSON.stringify(tc.input));
        if (tc.result) {
          total += estimateTokens(tc.result);
        }
      }
    }

    // Tool calls for context
    if (msg.toolCallsForContext) {
      for (const tc of msg.toolCallsForContext) {
        total += estimateTokens(tc.name);
        total += estimateTokens(JSON.stringify(tc.input));
        total += estimateTokens(tc.result);
      }
    }

    // Per-message overhead (role, structure)
    total += 4;
  }

  return total;
}

/**
 * Estimate tokens consumed by tool definitions (name + description + inputSchema).
 * These are included in every LLM API call and consume context window space.
 */
export function estimateToolSchemaTokens(tools: ToolDefinition[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokens(JSON.stringify(tool.inputSchema));
    total += 10; // per-tool structural overhead (XML/JSON framing)
  }
  return total;
}
