import type { LLMAdapter, ChatOptions } from './adapter';
import { classifyError } from './adapter';
import type { Message, StreamEvent, ToolDefinition, MessageContent } from '../../types';
import { getTauriFetch } from './tauriFetch';

// OpenAI multimodal content part
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  // DeepSeek R1 requires reasoning_content on assistant messages in multi-turn
  reasoning_content?: string | null;
}

// Helper to get text content from Message
function getTextContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  const textBlock = content.find((c) => c.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
}

function convertTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function convertMessages(messages: Message[], systemPrompt?: string, supportsVision?: boolean): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      // Support multimodal user messages (images)
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        const hasImages = msg.content.some((c) => c.type === 'image');
        if (hasImages && supportsVision !== false) {
          // Convert to OpenAI multimodal format (vision-capable models)
          const parts: OpenAIContentPart[] = [];
          let hasText = false;
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text });
              hasText = true;
            } else if (block.type === 'image') {
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
              });
            }
          }
          // Some providers require at least one text part alongside images
          if (!hasText) {
            parts.unshift({ type: 'text', text: ' ' });
          }
          result.push({ role: 'user', content: parts });
        } else {
          // Non-vision models: strip images, keep text only
          const text = getTextContent(msg.content);
          const imageCount = msg.content.filter((c) => c.type === 'image').length;
          const hint = imageCount > 0
            ? `${text}\n\n[用户上传了${imageCount}张图片，当前模型不支持图片理解]`
            : text;
          result.push({ role: 'user', content: hint });
        }
      }
    } else if (msg.role === 'assistant') {
      const textContent = getTextContent(msg.content);

      // Prefer toolCallsForContext over toolCalls for LLM history
      const toolCallsSource = msg.toolCallsForContext || msg.toolCalls;

      if (toolCallsSource && toolCallsSource.length > 0) {
        // Build tool calls array
        const toolCalls = toolCallsSource.map((tc, index) => {
          // Generate ID if using toolCallsForContext (which doesn't have id)
          const toolId = 'id' in tc ? tc.id : `call_${Date.now()}_${index}`;
          return {
            id: toolId,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          };
        });

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls,
        };
        // Preserve reasoning_content for reasoning models (DeepSeek R1 etc.)
        if (msg.thinking) {
          assistantMsg.reasoning_content = msg.thinking;
        }
        result.push(assistantMsg);

        // Add tool results — inject images as user messages for OpenAI APIs
        // OpenAI Chat Completions spec only supports images in role:"user" messages,
        // NOT in role:"tool" messages. Images in tool messages are silently dropped.
        const pendingImages: OpenAIContentPart[] = [];
        for (let i = 0; i < toolCallsSource.length; i++) {
          const tc = toolCallsSource[i];
          const resultText = 'result' in tc ? tc.result : undefined;
          const resultContent = 'resultContent' in tc ? tc.resultContent : undefined;
          if (resultText !== undefined) {
            if (resultContent && Array.isArray(resultContent) && resultContent.some(b => b.type === 'image') && supportsVision !== false) {
              // Extract text-only parts for the tool message
              const textParts = resultContent.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('\n');
              result.push({
                role: 'tool',
                tool_call_id: toolCalls[i].id,
                content: textParts || resultText,
              });
              // Collect images for a follow-up user message
              for (const block of resultContent) {
                if (block.type === 'image') {
                  pendingImages.push({
                    type: 'image_url' as const,
                    image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
                  });
                }
              }
            } else {
              result.push({
                role: 'tool',
                tool_call_id: toolCalls[i].id,
                content: resultText,
              });
            }
          }
        }
        // Inject collected images as a user message so the model can actually see them
        if (pendingImages.length > 0) {
          result.push({
            role: 'user',
            content: [
              { type: 'text' as const, text: '[SCREENSHOT] Tool results produced these screenshot(s). You MUST describe what you actually see in the image before deciding next action. If you cannot see the image, say "I cannot see the screenshot" — do NOT guess or fabricate what is on screen.' },
              ...pendingImages,
            ],
          });
        }
      } else {
        const assistantMsg: OpenAIMessage = { role: 'assistant', content: textContent };
        if (msg.thinking) {
          assistantMsg.reasoning_content = msg.thinking;
        }
        result.push(assistantMsg);
      }
    }
  }

  return result;
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  async chat(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void
  ): Promise<void> {
    let baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    // Auto-append /v1 if not already present
    if (!baseUrl.match(/\/v\d+$/)) {
      baseUrl += '/v1';
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages: convertMessages(messages, options.systemPrompt, options.supportsVision),
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = convertTools(options.tools);
    }

    // Inject built-in web search if configured
    if (options.builtinWebSearch) {
      const method = options.builtinWebSearch;
      if (method.type === 'tool') {
        body.tools = [...(body.tools as unknown[] || []), method.toolSpec];
      } else if (method.type === 'parameter') {
        body[method.paramName] = method.paramValue;
      }
    }

    const fetchFn = await getTauriFetch();
    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw classifyError(response.status, errorText);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    // Track tool calls being assembled
    const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();

    // <think> tag parser state — handles models that embed thinking in content (MiniMax, QwQ, etc.)
    let inThinkTag = false;
    let pendingContent = '';

    /** Returns length of longest suffix of `str` that matches a prefix of `tag` */
    function partialTagMatch(str: string, tag: string): number {
      const maxCheck = Math.min(str.length, tag.length - 1);
      for (let len = maxCheck; len > 0; len--) {
        if (str.endsWith(tag.slice(0, len))) return len;
      }
      return 0;
    }

    /** Process content chunk, splitting <think> blocks into thinking events */
    function emitContent(chunk: string) {
      pendingContent += chunk;
      while (pendingContent) {
        if (inThinkTag) {
          const closeIdx = pendingContent.indexOf('</think>');
          if (closeIdx >= 0) {
            const thinking = pendingContent.slice(0, closeIdx);
            if (thinking) onEvent({ type: 'thinking', thinking });
            pendingContent = pendingContent.slice(closeIdx + 8);
            inThinkTag = false;
            continue;
          }
          const partialLen = partialTagMatch(pendingContent, '</think>');
          const safeLen = pendingContent.length - partialLen;
          if (safeLen > 0) {
            onEvent({ type: 'thinking', thinking: pendingContent.slice(0, safeLen) });
            pendingContent = pendingContent.slice(safeLen);
          }
          break;
        } else {
          const openIdx = pendingContent.indexOf('<think>');
          if (openIdx >= 0) {
            const text = pendingContent.slice(0, openIdx);
            if (text) onEvent({ type: 'text', text });
            pendingContent = pendingContent.slice(openIdx + 7);
            inThinkTag = true;
            continue;
          }
          const partialLen = partialTagMatch(pendingContent, '<think>');
          const safeLen = pendingContent.length - partialLen;
          if (safeLen > 0) {
            onEvent({ type: 'text', text: pendingContent.slice(0, safeLen) });
            pendingContent = pendingContent.slice(safeLen);
          }
          break;
        }
      }
    }

    /** Flush any remaining buffered content */
    function flushPendingContent() {
      if (pendingContent) {
        if (inThinkTag) {
          onEvent({ type: 'thinking', thinking: pendingContent });
        } else {
          onEvent({ type: 'text', text: pendingContent });
        }
        pendingContent = '';
      }
    }

    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            // Flush any buffered <think> tag content
            flushPendingContent();
            // Emit any remaining tool calls
            for (const [, tc] of toolCallBuffers) {
              let input: Record<string, unknown> = {};
              try { input = JSON.parse(tc.args); } catch {
                input = { _parse_error: `Failed to parse tool input: ${tc.args.slice(0, 200)}` };
              }
              onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input });
            }
            const hasToolCalls = toolCallBuffers.size > 0;
            onEvent({ type: 'done', stopReason: hasToolCalls ? 'tool_use' : 'end_turn' });
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // Reasoning content (DeepSeek R1 etc.)
            if (delta?.reasoning_content) {
              onEvent({ type: 'thinking', thinking: delta.reasoning_content });
            }

            // Text content — parse <think> tags into thinking events
            if (delta?.content) {
              emitContent(delta.content);
            }

            // Tool calls (streamed incrementally)
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (tc.id) {
                  // New tool call starting
                  toolCallBuffers.set(idx, { id: tc.id, name: tc.function?.name || '', args: '' });
                }
                const existing = toolCallBuffers.get(idx);
                if (existing) {
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments) existing.args += tc.function.arguments;
                }
              }
            }

            // Check finish_reason — flush pending content before finishing
            if (choice.finish_reason) flushPendingContent();
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'tool_use') {
              for (const [, tc] of toolCallBuffers) {
                let input: Record<string, unknown> = {};
                try { input = JSON.parse(tc.args); } catch {
                  input = { _parse_error: `Failed to parse tool input: ${tc.args.slice(0, 200)}` };
                }
                onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input });
              }
              onEvent({ type: 'done', stopReason: 'tool_use' });
              return;
            } else if (choice.finish_reason === 'stop') {
              onEvent({ type: 'done', stopReason: 'end_turn' });
              return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Fallback: stream ended without [DONE] or finish_reason — emit pending tool calls and done
      for (const [, tc] of toolCallBuffers) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.args); } catch {
          input = { _parse_error: `Failed to parse tool input: ${tc.args.slice(0, 200)}` };
        }
        onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      onEvent({ type: 'done', stopReason: toolCallBuffers.size > 0 ? 'tool_use' : 'end_turn' });
    } finally {
      reader.releaseLock();
    }
  }
}
