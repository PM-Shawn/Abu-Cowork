/**
 * Token Estimator — character-level token estimation
 *
 * Uses simple heuristics:
 * - English text: ~4 characters per token
 * - Chinese text: ~1.5 characters per token
 * - Mixed: weighted average based on character distribution
 */

import type { Message, MessageContent, ToolDefinition, ToolResultContent } from '../../types';
import { getMessageText } from './contextUtils';
import { resolveImagePolicy } from '../llm/imagePolicy';

// CJK Unicode ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;

/**
 * Calibration: ratio of actual API tokens to estimated tokens.
 * Per-model storage — different models have different tokenizers (~15% variance).
 * Uses exponential moving average to smooth out variance.
 */
const calibrationRatios = new Map<string, number>();
const CALIBRATION_ALPHA = 0.3; // Weight for new observation (0.3 = 30% new, 70% history)
let activeModelId = '';

/**
 * Set the active model for calibration.
 * Call before estimating tokens for a specific LLM call.
 */
export function setActiveModel(modelId: string): void {
  activeModelId = modelId;
}

/**
 * Update calibration ratio based on actual API usage.
 * Call this after each LLM call with the actual inputTokens from the API response.
 */
export function calibrateFromUsage(estimatedTokens: number, actualTokens: number): void {
  if (estimatedTokens <= 0 || actualTokens <= 0) return;
  const key = activeModelId || '_default';
  const oldRatio = calibrationRatios.get(key) ?? 1.0;
  const newRatio = actualTokens / estimatedTokens;
  calibrationRatios.set(key, CALIBRATION_ALPHA * newRatio + (1 - CALIBRATION_ALPHA) * oldRatio);
}

/**
 * Get the current calibration ratio for the active model.
 * Values > 1 mean estimates are too low, < 1 mean estimates are too high.
 */
export function getCalibrationRatio(): number {
  return calibrationRatios.get(activeModelId || '_default') ?? 1.0;
}

/**
 * Reset calibration for a specific model, or all models if no ID given.
 */
export function resetCalibration(modelId?: string): void {
  if (modelId) {
    calibrationRatios.delete(modelId);
  } else {
    calibrationRatios.clear();
  }
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

  return Math.ceil((cjkTokens + nonCjkTokens) * getCalibrationRatio());
}

/**
 * Tokens to charge one image, for the route this turn is going to.
 *
 * Providers differ by more than an order of magnitude — DeepSeek caps an image
 * at 384 tokens, Anthropic bills around 1600 — and this number is not cosmetic:
 * it feeds the 65% auto-compaction trigger and the `INPUT_TOO_LARGE` refusal.
 * Charging 1600 for a 384-token image inflates the water level, so a session can
 * buy a *lossy* compaction (history summarised away, plus a full extra round
 * trip) it did not need, and on a small configured context window a batch of
 * screenshots can be refused before it is ever sent.
 *
 * Reads `activeModelId` rather than taking a parameter, matching how
 * `getCalibrationRatio` already resolves per-model state in this module — so
 * compaction and budget enforcement stay on one shared value instead of
 * disagreeing about what an image costs. Before `setActiveModel` runs,
 * `resolveImagePolicy('')` falls through to the conservative default, which is
 * the 1600 this file used unconditionally before.
 */
function tokensPerImage(): number {
  return resolveImagePolicy(activeModelId).tokensPerImage;
}

function estimateToolResultContentTokens(content: ToolResultContent[] | undefined): number {
  if (!content) return 0;
  return content.reduce((total, block) => (
    block.type === 'image'
      ? total + tokensPerImage()
      : total + estimateTokens(block.text)
  ), 0);
}

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

    // Image content, priced for the active route.
    total += countImages(msg.content) * tokensPerImage();

    // Thinking content
    if (msg.thinking) {
      total += estimateTokens(msg.thinking);
    }

    // Match the provider normalizer: toolCallsForContext is the canonical
    // send representation when present; toolCalls is the UI fallback. Counting
    // both would double-charge the same tool exchange and over-truncate history.
    const contextToolCalls = msg.toolCallsForContext ?? msg.toolCalls;
    if (contextToolCalls) {
      for (const tc of contextToolCalls) {
        total += estimateTokens(tc.name);
        total += estimateTokens(JSON.stringify(tc.input));
        if (tc.result) total += estimateTokens(tc.result);
        total += estimateToolResultContentTokens(tc.resultContent);
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
