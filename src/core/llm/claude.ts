import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, ChatOptions, ToolChoice } from './adapter';
import { LLMError, classifyError, buildToolParseError } from './adapter';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import { getTauriFetch } from './tauriFetch';
import { normalizeMessages } from './messageNormalizer';
import type { PreparedTurn, PreparedToolCall } from './messageNormalizer';
import { createHeartbeat, anySignal, DEFAULT_STREAM_HANG_TIMEOUT_MS as STREAM_HANG_TIMEOUT_MS } from './heartbeat';
import { createLogger } from '../logging/logger';

const logger = createLogger('claude');

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

/**
 * Serialize a PreparedToolCall into an Anthropic tool_result content block.
 * Images are inlined as image content blocks (Anthropic supports images in tool_result).
 */
function serializeToolResult(tc: PreparedToolCall): Anthropic.ToolResultBlockParam {
  if (tc.resultImages.length > 0) {
    const contentBlocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [
      { type: 'text', text: tc.result },
      ...tc.resultImages.map((img) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: img.mediaType,
          data: img.data,
        },
      })),
    ];
    return {
      type: 'tool_result',
      tool_use_id: tc.id,
      content: contentBlocks,
      ...(tc.isError ? { is_error: true } : {}),
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: tc.id,
    content: tc.result,
    ...(tc.isError ? { is_error: true } : {}),
  };
}

/**
 * Serialize PreparedTurn[] into Anthropic MessageParam[].
 *
 * Thin serializer — all logic (orphan fix, ID gen, image extraction) is in normalizeMessages.
 */
function serializeForAnthropic(turns: PreparedTurn[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const turn of turns) {
    if (turn.kind === 'user') {
      const content: Anthropic.ContentBlockParam[] = turn.content.map((b) => {
        if (b.type === 'image') {
          return {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: b.mediaType, data: b.data },
          } as Anthropic.ContentBlockParam;
        }
        if (b.type === 'document') {
          return {
            type: 'document' as const,
            source: { type: 'base64' as const, media_type: b.mediaType, data: b.data },
          } as Anthropic.ContentBlockParam;
        }
        return { type: 'text' as const, text: b.text };
      });
      result.push({ role: 'user', content });
    } else {
      // Assistant turn
      const content: Anthropic.ContentBlockParam[] = [];

      if (turn.thinking) {
        content.push({ type: 'thinking', thinking: turn.thinking } as Anthropic.ContentBlockParam);
      }
      if (turn.text) {
        content.push({ type: 'text', text: turn.text });
      }

      if (turn.toolCalls.length > 0) {
        // tool_use blocks go into the assistant message
        for (const tc of turn.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        result.push({ role: 'assistant', content });

        // tool_result blocks go into the next user message
        // normalizeMessages guarantees every tool_use has a result
        const toolResultBlocks = turn.toolCalls.map(serializeToolResult);
        result.push({ role: 'user', content: toolResultBlocks });
      } else {
        result.push({ role: 'assistant', content: turn.text || '' });
      }
    }
  }

  return result;
}

/** Convert messages through normalize → serialize pipeline */
function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
  const turns = normalizeMessages(messages);
  return serializeForAnthropic(turns);
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

    // System prompt with per-section cache control
    if (options.systemPromptSections && options.systemPromptSections.length > 0) {
      // Use structured sections: cacheable sections get cache_control for prompt caching
      const systemBlocks: Anthropic.TextBlockParam[] = [];
      // Find the last cacheable section to place cache_control on it
      // (Anthropic caches everything up to the last cache_control marker)
      let lastCacheableIdx = -1;
      for (let i = options.systemPromptSections.length - 1; i >= 0; i--) {
        if (options.systemPromptSections[i].cacheable) {
          lastCacheableIdx = i;
          break;
        }
      }

      for (let i = 0; i < options.systemPromptSections.length; i++) {
        const section = options.systemPromptSections[i];
        const block: Anthropic.TextBlockParam = { type: 'text', text: section.text };
        // Place cache_control on the last cacheable section — Anthropic caches
        // the prefix up to this point, so all prior cacheable sections are cached too
        if (i === lastCacheableIdx) {
          (block as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
        }
        systemBlocks.push(block);
      }
      params.system = systemBlocks;
    } else if (options.systemPrompt) {
      // Fallback: single block with cache control (backward compatible)
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

    // Extended thinking — auto-enabled when model supports 'anthropic' thinking protocol
    if (options.enableThinking) {
      // Anthropic API requires temperature=1 when extended thinking is enabled
      params.temperature = 1;
      (params as unknown as Record<string, unknown>).thinking = {
        type: 'enabled',
        budget_tokens: options.thinkingBudget ?? 10000,
      };
    } else if (options.temperature !== undefined) {
      params.temperature = options.temperature;
    }

    if (options.topP !== undefined) {
      params.top_p = options.topP;
    }

    if (options.stopSequences && options.stopSequences.length > 0) {
      params.stop_sequences = options.stopSequences;
    }

    if (options.metadata?.userId) {
      params.metadata = { user_id: options.metadata.userId };
    }

    // Stream-level abort controller. The idle heartbeat emits events but cannot
    // make the SDK's `for await` (or the initial create()) return — chat() would
    // stay pending and the awaiting agent/subagent loop would hang forever.
    // Aborting this controller cancels the SDK request so the await unwinds.
    // Merge the caller's signal via AbortSignal.any so user cancels still apply.
    const streamAbort = new AbortController();
    const effectiveSignal = options.signal
      ? anySignal([options.signal, streamAbort.signal])
      : streamAbort.signal;
    const streamOptions = { signal: effectiveSignal };
    let hangTimedOut = false;

    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    let currentThinking = '';
    let isInThinkingBlock = false;

    // Idle timeout: if no data received within the window, treat as network hang
    // and abort so the pending stream rejects (emitting events alone left it hung).
    const heartbeat = createHeartbeat(STREAM_HANG_TIMEOUT_MS, () => {
      hangTimedOut = true;
      streamAbort.abort();
    });

    // Connect/header-phase timeout: the heartbeat is only reset once create()
    // resolves, so a server that never returns headers would hang create()
    // unbounded. Abort once the ceiling is hit.
    const connectTimer = setTimeout(() => {
      hangTimedOut = true;
      streamAbort.abort();
    }, STREAM_HANG_TIMEOUT_MS);

    try {
      const stream = await client.messages.create(params, streamOptions);
      clearTimeout(connectTimer);
      heartbeat.reset();

      for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
        heartbeat.reset();

        // Check for cancellation
        if (options.signal?.aborted) {
          heartbeat.clear();
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
                // A no-argument tool call streams no input_json_delta, leaving
                // currentToolInput empty — treat as {} (mirrors the OpenAI path's
                // safeParseToolArgs), don't let JSON.parse('') throw into a
                // spurious _parse_error + disk log.
                input = currentToolInput.trim() ? JSON.parse(currentToolInput) : {};
              } catch {
                input = buildToolParseError(
                  currentToolInput,
                  { source: 'claude/content_block_stop', tool: currentToolName },
                  logger,
                );
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
              heartbeat.clear();
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
      heartbeat.clear();
      onEvent({ type: 'done', stopReason: 'end_turn' });
    } catch (err) {
      heartbeat.clear();
      clearTimeout(connectTimer);
      // Hang-timeout abort surfaces as an AbortError too, but must be retryable —
      // distinguish it from a genuine user cancel (which leaves options.signal aborted).
      if (hangTimedOut) {
        throw new LLMError(`连接空闲超时：${STREAM_HANG_TIMEOUT_MS / 1000} 秒未收到任何数据`, 'network_error', { retryable: true });
      }
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
