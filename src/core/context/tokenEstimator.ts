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
 * Unrounded token weight for a string. Keeping the rounding boundary separate
 * lets callers partition one payload without rounding each section twice or
 * changing the aggregate estimate.
 */
export function estimateTextTokenWeight(text: string): number {
  if (!text) return 0;

  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkCount = text.length - cjkCount;

  // CJK: ~1.5 chars/token, Non-CJK: ~4 chars/token
  const cjkTokens = cjkCount / 1.5;
  const nonCjkTokens = nonCjkCount / 4;

  return (cjkTokens + nonCjkTokens) * getCalibrationRatio();
}

/**
 * Estimate token count for a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(estimateTextTokenWeight(text));
}

// Approximate tokens per image, deliberately provider-agnostic.
//
// Routes differ by more than an order of magnitude (DeepSeek caps an image at
// 384 tokens, Anthropic bills around 1600), and an earlier revision priced this
// per route. That was withdrawn: the only per-turn model identity available here
// is a module global, which concurrent conversations overwrite — and this number
// feeds the INPUT_TOO_LARGE refusal, so borrowing another conversation's route
// could under-count and let an oversized request through the guard that exists
// to stop it. Passing the route in explicitly (Codex's shape) would mean
// threading a parameter through ~20 call sites in two subsystems this change has
// no other business touching.
//
// So this stays a single conservative constant, which is also DSH's stance:
// provider-agnostic estimation does not guess vision pricing, and the usage the
// provider returns is the authoritative number. Over-counting only costs an
// earlier compaction; under-counting costs a failed request.
const TOKENS_PER_IMAGE = 1600;

function estimateToolResultContentTokens(content: ToolResultContent[] | undefined): number {
  if (!content) return 0;
  return content.reduce((total, block) => (
    block.type === 'image'
      ? total + TOKENS_PER_IMAGE
      : total + estimateTokens(block.text)
  ), 0);
}

/**
 * Count image blocks in message content
 */
function countImages(content: string | MessageContent[]): number {
  if (typeof content === 'string') return 0;
  return content.filter((c) => {
    if (c.type === 'image') return true;
    const maybeDelegated = c as unknown as {
      type?: unknown;
      attachment?: { mediaType?: unknown };
    };
    return maybeDelegated.type === 'delegated_media_ref'
      && typeof maybeDelegated.attachment?.mediaType === 'string'
      && maybeDelegated.attachment.mediaType.startsWith('image/');
  }).length;
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
