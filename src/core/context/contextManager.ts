/**
 * Context Window Manager — the last check before a request is sent.
 *
 * Compaction (compactionService.ts) keeps a long task under the budget; this
 * gate only acts when what is about to be sent still does not fit. It cuts
 * by the same unit as compaction, the step (one assistant message with all of
 * its tool calls and results):
 * 1. Always keep the system prompt and every user message.
 * 2. Drop whole steps from the oldest, always keeping the newest step, and
 *    say in their place how many were dropped.
 * 3. Preserve every user and system message, cutting the newest step's
 *    fields to the length that fits.
 * 4. Keep the fixed messages alone when necessary; throw if they cannot fit.
 */

import type { Message, ToolResultContent } from '../../types';
import { estimateTokens, estimateMessageTokens } from './tokenEstimator';
import { getMessageText } from './contextUtils';
import { createLogger } from '../logging/logger';

const logger = createLogger('contextManager');

const ASSISTANT_SUMMARY_MAX_CHARS = 200;
const CONTEXT_SAFETY_MARGIN_RATIO = 0.02;
const CONTEXT_SAFETY_MARGIN_MAX_TOKENS = 4096;
const CONTEXT_TRUNCATION_MARKER = '[Content truncated to fit the context budget]';
const DROPPED_STEPS_ID = 'context-dropped-steps';

export type ContextBudgetStrategy =
  | 'unchanged'
  | 'dropped_steps'
  | 'latest_step_compacted'
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
      ? 'The fixed conversation messages'
      : 'The system prompt and tool definitions';
    super(`${code}: ${subject} requires an estimated ${estimatedTokens} input tokens, but the safe input budget is ${inputBudget}.`);
    this.name = 'ContextBudgetError';
    this.code = code;
    this.estimatedTokens = estimatedTokens;
    this.inputBudget = inputBudget;
  }
}

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
 *
 * Silent when the call had no images.
 */
function appendScreenshotRemovedNote(result: string | undefined, imageCount: number): string {
  if (imageCount <= 0) return result ?? '';
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
  // Collect all screenshot image locations (message index + tool_call id).
  // `toolCallsForContext` is completion-ordered, so its indices cannot be used.
  const imageLocations: { msgIdx: number; tcIdx: number; toolCallId: string }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;
    for (let j = 0; j < msg.toolCalls.length; j++) {
      const tc = msg.toolCalls[j];
      // Subagent-recorded entries never reach the LLM (no toolCallsForContext
      // counterpart), so they neither count against the screenshot budget nor
      // need stripping — and skipping them keeps the tcIdx↔toolCallsForContext
      // index sharing below aligned on real entries only.
      if (tc.fromSubagent) continue;
      if (tc.resultContent && Array.isArray(tc.resultContent) && tc.resultContent.some((b: ToolResultContent) => b.type === 'image')) {
        imageLocations.push({ msgIdx: i, tcIdx: j, toolCallId: tc.id });
      }
    }
  }

  if (imageLocations.length <= maxScreenshots) return messages;

  // Strip images from older screenshots, keep only the most recent N
  const toStrip = imageLocations.slice(0, -maxScreenshots);
  const result = messages.map((msg, i) => {
    const strippedToolCallIds = new Set(
      toStrip.filter(loc => loc.msgIdx === i).map(loc => loc.toolCallId),
    );
    const strippedTcIndices = new Set(
      toStrip.filter(loc => loc.msgIdx === i).map(loc => loc.tcIdx),
    );
    if (strippedTcIndices.size === 0) return msg;

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
      if (!strippedTcIndices.has(j)) return tc;
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
    // Old persisted entries predate tool_use ids. Do not risk trimming the
    // wrong completion-order call: retain every context image for this message.
    const hasToolUseId = (toolCall: { id?: string }) =>
      typeof toolCall.id === 'string' && toolCall.id.length > 0;
    const canMatchContextCalls = msg.toolCallsForContext
      && msg.toolCalls!.every(hasToolUseId)
      && msg.toolCallsForContext.every(hasToolUseId);
    const newToolCallsForContext = canMatchContextCalls
      ? msg.toolCallsForContext?.map((tc) => {
        if (!strippedToolCallIds.has(tc.id!)) return tc;
        const textParts = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'text') || [];
        const imageCount = tc.resultContent?.filter((b: ToolResultContent) => b.type === 'image').length || 0;
        return {
          ...tc,
          result: appendScreenshotRemovedNote(tc.result, imageCount),
          resultContent: textParts,
        };
      })
      : msg.toolCallsForContext;

    if (msg.toolCallsForContext && !canMatchContextCalls) {
      logger.info('Skipped trimming tool call context without tool_use ids', { messageId: msg.id });
    }

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
    const tc = (msg.toolCallsForContext || msg.toolCalls)?.filter(
      (toolCall) => !('fromSubagent' in toolCall && toolCall.fromSubagent),
    );
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

export function calculateSafetyMargin(rawInputBudget: number, contextWindowSize: number): number {
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

/** The newest user message that is the user's own words, else the newest user message. */
function latestUserMessage(messages: Message[]): Message | undefined {
  const users = messages.filter((message) => message.role === 'user');
  return [...users].reverse().find((message) => !message.isSystem) ?? users.at(-1);
}

/** Every message except the oldest `count` steps, with one note where they were. */
function withoutOldestSteps(messages: Message[], stepIndices: number[], count: number): Message[] {
  const dropped = new Set(stepIndices.slice(0, count));
  const result: Message[] = [];
  messages.forEach((message, index) => {
    if (index === stepIndices[0]) {
      result.push({
        id: DROPPED_STEPS_ID,
        role: 'user',
        content: `[${count} earlier step(s) were removed here to fit the context window]`,
        timestamp: message.timestamp,
        isSystem: true,
      });
    }
    if (!dropped.has(index)) result.push(message);
  });
  return result;
}

function fitLatestStepToBudget(
  messages: Message[],
  fixedTokens: number,
  inputBudget: number,
): { messages: Message[]; strategy: ContextBudgetStrategy } {
  const latestStep = [...messages].reverse().find((message) => message.role === 'assistant');
  const kept = messages.filter((message) => message.role !== 'assistant' || message === latestStep);
  const fixedMessages = kept.filter((message) => message !== latestStep);
  const fixedMessageTokens = fixedTokens + estimateMessageTokens(fixedMessages);
  if (fixedMessageTokens > inputBudget) {
    throw new ContextBudgetError('INPUT_TOO_LARGE', fixedMessageTokens, inputBudget);
  }

  const compactStep = (maxCharsPerField: number): Message[] => stripOldThinking(sanitizeToolPairs(
    kept.map((message) => (
      message === latestStep
        ? compactHistoricalMessage(message, maxCharsPerField)
        : message
    )),
  ));

  const maxChars = kept.reduce((largest, message) => {
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
    const candidate = compactStep(midpoint);
    const candidateTokens = fixedTokens + estimateMessageTokens(candidate);
    if (candidateTokens <= inputBudget) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  if (best) {
    return { messages: best, strategy: 'latest_step_compacted' };
  }

  return { messages: fixedMessages, strategy: 'latest_user_only' };
}

/** Input budget of a request: window minus output reserve minus a safety margin. */
export function computeInputBudget(
  contextWindowSize: number,
  reserveForOutput: number,
): { inputBudget: number; safetyMarginTokens: number } {
  const rawInputBudget = contextWindowSize - reserveForOutput;
  const safetyMarginTokens = calculateSafetyMargin(rawInputBudget, contextWindowSize);
  return { inputBudget: Math.max(0, rawInputBudget - safetyMarginTokens), safetyMarginTokens };
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
  const { inputBudget, safetyMarginTokens } = computeInputBudget(contextWindowSize, reserveForOutput);
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

  const result = (candidate: Message[], strategy: ContextBudgetStrategy): ContextBudgetResult => {
    const tokensAfter = fixedTokens + estimateMessageTokens(candidate);
    logger.info('Context budget enforced', {
      tokensBefore: totalTokens,
      tokensAfter,
      inputBudget,
      safetyMarginTokens,
      strategy,
    });
    return {
      messages: candidate,
      tokensBefore: totalTokens,
      tokensAfter,
      inputBudget,
      safetyMarginTokens,
      strategy,
    };
  };

  const latestUser = latestUserMessage(messages);
  if (!latestUser) {
    return result([], 'latest_user_only');
  }
  const latestUserTokens = fixedTokens + estimateMessageTokens([latestUser]);
  if (latestUserTokens > inputBudget) {
    throw new ContextBudgetError('INPUT_TOO_LARGE', latestUserTokens, inputBudget);
  }

  // Drop the fewest oldest steps that make it fit, never the newest step.
  const stepIndices = messages.flatMap((message, index) => (message.role === 'assistant' ? [index] : []));
  const fits = (count: number): Message[] | null => {
    const candidate = stripOldThinking(withoutOldestSteps(messages, stepIndices, count));
    return fixedTokens + estimateMessageTokens(candidate) <= inputBudget ? candidate : null;
  };
  let low = 1;
  let high = stepIndices.length - 1;
  let best: Message[] | null = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = fits(midpoint);
    if (candidate) {
      best = candidate;
      high = midpoint - 1;
    } else {
      low = midpoint + 1;
    }
  }
  if (best) {
    return result(best, 'dropped_steps');
  }

  const fitted = fitLatestStepToBudget(messages, fixedTokens, inputBudget);
  return result(fitted.messages, fitted.strategy);
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
