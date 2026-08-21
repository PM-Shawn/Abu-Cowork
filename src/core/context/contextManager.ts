/**
 * Context Window Manager — prevent context overflow
 *
 * Strategy:
 * 1. Always keep system prompt
 * 2. Keep the first user message while the normal compression tiers still fit
 * 3. Keep the most recent complete conversation rounds
 * 4. Older messages: keep user messages, compress assistant to summary
 * 5. Enforce a final hard invariant, preferring the latest user instruction
 *    when only one message can fit safely
 */

import type { Message, ToolCallForContext, ToolResultContent } from '../../types';
import { estimateTokens, estimateMessageTokens } from './tokenEstimator';
import { getMessageText, identifyRounds, RECENT_ROUNDS_TO_KEEP } from './contextUtils';
import { createLogger } from '../logging/logger';

const logger = createLogger('contextManager');

const ASSISTANT_SUMMARY_MAX_CHARS = 200;
const CONTEXT_SAFETY_MARGIN_RATIO = 0.02;
const CONTEXT_SAFETY_MARGIN_MAX_TOKENS = 4096;
const CONTEXT_TRUNCATION_MARKER = '[Content truncated to fit the context budget]';

export type ContextBudgetStrategy =
  | 'unchanged'
  | 'compressed_middle'
  | 'recent_rounds'
  | 'last_two_rounds'
  | 'last_round_compacted'
  | 'latest_user_only';

export interface ContextBudgetResult {
  messages: Message[];
  tokensBefore: number;
  tokensAfter: number;
  inputBudget: number;
  safetyMarginTokens: number;
  strategy: ContextBudgetStrategy;
}

export type ContextBudgetErrorCode =
  | 'INPUT_TOO_LARGE'
  | 'FIXED_CONTEXT_TOO_LARGE';

export class ContextBudgetError extends Error {
  readonly code: ContextBudgetErrorCode;
  readonly estimatedTokens: number;
  readonly inputBudget: number;

  constructor(
    code: ContextBudgetErrorCode,
    estimatedTokens: number,
    inputBudget: number,
  ) {
    const subject = code === 'INPUT_TOO_LARGE'
      ? 'The latest user input'
      : 'The system prompt and tool definitions';
    super(`${code}: ${subject} requires an estimated ${estimatedTokens} input tokens, but the safe input budget is ${inputBudget}.`);
    this.name = 'ContextBudgetError';
    this.code = code;
    this.estimatedTokens = estimatedTokens;
    this.inputBudget = inputBudget;
  }
}

/**
 * If the first round is older than this, treat it as stale and include it
 * in the compressible middle rounds instead of preserving it unconditionally.
 * This prevents very old "task context" from wasting tokens in long-lived
 * IM sessions where the original topic is no longer relevant.
 */
const FIRST_ROUND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Dynamic screenshot retention based on context usage.
 * When context is plentiful, keep more screenshots for better computer-use continuity.
 * When context is tight, keep fewer to leave room for messages.
 *
 * @param usagePercent - current context usage as 0-100 (optional, defaults to conservative)
 */
function getMaxScreenshots(usagePercent?: number): number {
  if (usagePercent === undefined) return 3;  // default: moderate
  if (usagePercent < 40) return 4;   // plenty of room
  if (usagePercent < 60) return 3;   // moderate
  return 2;                          // tight — aggressive trimming
}

/**
 * Tell the model, in the text it actually receives, that this tool call's
 * screenshots were dropped from history. Count comes from the recorded result,
 * so the same history always renders the same string.
 */
function appendScreenshotRemovedNote(result: string | undefined, imageCount: number): string {
  const note = `[${imageCount} screenshot(s) removed from history to save context]`;
  return result === undefined || result === '' ? note : `${result}\n\n${note}`;
}

/**
 * Strip old screenshot images from messages, keeping only the N most recent.
 * This prevents context overflow from accumulated screenshot base64 data.
 * Modifies messages in-place for efficiency (called before LLM send).
 *
 * @param usagePercent - optional context usage percent for dynamic retention
 */
export function trimOldScreenshots(messages: Message[], usagePercent?: number): Message[] {
  const maxScreenshots = getMaxScreenshots(usagePercent);
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

  if (imageLocations.length <= maxScreenshots) return messages;

  // Strip images from older screenshots, keep only the most recent N
  const toStrip = imageLocations.slice(0, -maxScreenshots);
  const result = messages.map((msg, i) => {
    const strippedTcIndices = toStrip.filter(loc => loc.msgIdx === i).map(loc => loc.tcIdx);
    if (strippedTcIndices.length === 0) return msg;

    // Clone message and strip images from old tool calls.
    //
    // The note goes on `result`, NOT into resultContent. normalizeMessages
    // builds the `tool` wire message from the `result` string and reads
    // resultContent only through extractImages, so a text block placed there
    // reaches nobody. That mattered here more than anywhere: computer-use
    // results carry "Examine the screenshot to verify the action result" in
    // their text, and that instruction survives untouched — so dropping the
    // image without a reachable note left the model told to inspect a picture
    // that was no longer in the request.
    //
    // Codex does the same thing structurally: its normalize pass swaps
    // InputImage for InputText **in place**, inside the content items that ARE
    // the wire, so the notice sits exactly where the picture was. (Where it
    // instead drops a whole message group, as compaction does, no note is
    // needed — nothing is left dangling.)
    const newToolCalls = msg.toolCalls!.map((tc, j) => {
      if (!strippedTcIndices.includes(j)) return tc;
      const textParts = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'text') || [];
      const imageCount = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'image').length || 0;
      return {
        ...tc,
        result: appendScreenshotRemovedNote(tc.result, imageCount),
        resultContent: textParts,
      };
    });

    // Also strip from toolCallsForContext if present — this is the canonical
    // send representation when set, so it is the one that must carry the note.
    const newToolCallsForContext = msg.toolCallsForContext?.map((tc, j) => {
      if (!strippedTcIndices.includes(j)) return tc;
      const textParts = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'text') || [];
      const imageCount = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'image').length || 0;
      return {
        ...tc,
        result: appendScreenshotRemovedNote(tc.result, imageCount),
        resultContent: textParts,
      };
    });

    return { ...msg, toolCalls: newToolCalls, toolCallsForContext: newToolCallsForContext || msg.toolCallsForContext };
  });

  return result;
}

/**
 * Ensure compressed/truncated messages don't produce orphaned tool_use blocks.
 *
 * After truncation, an assistant message with toolCalls might lose its
 * corresponding tool results (which live in the next user message) if the
 * next round is kept but the current round's context is broken.
 *
 * This function strips tool data from any assistant message whose tool
 * results are incomplete — the normalizer will handle the rest at send time.
 */
function sanitizeToolPairs(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    // If toolCalls exist but all results are missing, strip them
    // (they were likely orphaned by truncation)
    const tc = msg.toolCallsForContext || msg.toolCalls;
    if (!tc || tc.length === 0) return msg;

    const allMissing = tc.every((t) => {
      const result = 'result' in t ? t.result : undefined;
      return result === undefined;
    });

    if (allMissing) {
      // Convert to a compressed summary instead of leaving orphaned tool_use
      const toolNames = tc.map((t) => `[${t.name}]`).join(', ');
      const text = getMessageText(msg.content);
      const summary = text
        ? `${toolNames}\n${text.slice(0, ASSISTANT_SUMMARY_MAX_CHARS)}`
        : `${toolNames} [tool results lost during context compression]`;
      return {
        ...msg,
        content: summary,
        toolCalls: undefined,
        toolCallsForContext: undefined,
      };
    }
    return msg;
  });
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

function calculateSafetyMargin(rawInputBudget: number, contextWindowSize: number): number {
  if (rawInputBudget <= 0) return 0;
  return Math.min(
    Math.floor(rawInputBudget * 0.05),
    Math.max(1, Math.min(
      CONTEXT_SAFETY_MARGIN_MAX_TOKENS,
      Math.ceil(contextWindowSize * CONTEXT_SAFETY_MARGIN_RATIO),
    )),
  );
}

function truncateTextToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return CONTEXT_TRUNCATION_MARKER;
  return `${text.slice(0, maxChars)}\n${CONTEXT_TRUNCATION_MARKER}`;
}

function compactHistoricalMessage(message: Message, maxCharsPerField: number): Message {
  const content = typeof message.content === 'string'
    ? truncateTextToChars(message.content, maxCharsPerField)
    : [{
        type: 'text' as const,
        text: truncateTextToChars(getMessageText(message.content), maxCharsPerField),
      }];

  const compactInput = (input: Record<string, unknown>): Record<string, unknown> => (
    JSON.stringify(input).length <= maxCharsPerField
      ? input
      : { _contextTruncated: true }
  );
  const compactResultContent = (contentBlocks: ToolResultContent[] | undefined): ToolResultContent[] | undefined => {
    if (!contentBlocks) return undefined;
    const text = contentBlocks
      .filter((block): block is Extract<ToolResultContent, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return [{ type: 'text', text: truncateTextToChars(text, maxCharsPerField) }];
  };

  return {
    ...message,
    content,
    thinking: undefined,
    toolCalls: message.toolCalls?.map((toolCall) => ({
      ...toolCall,
      input: compactInput(toolCall.input),
      result: toolCall.result === undefined
        ? undefined
        : truncateTextToChars(toolCall.result, maxCharsPerField),
      resultContent: compactResultContent(toolCall.resultContent),
    })),
    toolCallsForContext: message.toolCallsForContext?.map((toolCall) => ({
      ...toolCall,
      input: compactInput(toolCall.input),
      result: truncateTextToChars(toolCall.result, maxCharsPerField),
      resultContent: compactResultContent(toolCall.resultContent),
    })),
  };
}

function fitLastRoundToBudget(
  messages: Message[],
  fixedTokens: number,
  inputBudget: number,
): { messages: Message[]; strategy: ContextBudgetStrategy } {
  const rounds = identifyRounds(messages);
  const lastRound = rounds.at(-1) ?? [];
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');

  if (!latestUser) {
    return { messages: [], strategy: 'latest_user_only' };
  }

  const latestUserTokens = fixedTokens + estimateMessageTokens([latestUser]);
  if (latestUserTokens > inputBudget) {
    throw new ContextBudgetError('INPUT_TOO_LARGE', latestUserTokens, inputBudget);
  }

  const compactRound = (maxCharsPerField: number): Message[] => stripOldThinking(sanitizeToolPairs(
    lastRound.map((message) => (
      message === latestUser
        ? message
        : compactHistoricalMessage(message, maxCharsPerField)
    )),
  ));

  const maxChars = lastRound.reduce((largest, message) => {
    const candidates = [getMessageText(message.content).length, message.thinking?.length ?? 0];
    for (const toolCall of message.toolCalls ?? []) {
      candidates.push(
        JSON.stringify(toolCall.input).length,
        toolCall.result?.length ?? 0,
        toolCall.resultContent
          ?.filter((block) => block.type === 'text')
          .reduce((total, block) => total + block.text.length, 0) ?? 0,
      );
    }
    for (const toolCall of message.toolCallsForContext ?? []) {
      candidates.push(
        JSON.stringify(toolCall.input).length,
        toolCall.result.length,
        toolCall.resultContent
          ?.filter((block) => block.type === 'text')
          .reduce((total, block) => total + block.text.length, 0) ?? 0,
      );
    }
    return Math.max(largest, ...candidates);
  }, 0);

  let low = 0;
  let high = maxChars;
  let best: Message[] | null = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactRound(midpoint);
    const candidateTokens = fixedTokens + estimateMessageTokens(candidate);
    if (candidateTokens <= inputBudget) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  if (best) {
    return { messages: best, strategy: 'last_round_compacted' };
  }

  return { messages: [latestUser], strategy: 'latest_user_only' };
}

/**
 * Prepare messages for LLM call, fitting within context window limit
 *
 * @param messages Full conversation messages
 * @param systemPrompt The system prompt text
 * @param contextWindowSize Total context window size (tokens)
 * @param reserveForOutput Tokens to reserve for model output
 * @returns Trimmed messages plus the measured safe-budget result
 */
export function enforceContextBudget(
  messages: Message[],
  systemPrompt: string,
  contextWindowSize: number,
  reserveForOutput: number,
  toolSchemaTokens?: number
): ContextBudgetResult {
  const rawInputBudget = contextWindowSize - reserveForOutput;
  const safetyMarginTokens = calculateSafetyMargin(rawInputBudget, contextWindowSize);
  const inputBudget = Math.max(0, rawInputBudget - safetyMarginTokens);
  const systemTokens = estimateTokens(systemPrompt);
  const fixedTokens = systemTokens + (toolSchemaTokens ?? 0);

  if (fixedTokens > inputBudget) {
    throw new ContextBudgetError('FIXED_CONTEXT_TOO_LARGE', fixedTokens, inputBudget);
  }

  // Fast path: everything fits
  const messageTokens = estimateMessageTokens(messages);
  const totalTokens = fixedTokens + messageTokens;
  if (totalTokens <= inputBudget) {
    return {
      messages,
      tokensBefore: totalTokens,
      tokensAfter: totalTokens,
      inputBudget,
      safetyMarginTokens,
      strategy: 'unchanged',
    };
  }

  const usagePercent = inputBudget > 0
    ? Math.round((totalTokens / inputBudget) * 100)
    : 100;
  logger.info('Hard truncation needed', {
    systemTokens,
    messageTokens,
    toolSchemaTokens: toolSchemaTokens ?? 0,
    totalTokens,
    inputBudget,
    safetyMarginTokens,
    usagePercent,
  });

  const rounds = identifyRounds(messages);

  const finalize = (
    candidate: Message[],
    strategy: ContextBudgetStrategy,
  ): ContextBudgetResult => {
    const sanitized = stripOldThinking(sanitizeToolPairs(candidate));
    const candidateTokens = fixedTokens + estimateMessageTokens(sanitized);
    if (candidateTokens <= inputBudget) {
      return {
        messages: sanitized,
        tokensBefore: totalTokens,
        tokensAfter: candidateTokens,
        inputBudget,
        safetyMarginTokens,
        strategy,
      };
    }

    const fitted = fitLastRoundToBudget(messages, fixedTokens, inputBudget);
    const fittedTokens = fixedTokens + estimateMessageTokens(fitted.messages);
    logger.info('Context budget enforced', {
      tokensBefore: totalTokens,
      tokensAfter: fittedTokens,
      inputBudget,
      safetyMarginTokens,
      strategy: fitted.strategy,
    });
    return {
      messages: fitted.messages,
      tokensBefore: totalTokens,
      tokensAfter: fittedTokens,
      inputBudget,
      safetyMarginTokens,
      strategy: fitted.strategy,
    };
  };

  if (rounds.length <= 1) {
    return finalize(messages, 'last_round_compacted');
  }

  // Keep first round only if it's recent enough to be relevant context.
  // In long-lived IM sessions, the first round from weeks ago is stale noise.
  const firstRoundAge = Date.now() - (rounds[0]?.[0]?.timestamp ?? Date.now());
  const keepFirstRound = firstRoundAge < FIRST_ROUND_MAX_AGE_MS;

  const firstRound = keepFirstRound ? rounds[0] : [];
  const recentRounds = rounds.slice(-RECENT_ROUNDS_TO_KEEP);
  const middleStart = keepFirstRound ? 1 : 0;
  const middleRounds = rounds.slice(middleStart, rounds.length - RECENT_ROUNDS_TO_KEEP);

  // If no middle rounds, we can only return what we have
  if (middleRounds.length === 0) {
    return finalize(messages, 'recent_rounds');
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

  const tokens1 = systemTokens + (toolSchemaTokens ?? 0) + estimateMessageTokens(sanitizeToolPairs(result1));
  if (tokens1 <= inputBudget) {
    return finalize(result1, 'compressed_middle');
  }

  // Step 2: Drop middle entirely, keep first + recent
  const result2 = [
    ...firstRound,
    ...recentRounds.flat(),
  ];

  const tokens2 = systemTokens + (toolSchemaTokens ?? 0) + estimateMessageTokens(sanitizeToolPairs(result2));
  if (tokens2 <= inputBudget) {
    return finalize(result2, 'recent_rounds');
  }

  // Step 3: Aggressive — keep first user message (if recent) + last 2 rounds
  const lastTwoRounds = rounds.slice(-2);
  if (keepFirstRound) {
    const firstUserMsg = messages.find((m) => m.role === 'user');
    if (firstUserMsg) {
      return finalize([firstUserMsg, ...lastTwoRounds.flat()], 'last_two_rounds');
    }
  }
  return finalize(lastTwoRounds.flat(), 'last_two_rounds');
}

export function prepareContextMessages(
  messages: Message[],
  systemPrompt: string,
  contextWindowSize: number,
  reserveForOutput: number,
  toolSchemaTokens?: number,
): Message[] {
  return enforceContextBudget(
    messages,
    systemPrompt,
    contextWindowSize,
    reserveForOutput,
    toolSchemaTokens,
  ).messages;
}

/**
 * Strip thinking content from all but the most recent assistant message.
 * Thinking blocks are valuable for the current turn but waste 10-50% of
 * context when accumulated across many turns.
 */
function stripOldThinking(messages: Message[]): Message[] {
  // Find the last assistant message with thinking
  let lastThinkingIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].thinking) {
      lastThinkingIdx = i;
      break;
    }
  }
  if (lastThinkingIdx === -1) return messages;

  return messages.map((msg, i) => {
    if (i < lastThinkingIdx && msg.role === 'assistant' && msg.thinking) {
      return { ...msg, thinking: undefined };
    }
    return msg;
  });
}
