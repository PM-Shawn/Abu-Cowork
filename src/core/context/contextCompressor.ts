/**
 * Context Compressor — LLM-based semantic summarization
 *
 * When the conversation context approaches the context window limit,
 * uses a fast LLM call to generate a semantic summary of older messages
 * instead of hard-truncating them.
 *
 * Strategy:
 * 1. Check if context usage > threshold (default 75%)
 * 2. Identify older messages that can be summarized (keep first + recent)
 * 3. Call LLM to generate a concise summary
 * 4. Replace older messages with a single summary message
 * 5. Fall back to hard truncation if LLM summarization fails
 */

import type { Message } from '../../types';
import type { LLMAdapter } from '../llm/adapter';
import type { ChatOptions } from '../llm/adapter';
import { estimateTokens, estimateMessageTokens } from './tokenEstimator';
import { getMessageText, identifyRounds, RECENT_ROUNDS_TO_KEEP } from './contextUtils';

const COMPRESSION_THRESHOLD = 0.65; // Trigger at 65% — compress early to avoid context_too_long errors
const SUMMARY_MAX_TOKENS = 1024;

/** Configuration for context compression */
export interface CompressionConfig {
  adapter: LLMAdapter;
  model: string;
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

/** Result of compression attempt */
export interface CompressionResult {
  messages: Message[];
  compressed: boolean;
  savedTokens: number;
}

/**
 * Build a text representation of messages for the summarization prompt
 */
function messagesToText(messages: Message[]): string {
  return messages.map((msg) => {
    const role = msg.role === 'user' ? '用户' : '助手';
    const text = getMessageText(msg.content);
    const toolNames = msg.toolCalls?.map(tc => tc.name).join(', ');
    const toolResults = msg.toolCallsForContext?.map(tc =>
      `[${tc.name}: ${tc.result.slice(0, 100)}${tc.result.length > 100 ? '...' : ''}]`
    ).join(', ');

    let line = `${role}: ${text}`;
    if (toolNames) line += ` [调用工具: ${toolNames}]`;
    if (toolResults) line += ` [工具结果: ${toolResults}]`;
    return line;
  }).join('\n');
}

/**
 * Check if context needs compression and compress if needed.
 *
 * Returns compressed messages if compression was performed, or original messages if not needed.
 * Falls back gracefully on LLM errors — never blocks the agent loop.
 */
export async function compressContextIfNeeded(
  messages: Message[],
  systemPrompt: string,
  contextWindowSize: number,
  reserveForOutput: number,
  config: CompressionConfig
): Promise<CompressionResult> {
  const maxInputTokens = contextWindowSize - reserveForOutput;
  const systemTokens = estimateTokens(systemPrompt);
  const messageTokens = estimateMessageTokens(messages);
  const totalTokens = systemTokens + messageTokens;

  // Check if compression is needed
  if (totalTokens <= maxInputTokens * COMPRESSION_THRESHOLD) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  const rounds = identifyRounds(messages);
  if (rounds.length <= RECENT_ROUNDS_TO_KEEP + 1) {
    // Not enough rounds to compress
    return { messages, compressed: false, savedTokens: 0 };
  }

  // Split into: first round (task context) + middle (to summarize) + recent (to keep)
  const firstRound = rounds[0];
  const recentRounds = rounds.slice(-RECENT_ROUNDS_TO_KEEP);
  const middleRounds = rounds.slice(1, -RECENT_ROUNDS_TO_KEEP);

  if (middleRounds.length === 0) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  const middleMessages = middleRounds.flat();
  const middleTokens = estimateMessageTokens(middleMessages);

  // Only compress if middle messages are substantial enough to be worth it
  if (middleTokens < 500) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  try {
    // Generate summary using LLM
    const middleText = messagesToText(middleMessages);

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

    const summaryMessages: Message[] = [{
      id: 'compress-prompt',
      role: 'user',
      content: summaryPrompt,
      timestamp: Date.now(),
    }];

    let summaryText = '';
    const chatOptions: ChatOptions = {
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      maxTokens: SUMMARY_MAX_TOKENS,
      signal: config.signal,
    };

    await config.adapter.chat(summaryMessages, chatOptions, (event) => {
      if (event.type === 'text') {
        summaryText += event.text;
      }
    });

    if (!summaryText.trim()) {
      // LLM returned empty — fall back
      return { messages, compressed: false, savedTokens: 0 };
    }

    // Build compressed message array
    const summaryMessage: Message = {
      id: `context-summary-${Date.now().toString(36)}`,
      role: 'user',
      content: `[对话历史摘要]\n${summaryText.trim()}`,
      timestamp: middleMessages[0]?.timestamp ?? Date.now(),
    };

    const compressedMessages = [
      ...firstRound,
      summaryMessage,
      ...recentRounds.flat(),
    ];

    const compressedTokens = estimateMessageTokens(compressedMessages);
    const savedTokens = messageTokens - compressedTokens;

    return {
      messages: compressedMessages,
      compressed: true,
      savedTokens: Math.max(0, savedTokens),
    };
  } catch {
    // LLM call failed — fall back gracefully, don't block the agent
    return { messages, compressed: false, savedTokens: 0 };
  }
}
