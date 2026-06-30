import type { LLMAdapter, ChatOptions, ToolChoice } from './adapter';
import { LLMError, classifyError } from './adapter';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import { getTauriFetch } from './tauriFetch';
import { normalizeMessages } from './messageNormalizer';
import type { PreparedTurn, PreparedContentBlock } from './messageNormalizer';
import { createHeartbeat, anySignal, DEFAULT_STREAM_HANG_TIMEOUT_MS as STREAM_HANG_TIMEOUT_MS } from './heartbeat';
import { createLogger } from '../logging/logger';
import { resolveOpenAIBaseUrl } from './urlUtils';

const logger = createLogger('openai-compatible');

/**
 * Normalise a provider's `usage` response object into Abu's TokenUsage
 * shape, including prompt-caching fields. Each vendor uses a different
 * field name for cache hits, so we probe all known shapes:
 *
 *  - OpenAI standard: `usage.prompt_tokens_details.cached_tokens`
 *    (also豆包/火山引擎, 阿里百炼, 智谱 GLM when they follow the spec)
 *  - DeepSeek custom: `usage.prompt_cache_hit_tokens` (+ `_miss_tokens`)
 *  - Some legacy paths put `cached_tokens` at the top level
 *
 * Anthropic's cache_creation_input_tokens has no OpenAI equivalent
 * (their auto-caching doesn't charge for writes), so we leave that
 * field undefined here.
 */
function extractUsage(usage: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
} {
  const inputTokens = (usage.prompt_tokens as number) ?? 0;
  const outputTokens = (usage.completion_tokens as number) ?? 0;

  let cacheReadInputTokens: number | undefined;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  if (details && typeof details.cached_tokens === 'number') {
    cacheReadInputTokens = details.cached_tokens;
  } else if (typeof usage.prompt_cache_hit_tokens === 'number') {
    // DeepSeek
    cacheReadInputTokens = usage.prompt_cache_hit_tokens;
  } else if (typeof usage.cached_tokens === 'number') {
    // Some providers flatten the field to the top level
    cacheReadInputTokens = usage.cached_tokens;
  }

  return { inputTokens, outputTokens, ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}) };
}

/**
 * If the error body indicates that `max_tokens` exceeds the model's limit,
 * return the actual supported limit. Returns null otherwise.
 * Handles: "max_tokens is too large: 32768. This model supports at most 4096 completion tokens"
 */
function extractMaxTokensLimit(errorBody: string): number | null {
  try {
    const parsed = JSON.parse(errorBody) as { error?: { message?: string; param?: string } };
    if (parsed.error?.param === 'max_tokens' && parsed.error.message) {
      const m = /supports at most (\d+)/i.exec(parsed.error.message);
      if (m) return parseInt(m[1], 10);
    }
  } catch { /* not JSON */ }
  return null;
}

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
        } else {
          // Kimi K2.5 / DeepSeek R1 in thinking mode require reasoning_content
          // on every assistant message carrying tool_calls. Fill empty string
          // when the turn has no captured thinking — other providers ignore it.
          assistantMsg.reasoning_content = '';
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

/**
 * Convert Abu's ToolChoice into an OpenAI-compatible tool_choice value.
 *
 * Mapping:
 *   undefined              → undefined  (omit field — preserves current default behaviour)
 *   { type: 'auto' }      → 'auto'
 *   { type: 'any' }       → 'required'
 *   { type: 'tool', name} → { type: 'function', function: { name } }
 */
export function toOpenAIToolChoice(
  tc: ToolChoice | undefined,
): 'auto' | 'required' | { type: 'function'; function: { name: string } } | undefined {
  if (tc === undefined) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  return { type: 'function', function: { name: tc.name } };
}

/**
 * gpt-5.5 rejects "function tools + reasoning_effort" together on
 * /v1/chat/completions ("...are not supported for gpt-5.5 in /v1/chat/completions.
 * Please use /v1/responses instead.", issue #86). The Responses API is the only
 * endpoint that accepts the combo, but it imposes a reasoning-item pairing rule
 * that breaks stateless multi-turn tool use, so we stay on chat/completions and
 * simply drop reasoning_effort for this exact combo. gpt-5.5 still reasons at the
 * model default; the rest of the gpt-5 / o-series family is unaffected.
 *
 * Matches the gpt-5.5 family only: `gpt-5.5`, `gpt-5.5-2026-..`, `gpt-5.5-chat-*`.
 * NOT `gpt-5`, `gpt-5.1`, or `o5` (those keep reasoning_effort with tools).
 */
function isGpt55Model(model: string): boolean {
  return /gpt-?5\.5/i.test(model);
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  async chat(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void
  ): Promise<void> {
    // Normalize + auto-append /v1 via shared util — keeps UI preview consistent
    // and defensively trims whitespace users paste in (e.g. trailing space
    // would otherwise bypass the regex and emit /%20/v1/... to the server).
    const baseUrl = resolveOpenAIBaseUrl(options.baseUrl);

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
      // Request token usage in streaming responses (OpenAI-compatible providers, e.g. GLM)
      ...(useStreaming ? { stream_options: { include_usage: true } } : {}),
    };

    // Reasoning controls. thinkingBudget is only set for reasoning models (the
    // caller's computeReasoningParams gates it), so non-reasoning models never
    // receive thinking_budget — avoiding a 400 from providers that reject it.
    if (options.thinkingBudget != null) {
      body.thinking_budget = options.thinkingBudget;
    }
    // Skip reasoning_effort for gpt-5.5 when tools are present — OpenAI rejects
    // that combo on /chat/completions (issue #86). See isGpt55Model above.
    if (options.reasoningEffort && !(hasTools && isGpt55Model(options.model))) {
      body.reasoning_effort = options.reasoningEffort;
    }

    if (hasTools) {
      body.tools = convertTools(options.tools!);
      const tc = toOpenAIToolChoice(options.toolChoice);
      if (tc !== undefined) body.tool_choice = tc;
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

    const requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.apiKey) {
      requestHeaders['Authorization'] = `Bearer ${options.apiKey}`;
    }
    const fetchFn = await getTauriFetch();

    // Stream-level abort controller. The idle heartbeat (below) emits events
    // but cannot make a hung `reader.read()` return — chat() would stay pending
    // and the awaiting agent/subagent loop would hang forever. Aborting this
    // controller drives the fetch's abort path (tauriFetch errors the body
    // stream), which rejects the pending read and lets chat() unwind. Merge the
    // caller's signal via AbortSignal.any so user-initiated cancels still reach
    // the fetch (the merged signal is GC'd with chat() — no listener leak).
    const streamAbort = new AbortController();
    const effectiveSignal = options.signal
      ? anySignal([options.signal, streamAbort.signal])
      : streamAbort.signal;
    let idleTimedOut = false;

    // Connect/header-phase timeout: the idle heartbeat only arms after the body
    // stream is obtained, so a server that accepts the connection but never
    // returns headers would hang here unbounded. Abort once the ceiling is hit.
    let connectTimedOut = false;
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      streamAbort.abort();
    }, STREAM_HANG_TIMEOUT_MS);
    let response: Awaited<ReturnType<typeof fetchFn>>;
    try {
      response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });
    } catch (fetchErr) {
      // Connection-level failure (DNS, timeout, refused) — not an agent bug
      if (connectTimedOut) {
        throw new LLMError(`连接超时：${STREAM_HANG_TIMEOUT_MS / 1000} 秒未收到服务器响应头`, 'network_error', { retryable: true, retryAfterMs: 2000 });
      }
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new LLMError(msg, 'network_error', { retryable: true, retryAfterMs: 2000 });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      const errorText = await response.text();
      // Auto-retry once when the model's actual max_tokens limit is lower than
      // what the capabilities registry advertised. Extract the real limit from
      // the error message and retry with it so the request succeeds.
      const retryLimit = extractMaxTokensLimit(errorText);
      if (response.status === 400 && retryLimit !== null) {
        logger.warn('max_tokens too large, retrying with model limit', {
          requested: body.max_tokens,
          limit: retryLimit,
        });
        body.max_tokens = retryLimit;
        response = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body),
          signal: effectiveSignal,
        });
        if (!response.ok) {
          throw classifyError(response.status, await response.text());
        }
        // Retry succeeded — surface the discovered limit so the caller can
        // persist it. Next request will use the correct value pre-emptively.
        options.onMaxTokensLimitDiscovered?.(retryLimit);
      } else {
        throw classifyError(response.status, errorText);
      }
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
      const usage = data.usage as Record<string, unknown> | undefined;
      if (usage) {
        onEvent({ type: 'usage', usage: extractUsage(usage) });
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
        const textContent = typeof msg?.content === 'string' ? msg.content : '';
        const emittedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        // Fallback 1: <tool_call>{json}</tool_call>
        const textToolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        for (const match of textContent.matchAll(textToolCallRegex)) {
          try {
            const parsed = JSON.parse(match[1]);
            const name = parsed.name as string;
            const args = parsed.arguments ?? parsed.parameters ?? {};
            const input = typeof args === 'string' ? JSON.parse(args) : args;
            emittedToolCalls.push({ id: generateToolCallId('text-tc'), name, input });
          } catch { /* skip */ }
        }

        // Fallback 2: <|FunctionCallBegin|>[{json array}]<|FunctionCallEnd|> (Doubao/豆包)
        const doubaoRegex = /<\|FunctionCallBegin\|>([\s\S]*?)<\|FunctionCallEnd\|>/g;
        for (const match of textContent.matchAll(doubaoRegex)) {
          try {
            const raw = JSON.parse(match[1].trim());
            const calls = Array.isArray(raw) ? raw : [raw];
            for (const call of calls as Array<Record<string, unknown>>) {
              const name = call.name as string;
              const args = call.parameters ?? call.arguments ?? {};
              const input = typeof args === 'string' ? (JSON.parse(args) as Record<string, unknown>) : (args as Record<string, unknown>);
              emittedToolCalls.push({ id: generateToolCallId('doubao-tc'), name, input });
            }
          } catch { /* skip */ }
        }

        if (emittedToolCalls.length > 0) {
          for (const tc of emittedToolCalls) {
            onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
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
    // Aborting streamAbort rejects the pending reader.read() so chat() can
    // actually return; the catch below turns it into a retryable LLMError.
    // (Emitting events alone, as before, left the read hung and chat() pending.)
    const heartbeat = createHeartbeat(STREAM_HANG_TIMEOUT_MS, () => {
      idleTimedOut = true;
      streamAbort.abort();
    });

    const decoder = new TextDecoder();
    let buffer = '';

    // Track tool calls being assembled
    const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();
    // After done is emitted, keep looping only to capture the trailing usage chunk
    let doneEmitted = false;

    // Tag parser state — handles <think>, <tool_call>, and <|FunctionCallBegin|> (Doubao) in content
    let inThinkTag = false;
    let inToolCallTag = false;
    let inDoubaoTag = false;   // <|FunctionCallBegin|>...<|FunctionCallEnd|>
    let pendingContent = '';
    /** Collected text-based tool calls (from <tool_call> / Doubao tags) */
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
     * - <think>...</think>                          → thinking events
     * - <tool_call>...</tool_call>                  → buffered, parsed as tool_use on close
     * - <|FunctionCallBegin|>...<|FunctionCallEnd|> → Doubao/豆包 format, parsed as tool_use
     * - Everything else                             → text events
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
          const closeIdx = pendingContent.indexOf('</tool_call>');
          if (closeIdx >= 0) {
            const jsonStr = pendingContent.slice(0, closeIdx).trim();
            pendingContent = pendingContent.slice(closeIdx + 12);
            inToolCallTag = false;
            try {
              const parsed = JSON.parse(jsonStr);
              const name = parsed.name as string;
              const args = parsed.arguments ?? parsed.parameters ?? {};
              const input = typeof args === 'string' ? JSON.parse(args) : args;
              textToolCalls.push({ id: generateToolCallId('text-tc'), name, input });
            } catch {
              // Fallback: some models emit XML attribute format: <tool_name attr1="val">
              const xmlMatch = /^\s*<([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/?>\s*$/.exec(jsonStr);
              if (xmlMatch) {
                const name = xmlMatch[1];
                const attrsStr = xmlMatch[2] ?? '';
                const input: Record<string, unknown> = {};
                const attrRe = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
                let m: RegExpExecArray | null;
                while ((m = attrRe.exec(attrsStr)) !== null) {
                  input[m[1]] = m[2];
                }
                textToolCalls.push({ id: generateToolCallId('text-tc'), name, input });
              } else {
                onEvent({ type: 'text', text: `<tool_call>${jsonStr}</tool_call>` });
              }
            }
            continue;
          }
          const partialLen = partialTagMatch(pendingContent, '</tool_call>');
          if (partialLen > 0) break;
          break;
        } else if (inDoubaoTag) {
          // Doubao/豆包 format: JSON array of tool calls between <|FunctionCallBegin|> tags
          const closeIdx = pendingContent.indexOf('<|FunctionCallEnd|>');
          if (closeIdx >= 0) {
            const jsonStr = pendingContent.slice(0, closeIdx).trim();
            pendingContent = pendingContent.slice(closeIdx + 19); // '<|FunctionCallEnd|>'.length
            inDoubaoTag = false;
            try {
              const raw = JSON.parse(jsonStr);
              const calls = Array.isArray(raw) ? raw : [raw];
              for (const call of calls as Array<Record<string, unknown>>) {
                const name = call.name as string;
                const args = call.parameters ?? call.arguments ?? {};
                const input = typeof args === 'string' ? (JSON.parse(args) as Record<string, unknown>) : (args as Record<string, unknown>);
                textToolCalls.push({ id: generateToolCallId('doubao-tc'), name, input });
              }
            } catch {
              onEvent({ type: 'text', text: `<|FunctionCallBegin|>${jsonStr}<|FunctionCallEnd|>` });
            }
            continue;
          }
          const partialLen = partialTagMatch(pendingContent, '<|FunctionCallEnd|>');
          if (partialLen > 0) break;
          break;
        } else {
          const thinkIdx = pendingContent.indexOf('<think>');
          const toolCallIdx = pendingContent.indexOf('<tool_call>');
          const doubaoIdx = pendingContent.indexOf('<|FunctionCallBegin|>');

          const earliest = [
            thinkIdx >= 0 ? { idx: thinkIdx, tag: 'think' as const } : null,
            toolCallIdx >= 0 ? { idx: toolCallIdx, tag: 'tool_call' as const } : null,
            doubaoIdx >= 0 ? { idx: doubaoIdx, tag: 'doubao' as const } : null,
          ].filter(Boolean).sort((a, b) => a!.idx - b!.idx)[0];

          if (earliest) {
            const text = pendingContent.slice(0, earliest.idx);
            if (text) onEvent({ type: 'text', text });
            if (earliest.tag === 'think') {
              pendingContent = pendingContent.slice(earliest.idx + 7);
              inThinkTag = true;
            } else if (earliest.tag === 'tool_call') {
              pendingContent = pendingContent.slice(earliest.idx + 11);
              inToolCallTag = true;
            } else {
              pendingContent = pendingContent.slice(earliest.idx + 21); // '<|FunctionCallBegin|>'.length
              inDoubaoTag = true;
            }
            continue;
          }

          const partialThink = partialTagMatch(pendingContent, '<think>');
          const partialToolCall = partialTagMatch(pendingContent, '<tool_call>');
          const partialDoubao = partialTagMatch(pendingContent, '<|FunctionCallBegin|>');
          const maxPartial = Math.max(partialThink, partialToolCall, partialDoubao);
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
          onEvent({ type: 'text', text: `<tool_call>${pendingContent}` });
        } else if (inDoubaoTag) {
          onEvent({ type: 'text', text: `<|FunctionCallBegin|>${pendingContent}` });
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
              onEvent({
                type: 'usage',
                usage: extractUsage(parsed.usage as Record<string, unknown>),
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
    } catch (streamErr) {
      // Idle-heartbeat abort: surface a clear retryable error (the underlying
      // reject is a generic "Request cancelled" from the aborted body stream).
      if (idleTimedOut) {
        throw new LLMError(`连接空闲超时：${STREAM_HANG_TIMEOUT_MS / 1000} 秒未收到任何数据`, 'network_error', { retryable: true });
      }
      // Wrap raw network/decode errors (e.g. "error decoding response body" from
      // gateway disconnects) as retryable LLMErrors so withRetry can handle them.
      if (!(streamErr instanceof LLMError)) {
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        throw new LLMError(msg, 'network_error', { retryable: true });
      }
      throw streamErr;
    } finally {
      heartbeat.clear();
      reader.releaseLock();
    }
  }
}
