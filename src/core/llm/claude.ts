import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, ChatOptions, ToolChoice } from './adapter';
import { LLMError, classifyError } from './adapter';
import type { Message, StreamEvent, ToolDefinition, MessageContent } from '../../types';
import { getTauriFetch } from './tauriFetch';

function convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

// Convert tool choice to Anthropic format
function convertToolChoice(choice: ToolChoice | undefined): Anthropic.MessageCreateParams['tool_choice'] {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' };
    case 'any':
      return { type: 'any' };
    case 'tool':
      return { type: 'tool', name: choice.name };
  }
}

// Helper to get text content from Message
function getTextContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  const textBlock = content.find((c) => c.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
}

// Convert Message content to Anthropic content blocks
function convertContentToBlocks(content: string | MessageContent[]): Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content.map((c) => {
    switch (c.type) {
      case 'text':
        return { type: 'text' as const, text: c.text };
      case 'image':
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: c.source.media_type,
            data: c.source.data,
          },
        };
      case 'document':
        return {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: c.source.media_type,
            data: c.source.data,
          },
        };
      default:
        return { type: 'text' as const, text: JSON.stringify(c) };
    }
  });
}

function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      // Support multimodal user messages
      const content = typeof msg.content === 'string'
        ? msg.content
        : convertContentToBlocks(msg.content);
      result.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];

      // Add thinking block if present
      if (msg.thinking) {
        content.push({ type: 'thinking', thinking: msg.thinking } as Anthropic.ContentBlockParam);
      }

      const textContent = getTextContent(msg.content);
      if (textContent) {
        content.push({ type: 'text', text: textContent });
      }

      // Prefer toolCallsForContext over toolCalls for LLM history
      const toolCallsSource = msg.toolCallsForContext || msg.toolCalls;

      if (toolCallsSource && toolCallsSource.length > 0) {
        // Build tool_use blocks
        const toolUseBlocks: Anthropic.ToolUseBlockParam[] = [];
        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

        for (const tc of toolCallsSource) {
          // Generate ID if using toolCallsForContext (which doesn't have id)
          const toolId = 'id' in tc ? tc.id : `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          toolUseBlocks.push({
            type: 'tool_use',
            id: toolId,
            name: tc.name,
            input: tc.input,
          });

          // Add tool result if available — use rich content (images) when present
          const result = 'result' in tc ? tc.result : undefined;
          const resultContent = 'resultContent' in tc ? tc.resultContent : undefined;
          const isError = 'isError' in tc ? tc.isError : undefined;
          if (result !== undefined) {
            if (resultContent && Array.isArray(resultContent)) {
              // Rich content: convert to Anthropic content blocks
              const contentBlocks = resultContent.map((block) => {
                if (block.type === 'image') {
                  return {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                      data: block.source.data,
                    },
                  };
                }
                return { type: 'text' as const, text: block.text };
              });
              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolId,
                content: contentBlocks,
                ...(isError ? { is_error: true } : {}),
              });
            } else {
              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolId,
                content: result,
                ...(isError ? { is_error: true } : {}),
              });
            }
          }
        }

        // Add tool_use blocks to assistant content
        content.push(...toolUseBlocks);
        result.push({ role: 'assistant', content });

        // Add tool results as the next user message
        if (toolResultBlocks.length > 0) {
          result.push({ role: 'user', content: toolResultBlocks });
        }
      } else {
        result.push({ role: 'assistant', content: textContent });
      }
    }
  }

  return result;
}

export class ClaudeAdapter implements LLMAdapter {
  async chat(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void
  ): Promise<void> {
    const fetchFn = await getTauriFetch();
    const clientOptions: Record<string, unknown> = {
      apiKey: options.apiKey,
      dangerouslyAllowBrowser: true,
      fetch: fetchFn,
    };
    if (options.baseUrl) {
      clientOptions.baseURL = options.baseUrl;
    }
    const client = new Anthropic(clientOptions as ConstructorParameters<typeof Anthropic>[0]);

    const params: Anthropic.MessageCreateParams = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: convertMessages(messages),
      stream: true,
    };

    // System prompt with cache control
    if (options.systemPrompt) {
      params.system = [
        {
          type: 'text',
          text: options.systemPrompt,
          cache_control: { type: 'ephemeral' },
        } as Anthropic.TextBlockParam,
      ];
    }

    // Tools configuration with cache control
    if (options.tools && options.tools.length > 0) {
      const tools = convertTools(options.tools);
      // Add cache_control to the last tool for efficient caching
      if (tools.length > 0) {
        (tools[tools.length - 1] as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
      }
      params.tools = tools;
      // Tool choice
      const toolChoice = convertToolChoice(options.toolChoice);
      if (toolChoice) {
        params.tool_choice = toolChoice;
      }
    }

    // Inject built-in web search if configured (Anthropic format)
    // Note: Anthropic built-in tools (e.g. web_search_20250305) have a different shape than
    // user-defined Anthropic.Tool — they lack input_schema. The double cast is intentional.
    if (options.builtinWebSearch) {
      const method = options.builtinWebSearch;
      if (method.type === 'tool') {
        const existingTools = params.tools ?? [];
        params.tools = [...existingTools, method.toolSpec as unknown as Anthropic.Tool];
      }
    }

    // Temperature and sampling
    if (options.temperature !== undefined) {
      params.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      params.top_p = options.topP;
    }

    // Stop sequences
    if (options.stopSequences && options.stopSequences.length > 0) {
      params.stop_sequences = options.stopSequences;
    }

    // Metadata for tracking
    if (options.metadata?.userId) {
      params.metadata = { user_id: options.metadata.userId };
    }

    // Extended thinking — enableThinking is already gated by modelCapabilities in agentLoop
    if (options.enableThinking) {
      (params as unknown as Record<string, unknown>).thinking = {
        type: 'enabled',
        budget_tokens: options.thinkingBudget ?? 10000,
      };
    }

    // Create stream with abort signal support
    const streamOptions = options.signal ? { signal: options.signal } : {};

    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    let currentThinking = '';
    let isInThinkingBlock = false;

    // Heartbeat timeout: if no data received for 30s, treat as network hang
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    const HEARTBEAT_TIMEOUT_MS = 30000;
    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        onEvent({ type: 'error', error: 'Stream heartbeat timeout: no data received for 30s' });
        onEvent({ type: 'done', stopReason: 'end_turn' });
      }, HEARTBEAT_TIMEOUT_MS);
    };

    try {
      const stream = await client.messages.create(params, streamOptions);
      resetHeartbeat();

      for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
        resetHeartbeat();

        // Check for cancellation
        if (options.signal?.aborted) {
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          onEvent({ type: 'done', stopReason: 'cancelled' });
          return;
        }

        switch (event.type) {
          case 'message_start':
            // Emit initial usage if available (including cache info)
            if (event.message.usage) {
              const usage = event.message.usage as unknown as Record<string, number>;
              onEvent({
                type: 'usage',
                usage: {
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  cacheCreationInputTokens: usage.cache_creation_input_tokens,
                  cacheReadInputTokens: usage.cache_read_input_tokens,
                },
              });
            }
            break;

          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              currentToolId = event.content_block.id;
              currentToolName = event.content_block.name;
              currentToolInput = '';
            } else if (event.content_block.type === 'thinking') {
              isInThinkingBlock = true;
              currentThinking = '';
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              onEvent({ type: 'text', text: event.delta.text });
            } else if (event.delta.type === 'input_json_delta') {
              currentToolInput += event.delta.partial_json;
            } else if (event.delta.type === 'thinking_delta') {
              currentThinking += (event.delta as { thinking: string }).thinking;
            }
            break;

          case 'content_block_stop':
            if (currentToolName) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(currentToolInput);
              } catch {
                input = { _parse_error: `Failed to parse tool input: ${currentToolInput.slice(0, 200)}` };
              }
              onEvent({
                type: 'tool_use',
                id: currentToolId,
                name: currentToolName,
                input,
              });
              currentToolName = '';
              currentToolId = '';
              currentToolInput = '';
            }
            if (isInThinkingBlock && currentThinking) {
              onEvent({ type: 'thinking', thinking: currentThinking });
              isInThinkingBlock = false;
              currentThinking = '';
            }
            break;

          case 'message_stop':
            break;

          case 'message_delta':
            if ('stop_reason' in event.delta) {
              if (heartbeatTimer) clearTimeout(heartbeatTimer);
              const usage = event.usage ? {
                inputTokens: event.usage.input_tokens ?? 0,
                outputTokens: event.usage.output_tokens,
              } : undefined;
              onEvent({ type: 'done', stopReason: event.delta.stop_reason ?? 'end_turn', usage });
              return;
            }
            break;
        }
      }

      // Fallback: stream ended without message_delta stop_reason (e.g. connection dropped)
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      onEvent({ type: 'done', stopReason: 'end_turn' });
    } catch (err) {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      // Handle abort errors gracefully
      if (err instanceof Error && err.name === 'AbortError') {
        onEvent({ type: 'done', stopReason: 'cancelled' });
        return;
      }
      // Already classified
      if (err instanceof LLMError) throw err;
      // Classify Anthropic SDK errors
      if (err instanceof Anthropic.APIError) {
        throw classifyError(err.status, err.message);
      }
      // Network errors
      if (err instanceof TypeError && err.message.includes('fetch')) {
        throw new LLMError(err.message, 'network_error', { retryable: true, retryAfterMs: 2000 });
      }
      throw err;
    }
  }
}
