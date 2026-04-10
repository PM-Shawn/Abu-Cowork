import type { LLMAdapter, ChatOptions } from './adapter';
import { classifyError } from './adapter';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import { getTauriFetch } from './tauriFetch';
import { normalizeMessages } from './messageNormalizer';
import type { PreparedTurn, PreparedContentBlock } from './messageNormalizer';
import { createHeartbeat } from './heartbeat';
import { createLogger } from '../logging/logger';

const logger = createLogger('openai-compatible');

/**
 * Safely parse a tool-call arguments string into a Record.
 * - Empty string → {} (let validateToolInput surface missing required fields)
 * - Non-object parse results (null, array, primitive) → {} (defensive)
 * - Parse failure → null (caller should mark _parse_error)
 */
function safeParseToolArgs(args: string): Record<string, unknown> | null {
  if (!args || !args.trim()) return {};
  try {
    const v = JSON.parse(args);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return {};
  } catch {
    return null;
  }
}

/**
 * Build the input object for a tool_use event from a streamed tool call buffer.
 * Logs full diagnostic context on parse failure so future issues can be traced
 * from disk logs (appDataDir/logs/YYYY-MM-DD.log).
 */
function buildToolInput(
  tc: { id: string; name: string; args: string },
  source: string,
): Record<string, unknown> {
  const parsed = safeParseToolArgs(tc.args);
  if (parsed !== null) return parsed;
  logger.error('tool args JSON parse failed', {
    source,
    tool: tc.name,
    argsLength: tc.args.length,
    argsPreview: tc.args.slice(0, 500),
  });
  return { _parse_error: `Failed to parse tool input: ${tc.args.slice(0, 200)}` };
}

// Counter-based tool call ID generator — prevents collisions on rapid parallel calls
let toolCallCounter = 0;
function generateToolCallId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++toolCallCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

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

/** Convert PreparedContentBlock[] to OpenAI content parts */
function toOpenAIContentParts(blocks: PreparedContentBlock[]): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${b.mediaType};base64,${b.data}` },
      });
    }
    // Documents are not supported in OpenAI format — skip silently
  }
  return parts;
}

/**
 * Serialize PreparedTurn[] into OpenAI-compatible messages.
 *
 * Thin serializer — all logic (orphan fix, ID gen, image extraction) is in normalizeMessages.
 */
function serializeForOpenAI(turns: PreparedTurn[], systemPrompt?: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const turn of turns) {
    if (turn.kind === 'user') {
      const hasImages = turn.content.some((b) => b.type === 'image');
      if (hasImages) {
        const parts = toOpenAIContentParts(turn.content);
        // Some providers require at least one text part alongside images
        if (!parts.some((p) => p.type === 'text')) {
          parts.unshift({ type: 'text', text: ' ' });
        }
        result.push({ role: 'user', content: parts });
      } else {
        const text = turn.content.map((b) => b.type === 'text' ? b.text : '').join('');
        result.push({ role: 'user', content: text });
      }
    } else {
      // Assistant turn
      if (turn.toolCalls.length > 0) {
        // Build OpenAI tool_calls array
        const toolCalls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        }));

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: turn.text || null,
          tool_calls: toolCalls,
        };
        if (turn.thinking) {
          assistantMsg.reasoning_content = turn.thinking;
        }
        result.push(assistantMsg);

        // Add tool results — normalizeMessages guarantees every tool_use has a result
        // OpenAI only supports images in role:"user", not in role:"tool"
        const pendingImages: OpenAIContentPart[] = [];
        for (const tc of turn.toolCalls) {
          result.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: tc.result,
          });
          // Collect images for a follow-up user message
          for (const img of tc.resultImages) {
            pendingImages.push({
              type: 'image_url',
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            });
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
        const assistantMsg: OpenAIMessage = { role: 'assistant', content: turn.text };
        if (turn.thinking) {
          assistantMsg.reasoning_content = turn.thinking;
        }
        result.push(assistantMsg);
      }
    }
  }

  return result;
}

/** Convert messages through normalize → serialize pipeline */
function convertMessages(messages: Message[], systemPrompt?: string, supportsVision?: boolean): OpenAIMessage[] {
  const turns = normalizeMessages(messages, { supportsVision: supportsVision !== false });
  return serializeForOpenAI(turns, systemPrompt);
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

    // Ollama: streaming + tool calling is broken in /v1/chat/completions.
    // When tools are present and endpoint looks like Ollama, use non-streaming.
    const isOllamaEndpoint = /localhost:\d{4,5}|127\.0\.0\.1:\d{4,5}|ollama/i.test(baseUrl);
    const hasTools = !!(options.tools && options.tools.length > 0);
    const useStreaming = !(isOllamaEndpoint && hasTools);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: convertMessages(messages, options.systemPrompt, options.supportsVision),
      max_tokens: options.maxTokens ?? 4096,
      stream: useStreaming,
    };

    if (hasTools) {
      body.tools = convertTools(options.tools!);
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

    // ── Non-streaming path (Ollama + tools) ──
    if (!useStreaming) {
      const data = await response.json() as Record<string, unknown>;
      const choices = data.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const msg = choice?.message as Record<string, unknown> | undefined;

      if (msg?.content && typeof msg.content === 'string') {
        onEvent({ type: 'text', text: msg.content });
      }

      // Emit usage before done so agentLoop can capture it in finalUsage
      const usage = data.usage as Record<string, number> | undefined;
      if (usage) {
        onEvent({ type: 'usage', usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } });
      }

      const toolCalls = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const fn = tc.function as Record<string, unknown>;
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(fn.arguments as string); } catch { /* empty */ }
          onEvent({ type: 'tool_use', id: (tc.id as string) || generateToolCallId('ollama'), name: fn.name as string, input });
        }
        onEvent({ type: 'done', stopReason: 'tool_use' });
      } else {
        // Fallback: parse <tool_call> XML from text content
        const textContent = typeof msg?.content === 'string' ? msg.content : '';
        const textToolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        const textMatches = [...textContent.matchAll(textToolCallRegex)];
        if (textMatches.length > 0) {
          for (const match of textMatches) {
            try {
              const parsed = JSON.parse(match[1]);
              const name = parsed.name as string;
              const args = parsed.arguments ?? parsed.parameters ?? {};
              const parsedInput = typeof args === 'string' ? JSON.parse(args) : args;
              const id = generateToolCallId('text-tc');
              onEvent({ type: 'tool_use', id, name, input: parsedInput });
            } catch { /* skip */ }
          }
          onEvent({ type: 'done', stopReason: 'tool_use' });
        } else {
          onEvent({ type: 'done', stopReason: 'end_turn' });
        }
      }
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    // Idle timeout: if no data received for 90s, treat as network hang.
    const heartbeat = createHeartbeat(90_000, () => {
      onEvent({ type: 'error', error: 'Stream idle timeout: no data received for 90s' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    });

    const decoder = new TextDecoder();
    let buffer = '';

    // Track tool calls being assembled
    const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();
    // After done is emitted, keep looping only to capture the trailing usage chunk
    let doneEmitted = false;

    // Tag parser state — handles <think> (thinking) and <tool_call> (fallback tool calls) in content
    let inThinkTag = false;
    let inToolCallTag = false;
    let pendingContent = '';
    /** Collected text-based tool calls (from <tool_call> tags) */
    const textToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    /** Returns length of longest suffix of `str` that matches a prefix of `tag` */
    function partialTagMatch(str: string, tag: string): number {
      const maxCheck = Math.min(str.length, tag.length - 1);
      for (let len = maxCheck; len > 0; len--) {
        if (str.endsWith(tag.slice(0, len))) return len;
      }
      return 0;
    }

    /**
     * Process content chunk, splitting special tags:
     * - <think>...</think> → thinking events
     * - <tool_call>...</tool_call> → buffered, parsed as tool_use on close
     * - Everything else → text events
     */
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
        } else if (inToolCallTag) {
          // Buffer <tool_call> content — don't emit as text
          const closeIdx = pendingContent.indexOf('</tool_call>');
          if (closeIdx >= 0) {
            const jsonStr = pendingContent.slice(0, closeIdx).trim();
            pendingContent = pendingContent.slice(closeIdx + 12);
            inToolCallTag = false;
            // Parse the tool call JSON
            try {
              const parsed = JSON.parse(jsonStr);
              const name = parsed.name as string;
              const args = parsed.arguments ?? parsed.parameters ?? {};
              const input = typeof args === 'string' ? JSON.parse(args) : args;
              const id = generateToolCallId('text-tc');
              textToolCalls.push({ id, name, input });
            } catch {
              // Unparseable — emit as text fallback
              onEvent({ type: 'text', text: `<tool_call>${jsonStr}</tool_call>` });
            }
            continue;
          }
          // Wait for more data (closing tag not yet received)
          const partialLen = partialTagMatch(pendingContent, '</tool_call>');
          if (partialLen > 0) break; // Hold buffer
          // No partial match and content is large enough — keep waiting
          break;
        } else {
          // Check for <think> first
          const thinkIdx = pendingContent.indexOf('<think>');
          const toolCallIdx = pendingContent.indexOf('<tool_call>');

          // Find earliest tag
          const earliest = [
            thinkIdx >= 0 ? { idx: thinkIdx, tag: 'think' as const } : null,
            toolCallIdx >= 0 ? { idx: toolCallIdx, tag: 'tool_call' as const } : null,
          ].filter(Boolean).sort((a, b) => a!.idx - b!.idx)[0];

          if (earliest) {
            // Emit text before the tag
            const text = pendingContent.slice(0, earliest.idx);
            if (text) onEvent({ type: 'text', text });
            if (earliest.tag === 'think') {
              pendingContent = pendingContent.slice(earliest.idx + 7); // '<think>'.length
              inThinkTag = true;
            } else {
              pendingContent = pendingContent.slice(earliest.idx + 11); // '<tool_call>'.length
              inToolCallTag = true;
            }
            continue;
          }

          // Check for partial tag matches at end
          const partialThink = partialTagMatch(pendingContent, '<think>');
          const partialToolCall = partialTagMatch(pendingContent, '<tool_call>');
          const maxPartial = Math.max(partialThink, partialToolCall);
          const safeLen = pendingContent.length - maxPartial;
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
        } else if (inToolCallTag) {
          // Incomplete tool_call tag — emit as text
          onEvent({ type: 'text', text: `<tool_call>${pendingContent}` });
        } else {
          onEvent({ type: 'text', text: pendingContent });
        }
        pendingContent = '';
      }
    }

    /** Emit all buffered text-based tool calls as tool_use events */
    function emitTextToolCalls(): boolean {
      if (textToolCalls.length === 0) return false;
      for (const tc of textToolCalls) {
        onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      return true;
    }

    try {
      heartbeat.reset();
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        heartbeat.reset();

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            if (!doneEmitted) {
              flushPendingContent();
              // Emit structured tool calls
              for (const [, tc] of toolCallBuffers) {
                const input = buildToolInput(tc, '[DONE]');
                onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input });
              }
              // Emit text-based <tool_call> tool calls
              const hasTextTC = emitTextToolCalls();
              const hasToolCalls = toolCallBuffers.size > 0 || hasTextTC;
              onEvent({ type: 'done', stopReason: hasToolCalls ? 'tool_use' : 'end_turn' });
            }
            return;
          }

          try {
            const parsed = JSON.parse(data);

            // Extract usage from ANY chunk that carries it — some providers
            // send it as a standalone chunk (OpenAI stream_options), others
            // embed it in the finish_reason chunk alongside choices.
            if (parsed.usage) {
              const u = parsed.usage as Record<string, number>;
              onEvent({
                type: 'usage',
                usage: {
                  inputTokens: u.prompt_tokens ?? 0,
                  outputTokens: u.completion_tokens ?? 0,
                },
              });
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            // After done, skip content/tool processing — only usage matters
            if (doneEmitted) continue;

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

            // Check finish_reason — flush pending content before finishing.
            // After emitting done, don't return immediately — continue the loop
            // to capture the trailing usage chunk that arrives before [DONE].
            if (choice.finish_reason) flushPendingContent();
            if (
              choice.finish_reason === 'tool_calls' ||
              choice.finish_reason === 'tool_use' ||
              // Some OpenAI-compatible providers (legacy GLM/Zhipu, others) use the
              // older 'function_call' alias instead of 'tool_calls'.
              choice.finish_reason === 'function_call'
            ) {
              for (const [, tc] of toolCallBuffers) {
                const input = buildToolInput(tc, `finish_reason=${choice.finish_reason}`);
                onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input });
              }
              // Some providers mix native and text-based tool calls in one response.
              const hasTextTC = emitTextToolCalls();
              const hasToolCalls = toolCallBuffers.size > 0 || hasTextTC;
              onEvent({ type: 'done', stopReason: hasToolCalls ? 'tool_use' : 'end_turn' });
              doneEmitted = true;
            } else if (choice.finish_reason === 'stop') {
              // Emit text-based <tool_call> tool calls if any were buffered
              const hasTextTC = emitTextToolCalls();
              if (hasTextTC) {
                onEvent({ type: 'done', stopReason: 'tool_use' });
              } else {
                onEvent({ type: 'done', stopReason: 'end_turn' });
              }
              doneEmitted = true;
            } else if (choice.finish_reason === 'length') {
              // Model output reached max_tokens. Three sub-cases:
              //   (a) Tool args fully accumulated → emit tool_use, signal tool_use
              //   (b) Tool args partial / unparseable → DROP broken tool calls and
              //       signal max_tokens so agentLoop's escalateMaxOutputTokens can
              //       double the limit and retry. Keeping the broken tool call would
              //       set collectedToolCalls.length > 0 and bypass the escalation
              //       trigger condition (agentLoop.ts L1284).
              //   (c) No tool calls (text output truncated) → signal max_tokens
              const parsedAll: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
              let anyParseFailed = false;
              for (const [, tc] of toolCallBuffers) {
                const parsed = safeParseToolArgs(tc.args);
                if (parsed === null) {
                  anyParseFailed = true;
                  break;
                }
                parsedAll.push({ id: tc.id, name: tc.name, input: parsed });
              }
              if (!anyParseFailed && parsedAll.length > 0) {
                // Case (a): all tool args complete despite length truncation
                for (const e of parsedAll) {
                  onEvent({ type: 'tool_use', id: e.id, name: e.name, input: e.input });
                }
                onEvent({ type: 'done', stopReason: 'tool_use' });
              } else {
                // Case (b) or (c): drop broken tool calls, signal max_tokens
                logger.warn('finish_reason=length, dropping tool calls for escalation', {
                  toolCallCount: toolCallBuffers.size,
                  partials: Array.from(toolCallBuffers.values()).map((t) => ({
                    name: t.name,
                    argsLength: t.args.length,
                    argsPreview: t.args.slice(0, 200),
                  })),
                });
                onEvent({ type: 'done', stopReason: 'max_tokens' });
              }
              doneEmitted = true;
            } else if (choice.finish_reason) {
              // Unknown finish_reason — log so we can diagnose new providers
              logger.warn('unknown finish_reason', {
                finish_reason: choice.finish_reason,
                hasToolCalls: toolCallBuffers.size > 0,
              });
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Fallback: stream ended without [DONE] or finish_reason — emit pending tool calls and done
      if (!doneEmitted) {
        for (const [, tc] of toolCallBuffers) {
          const input = buildToolInput(tc, 'stream-end-fallback');
          onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        onEvent({ type: 'done', stopReason: toolCallBuffers.size > 0 ? 'tool_use' : 'end_turn' });
      }
    } finally {
      heartbeat.clear();
      reader.releaseLock();
    }
  }
}
