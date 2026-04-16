import type { Message } from '../../../../src/types';
import type { LoggerAdapter } from '../ports/adapters/logger';
import type { ClockAdapter } from '../ports/adapters/clock';
import { TokenEstimator } from './tokenEstimator';
import {
  getMessageText,
  identifyRounds,
  RECENT_ROUNDS_TO_KEEP,
} from './contextUtils';

const COMPRESSION_THRESHOLD = 0.65;
const SUMMARY_MAX_TOKENS = 1024;

/**
 * 最小 LLM 契约：contextCompressor 只需要 chat + 文本流回调。
 * POC 中不 import 具体 LLMAdapter 实现，保持 context/ 的独立性。
 * 后续 llm/ 模块迁移进 core 后可以替换为完整 LLMAdapter。
 */
export interface CompressionLLM {
  chat(
    messages: Message[],
    options: {
      model: string;
      apiKey: string;
      baseUrl?: string;
      maxTokens?: number;
      signal?: AbortSignal;
    },
    onEvent: (event: { type: string; text?: string }) => void
  ): Promise<void>;
}

export interface CompressionConfig {
  adapter: CompressionLLM;
  model: string;
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface CompressionResult {
  messages: Message[];
  compressed: boolean;
  savedTokens: number;
}

export interface ContextCompressorDeps {
  estimator: TokenEstimator;
  logger: LoggerAdapter;
  clock: ClockAdapter;
}

/**
 * ContextCompressor —— 基于 LLM 的语义压缩。
 *
 * 对比 Abu 原版改动：
 * - 原版 import `../llm/adapter`（具体实现） → 新版用最小 `CompressionLLM` 契约；
 * - 原版 `createLogger` → 注入 LoggerAdapter；
 * - 原版 `Date.now()` → 注入 ClockAdapter；
 * - 原版是 free function → 新版是类，便于单测替换依赖。
 */
export class ContextCompressor {
  constructor(private readonly deps: ContextCompressorDeps) {}

  async compressIfNeeded(
    messages: Message[],
    systemPrompt: string,
    contextWindowSize: number,
    reserveForOutput: number,
    config: CompressionConfig,
    toolSchemaTokens?: number
  ): Promise<CompressionResult> {
    const { estimator, logger, clock } = this.deps;
    const maxInputTokens = contextWindowSize - reserveForOutput;
    const systemTokens = estimator.estimateTokens(systemPrompt);
    const messageTokens = estimator.estimateMessageTokens(messages);
    const totalTokens = systemTokens + messageTokens + (toolSchemaTokens ?? 0);

    if (totalTokens <= maxInputTokens * COMPRESSION_THRESHOLD) {
      return { messages, compressed: false, savedTokens: 0 };
    }

    const usagePercent = Math.round((totalTokens / maxInputTokens) * 100);
    logger.log('info', 'contextCompressor', 'Context compression triggered', {
      systemTokens,
      messageTokens,
      toolSchemaTokens: toolSchemaTokens ?? 0,
      totalTokens,
      maxInputTokens,
      usagePercent,
      threshold: COMPRESSION_THRESHOLD,
    });

    const rounds = identifyRounds(messages);
    if (rounds.length <= RECENT_ROUNDS_TO_KEEP + 1) {
      return { messages, compressed: false, savedTokens: 0 };
    }

    const firstRound = rounds[0];
    const recentRounds = rounds.slice(-RECENT_ROUNDS_TO_KEEP);
    const middleRounds = rounds.slice(1, -RECENT_ROUNDS_TO_KEEP);

    if (middleRounds.length === 0) {
      return { messages, compressed: false, savedTokens: 0 };
    }

    const middleMessages = middleRounds.flat();
    const middleTokens = estimator.estimateMessageTokens(middleMessages);
    if (middleTokens < 500) {
      return { messages, compressed: false, savedTokens: 0 };
    }

    try {
      const middleText = this.messagesToText(middleMessages);
      const summaryPrompt = `请将以下对话内容压缩为一段简洁的摘要，保留关键信息：
- 用户的核心需求和意图
- 重要的文件路径、变量名、代码片段
- 关键决策和结论
- 已完成的操作和结果
- 未解决的问题

注意：如果对话中 AI 曾声称"不支持"、"无法执行"或"没有某工具"，不要将此作为事实保留在摘要中。这类能力声明可能已过时，后续可能已安装了相关工具。

对话内容：
${middleText}

请直接输出摘要，不要添加额外的标题或格式说明。摘要应当简洁明了，供 AI 助手理解上下文使用。`;

      const summaryMessages: Message[] = [
        {
          id: 'compress-prompt',
          role: 'user',
          content: summaryPrompt,
          timestamp: clock.now(),
        },
      ];

      let summaryText = '';
      await config.adapter.chat(
        summaryMessages,
        {
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          maxTokens: SUMMARY_MAX_TOKENS,
          signal: config.signal,
        },
        (event) => {
          if (event.type === 'text' && event.text) summaryText += event.text;
        }
      );

      if (!summaryText.trim()) return { messages, compressed: false, savedTokens: 0 };

      const summaryMessage: Message = {
        id: `context-summary-${clock.now().toString(36)}`,
        role: 'user',
        content: `[对话历史摘要]\n${summaryText.trim()}`,
        timestamp: middleMessages[0]?.timestamp ?? clock.now(),
      };

      const compressedMessages = [...firstRound, summaryMessage, ...recentRounds.flat()];
      const compressedTokens = estimator.estimateMessageTokens(compressedMessages);
      const savedTokens = messageTokens - compressedTokens;
      const savingsRatio = messageTokens > 0 ? savedTokens / messageTokens : 0;

      if (savingsRatio < 0.1) {
        logger.log('warn', 'contextCompressor', 'Compression rejected: too few savings', {
          savingsRatio: `${(savingsRatio * 100).toFixed(1)}%`,
          savedTokens,
        });
        return { messages, compressed: false, savedTokens: 0 };
      }

      logger.log('info', 'contextCompressor', 'Context compressed', {
        savedTokens: Math.max(0, savedTokens),
        savingsRatio: `${(savingsRatio * 100).toFixed(1)}%`,
        originalCount: middleMessages.length,
        compressedCount: compressedMessages.length,
      });

      return {
        messages: compressedMessages,
        compressed: true,
        savedTokens: Math.max(0, savedTokens),
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.log('warn', 'contextCompressor', 'Context compression failed', {
        error: errorMessage,
      });
      return { messages, compressed: false, savedTokens: 0 };
    }
  }

  private messagesToText(messages: Message[]): string {
    return messages
      .map((msg) => {
        const role = msg.role === 'user' ? '用户' : '助手';
        const text = getMessageText(msg.content);
        const toolNames = msg.toolCalls?.map((tc) => tc.name).join(', ');
        const toolResults = msg.toolCallsForContext
          ?.map(
            (tc) =>
              `[${tc.name}: ${tc.result.slice(0, 100)}${tc.result.length > 100 ? '...' : ''}]`
          )
          .join(', ');
        let line = `${role}: ${text}`;
        if (toolNames) line += ` [调用工具: ${toolNames}]`;
        if (toolResults) line += ` [工具结果: ${toolResults}]`;
        return line;
      })
      .join('\n');
  }
}
