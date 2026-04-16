import type {
  Message,
  ToolCallForContext,
  ToolResultContent,
} from '../../../../src/types';
import type { LoggerAdapter } from '../ports/adapters/logger';
import type { ClockAdapter } from '../ports/adapters/clock';
import { TokenEstimator } from './tokenEstimator';
import {
  getMessageText,
  identifyRounds,
  RECENT_ROUNDS_TO_KEEP,
} from './contextUtils';

const ASSISTANT_SUMMARY_MAX_CHARS = 200;
const FIRST_ROUND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getMaxScreenshots(usagePercent?: number): number {
  if (usagePercent === undefined) return 3;
  if (usagePercent < 40) return 4;
  if (usagePercent < 60) return 3;
  return 2;
}

export interface ContextManagerDeps {
  estimator: TokenEstimator;
  logger: LoggerAdapter;
  clock: ClockAdapter;
}

/**
 * ContextManager —— 上下文窗口管理（硬截断 + 截图修剪）。
 *
 * 对比 Abu 原版改动：
 * - 原版通过 `createLogger('contextManager')` 取全局 logger；
 * - 原版 `Date.now()` 直接调系统时钟；
 * - 新版通过构造器注入 logger + clock + estimator。
 */
export class ContextManager {
  constructor(private readonly deps: ContextManagerDeps) {}

  trimOldScreenshots(messages: Message[], usagePercent?: number): Message[] {
    const maxScreenshots = getMaxScreenshots(usagePercent);
    const imageLocations: { msgIdx: number; tcIdx: number }[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.toolCalls) continue;
      for (let j = 0; j < msg.toolCalls.length; j++) {
        const tc = msg.toolCalls[j];
        if (
          tc.resultContent &&
          Array.isArray(tc.resultContent) &&
          tc.resultContent.some((b: ToolResultContent) => b.type === 'image')
        ) {
          imageLocations.push({ msgIdx: i, tcIdx: j });
        }
      }
    }

    if (imageLocations.length <= maxScreenshots) return messages;

    const toStrip = imageLocations.slice(0, -maxScreenshots);
    return messages.map((msg, i) => {
      const strippedTcIndices = toStrip
        .filter((loc) => loc.msgIdx === i)
        .map((loc) => loc.tcIdx);
      if (strippedTcIndices.length === 0) return msg;

      const newToolCalls = msg.toolCalls!.map((tc, j) => {
        if (!strippedTcIndices.includes(j)) return tc;
        const textParts =
          tc.resultContent?.filter((b: ToolResultContent) => b.type === 'text') || [];
        const imageCount =
          tc.resultContent?.filter((b: ToolResultContent) => b.type === 'image').length || 0;
        return {
          ...tc,
          resultContent: [
            ...textParts,
            {
              type: 'text' as const,
              text: `[${imageCount} screenshot(s) removed from history to save context]`,
            },
          ],
        };
      });

      const newToolCallsForContext = msg.toolCallsForContext?.map((tc, j) => {
        if (!strippedTcIndices.includes(j)) return tc;
        const textParts =
          tc.resultContent?.filter((b: ToolResultContent) => b.type === 'text') || [];
        return {
          ...tc,
          resultContent: [
            ...textParts,
            { type: 'text' as const, text: `[screenshot removed from history]` },
          ],
        };
      });

      return {
        ...msg,
        toolCalls: newToolCalls,
        toolCallsForContext: newToolCallsForContext || msg.toolCallsForContext,
      };
    });
  }

  prepareContextMessages(
    messages: Message[],
    systemPrompt: string,
    contextWindowSize: number,
    reserveForOutput: number,
    toolSchemaTokens?: number
  ): Message[] {
    const { estimator, logger, clock } = this.deps;
    const maxInputTokens = contextWindowSize - reserveForOutput;
    const systemTokens = estimator.estimateTokens(systemPrompt);

    const messageTokens = estimator.estimateMessageTokens(messages);
    const totalTokens = systemTokens + messageTokens + (toolSchemaTokens ?? 0);
    if (totalTokens <= maxInputTokens) return messages;

    const usagePercent = Math.round((totalTokens / maxInputTokens) * 100);
    logger.log('info', 'contextManager', 'Hard truncation needed', {
      systemTokens,
      messageTokens,
      toolSchemaTokens: toolSchemaTokens ?? 0,
      totalTokens,
      maxInputTokens,
      usagePercent,
    });

    const rounds = identifyRounds(messages);
    if (rounds.length <= 1) return messages;

    const firstRoundAge = clock.now() - (rounds[0]?.[0]?.timestamp ?? clock.now());
    const keepFirstRound = firstRoundAge < FIRST_ROUND_MAX_AGE_MS;

    const firstRound = keepFirstRound ? rounds[0] : [];
    const recentRounds = rounds.slice(-RECENT_ROUNDS_TO_KEEP);
    const middleStart = keepFirstRound ? 1 : 0;
    const middleRounds = rounds.slice(middleStart, rounds.length - RECENT_ROUNDS_TO_KEEP);

    if (middleRounds.length === 0) return messages;

    const compressedMiddle: Message[] = [];
    for (const round of middleRounds) {
      for (const msg of round) {
        if (msg.role === 'user') compressedMiddle.push(msg);
        else if (msg.role === 'assistant') compressedMiddle.push(this.compressAssistantMessage(msg));
      }
    }

    const result1 = [...firstRound, ...compressedMiddle, ...recentRounds.flat()];
    const tokens1 =
      systemTokens +
      (toolSchemaTokens ?? 0) +
      estimator.estimateMessageTokens(sanitizeToolPairs(result1));
    if (tokens1 <= maxInputTokens) return stripOldThinking(sanitizeToolPairs(result1));

    const result2 = [...firstRound, ...recentRounds.flat()];
    const tokens2 =
      systemTokens +
      (toolSchemaTokens ?? 0) +
      estimator.estimateMessageTokens(sanitizeToolPairs(result2));
    if (tokens2 <= maxInputTokens) return stripOldThinking(sanitizeToolPairs(result2));

    const lastTwoRounds = rounds.slice(-2);
    if (keepFirstRound) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
      if (firstUserMsg) {
        return stripOldThinking(sanitizeToolPairs([firstUserMsg, ...lastTwoRounds.flat()]));
      }
    }
    return stripOldThinking(sanitizeToolPairs(lastTwoRounds.flat()));
  }

  private compressAssistantMessage(msg: Message): Message {
    const text = getMessageText(msg.content);
    const truncatedText =
      text.length > ASSISTANT_SUMMARY_MAX_CHARS
        ? text.slice(0, ASSISTANT_SUMMARY_MAX_CHARS) + '...'
        : text;
    const toolSummary =
      msg.toolCallsForContext?.map((tc: ToolCallForContext) => `[${tc.name}]`).join(', ') ||
      msg.toolCalls?.map((tc) => `[${tc.name}]`).join(', ') ||
      '';
    const compressed = toolSummary ? `${toolSummary}\n${truncatedText}` : truncatedText;
    return {
      ...msg,
      content: compressed,
      thinking: undefined,
      toolCalls: undefined,
      toolCallsForContext: undefined,
    };
  }
}

function sanitizeToolPairs(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    const tc = msg.toolCallsForContext || msg.toolCalls;
    if (!tc || tc.length === 0) return msg;

    const allMissing = tc.every((t) => {
      const result = 'result' in t ? t.result : undefined;
      return result === undefined;
    });

    if (allMissing) {
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

function stripOldThinking(messages: Message[]): Message[] {
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
