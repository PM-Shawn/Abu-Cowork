import type { LLMAdapter, ChatOptions, ToolChoice } from './adapter';
import { LLMError, classifyError, LOG_TOOL_ARG_PREVIEW, buildToolParseError } from './adapter';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import { getTauriFetch } from './tauriFetch';
import { normalizeMessages } from './messageNormalizer';
import type { PreparedTurn, PreparedContentBlock } from './messageNormalizer';
import {
  createHeartbeat,
  anySignal,
  localFirstResponseTimeoutError,
  DEFAULT_STREAM_HANG_TIMEOUT_MS as STREAM_HANG_TIMEOUT_MS,
  LOCAL_FIRST_RESPONSE_TIMEOUT_MS,
} from './heartbeat';
import { createLogger } from '../logging/logger';
import { resolveOpenAIBaseUrl, buildFullChatUrl } from './urlUtils';
import { applyModelRequestProcessors } from './modelRequestProcessors';
import { observeCompatEvent } from '../observability/compatEvents';
import { createDefaultUsageRecorder, type UsageAttemptRecorder } from './usageRecorder';
import { createTextToolCallParser, type TextSegment, type TextToolCall } from './textToolCalls';

const logger = createLogger('openai-compatible');

// ── Hang-ceiling timeout helper (code-review fix #10) ──
//
// chat() arms this same pattern at two phases of a request that can each
// hang unbounded if the server accepts the connection but never responds:
// the initial connect/header wait and the max_tokens-retry connect/header wait.
// Consolidated here so the timeout semantics (retryable, retryAfterMs) live
// in one place; only the per-phase message wording still varies by call site.

/**
 * Arm a hang-ceiling timer: aborts `streamAbort` after `timeoutMs` (the shared
 * 180s ceiling unless a caller passes another) and flips a flag the caller's
 * catch block can check to distinguish "timed out" from any other
 * abort/connection failure. Returns `timedOut()` (a function, since the flag
 * flips asynchronously after `armHangTimer` returns) and `clear()` to cancel
 * the timer once the awaited operation settles.
 */
function armHangTimer(
  streamAbort: AbortController,
  timeoutMs: number = STREAM_HANG_TIMEOUT_MS,
): { timedOut: () => boolean; clear: () => void } {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    streamAbort.abort();
  }, timeoutMs);
  return {
    timedOut: () => timedOut,
    clear: () => clearTimeout(timer),
  };
}

/**
 * Build the LLMError thrown when a hang-ceiling timer (see `armHangTimer`)
 * fired before the awaited operation settled. `prefix`/`suffix` carry the
 * per-site phase wording — e.g. `hangTimeoutError('连接超时', '未收到服务器响应头')`
 * reproduces the connect-phase message exactly; `retryable`/`retryAfterMs`
 * are identical across both call sites.
 */
function hangTimeoutError(prefix: string, suffix: string): LLMError {
  return new LLMError(`${prefix}：${STREAM_HANG_TIMEOUT_MS / 1000} 秒${suffix}`, 'network_error', {
    retryable: true,
    retryAfterMs: 2000,
  });
}

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
  return buildToolParseError(tc.args, { source, tool: tc.name }, logger);
}

/**
 * Flush only the buffered tool calls whose arguments parse successfully, dropping
 * malformed/partial ones. Mirrors the finish_reason='length' invariant: never hand
 * a broken tool call to the agent loop (which would surface a spurious `_parse_error`
 * tool execution instead of a clean turn). Use this on the abnormal terminal
 * branches (error / content_filter / refusal / unknown finish_reason) where there is
 * no max_tokens escalation path to recover a truncated call. Returns true if any
 * tool_use was emitted.
 */
function emitParseableToolCalls(
  toolCallBuffers: Map<number, { id: string; name: string; args: string }>,
  onEvent: (event: StreamEvent) => void,
): boolean {
  let emitted = false;
  for (const [, tc] of toolCallBuffers) {
    const parsed = safeParseToolArgs(tc.args);
    if (parsed === null) continue; // drop malformed — do not emit a _parse_error tool call
    onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input: parsed });
    emitted = true;
  }
  return emitted;
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

// OpenAI-compatible chat has no document/file content type, so PDF attachments
// can't be sent. Leave a text breadcrumb instead of dropping them silently —
// otherwise the model sees nothing and may claim no file was provided.
// LLM-facing → English.
export const DOCUMENT_UNSUPPORTED_NOTE =
  '[A document was attached but the current model cannot receive file attachments. ' +
  'Tell the user their model does not support documents, or ask them to paste the relevant text.]';

/** 工具结果里的截图随后作为一条用户消息补发时附带的说明（给模型看，英文）。 */
export const TOOL_RESULT_IMAGES_NOTE =
  '[SCREENSHOT] Tool results produced these screenshot(s). You MUST describe what you actually see in the image before deciding next action. If you cannot see the image, say "I cannot see the screenshot" — do NOT guess or fabricate what is on screen.';

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
    } else if (b.type === 'document') {
      // OpenAI format has no document part — leave a breadcrumb (see note above).
      parts.push({ type: 'text', text: DOCUMENT_UNSUPPORTED_NOTE });
    }
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
        const text = turn.content
          .map((b) => (b.type === 'text' ? b.text : b.type === 'document' ? DOCUMENT_UNSUPPORTED_NOTE : ''))
          .join('');
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
              { type: 'text' as const, text: TOOL_RESULT_IMAGES_NOTE },
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

export class OpenAICompatibleAdapter implements LLMAdapter {
  async chat(
    messages: Message[],
    options: ChatOptions,
    emitEvent: (event: StreamEvent) => void
  ): Promise<void> {
    // 用量采集在 provider 边界。这个适配器有二十多处结束事件的发出点，结清统一挂在
    // 事件出口上：每一处都会经过这里，没有哪次尝试会永远停在「进行中」。
    const recorder = createDefaultUsageRecorder({
      protocol: 'openai-compatible',
      requestedModel: options.model,
      accounting: options.accounting,
    });
    const onEvent = (event: StreamEvent): void => {
      if (event.type === 'done') {
        recorder.settle(event.stopReason === 'cancelled' ? 'cancelled' : 'succeeded');
      }
      emitEvent(event);
    };
    try {
      await this.chatWithRecorder(messages, options, onEvent, recorder);
    } catch (err) {
      // 用户取消与请求失败在账本里是两种结果，页面上也分开显示。
      recorder.settle(options.signal?.aborted ? 'cancelled' : 'failed');
      throw err;
    } finally {
      // 兜底：走到这里还没结清，说明是上面两支没覆盖到的退出路径。
      // 结清是幂等的，已经有结果的尝试不会被改写。
      recorder.settle('interrupted');
    }
  }

  private async chatWithRecorder(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void,
    recorder: UsageAttemptRecorder,
  ): Promise<void> {
    // Normalize + auto-append /v1 via shared util — keeps UI preview consistent
    // and defensively trims whitespace users paste in (e.g. trailing space
    // would otherwise bypass the regex and emit /%20/v1/... to the server).
    const baseUrl = resolveOpenAIBaseUrl(options.baseUrl);
    // Full URL for POST — idempotent: a user-pasted URL that already ends in
    // /chat/completions is not double-appended. useRawUrl bypasses all
    // normalization for proxies with non-standard paths.
    const fullUrl = buildFullChatUrl(options.baseUrl, 'openai-compatible', {
      useRawUrl: options.declaredCapabilities?.useRawUrl,
    });
    // Host of the request URL — used for both the request-processor context and
    // for observability events emitted from the streaming loop below. fullUrl is
    // invariant for the whole request, so derive it once here.
    const requestHost = (() => { try { return new URL(fullUrl).host; } catch { return ''; } })();

    const hasTools = !!(options.tools && options.tools.length > 0);

    const convertedMessages = convertMessages(messages, options.systemPrompt, options.supportsVision);
    // Volatile context tail rides as the LAST message, after the whole stored
    // history: automatic prefix caching (DeepSeek/OpenAI) then keeps matching
    // the stable [system + history] prefix across turns and only this small
    // per-turn block is re-billed. In the system prompt it would sit BEFORE
    // the history and re-bill the entire conversation on every change.
    if (options.volatileContextTail) {
      convertedMessages.push({ role: 'user', content: options.volatileContextTail });
    }
    // Official OpenAI endpoint only: pin the automatic prefix cache to this
    // conversation with prompt_cache_key (improves cache routing across
    // requests; same discipline as Codex CLI). Gated to api.openai.com — an
    // unknown body param can be rejected by strict OpenAI-compatible gateways,
    // and other providers (DeepSeek/GLM/…) don't support it.
    const promptCacheKey = options.metadata?.conversationId;
    const isOfficialOpenAI = /(^|\.)api\.openai\.com$/i.test((() => {
      try { return new URL(baseUrl).hostname; } catch { return ''; }
    })());
    const body: Record<string, unknown> = {
      model: options.model,
      messages: convertedMessages,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      // Request token usage in streaming responses (OpenAI-compatible providers, e.g. GLM)
      stream_options: { include_usage: true },
      ...(isOfficialOpenAI && promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    };

    // Reasoning controls. thinkingBudget is only set for reasoning models (the
    // caller's computeReasoningParams gates it), so non-reasoning models never
    // receive thinking_budget — avoiding a 400 from providers that reject it.
    if (options.thinkingBudget != null) {
      body.thinking_budget = options.thinkingBudget;
    }
    if (options.reasoningEffort) {
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

    applyModelRequestProcessors(body, {
      modelId: options.model,
      requestHost,
      hasTools,
      caps: options.declaredCapabilities,
    });

    const requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.apiKey) {
      requestHeaders['Authorization'] = `Bearer ${options.apiKey}`;
    }
    const fetchFn = await getTauriFetch({ localServer: options.localServer === true });
    // 尝试身份在 fetch 层铸造：下面的限额重试会再走一次 fetch，它在账本里单独
    // 占一条尝试（任务书 U02）。
    const countingFetch: typeof fetchFn = (...args) => {
      recorder.beginAttempt();
      return fetchFn(...args);
    };

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
    // 本地服务（LM Studio、本机自定义地址）处理长输入时在处理完之前不回响应头，也不发
    // 第一段输出：从发出请求到第一段输出算一个整体，最多等 10 分钟，超时不重试；
    // 云端保持响应头 180 秒。
    const localServer = options.localServer === true;
    const firstResponseTimeoutMs = localServer ? LOCAL_FIRST_RESPONSE_TIMEOUT_MS : STREAM_HANG_TIMEOUT_MS;
    const firstResponseTimeoutError = (): LLMError =>
      localServer ? localFirstResponseTimeoutError() : hangTimeoutError('连接超时', '未收到服务器响应头');
    let connectHangTimer = armHangTimer(streamAbort, firstResponseTimeoutMs);
    let response: Awaited<ReturnType<typeof fetchFn>>;
    try {
      response = await countingFetch(fullUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });
    } catch (fetchErr) {
      connectHangTimer.clear();
      // Connection-level failure (DNS, timeout, refused) — not an agent bug
      if (connectHangTimer.timedOut()) throw firstResponseTimeoutError();
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new LLMError(msg, 'network_error', { retryable: true, retryAfterMs: 2000 });
    }
    // 云端：响应头到了就结束这一段计时；本地：计时持续到第一段输出
    if (!localServer) connectHangTimer.clear();

    if (!response.ok) {
      connectHangTimer.clear();
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
        // The first attempt's timer was already cleared, so arm a fresh one —
        // otherwise a server that stalls on this retry before returning
        // headers would wait unbounded (only a user abort could cancel it).
        connectHangTimer = armHangTimer(streamAbort, firstResponseTimeoutMs);
        try {
          response = await countingFetch(fullUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(body),
            signal: effectiveSignal,
          });
        } catch (retryErr) {
          connectHangTimer.clear();
          if (connectHangTimer.timedOut()) throw firstResponseTimeoutError();
          throw retryErr instanceof LLMError
            ? retryErr
            : new LLMError(retryErr instanceof Error ? retryErr.message : String(retryErr), 'network_error', { retryable: true, retryAfterMs: 2000 });
        }
        if (!localServer) connectHangTimer.clear();
        if (!response.ok) {
          connectHangTimer.clear();
          throw classifyError(response.status, await response.text(), [options.apiKey]);
        }
        // Retry succeeded — surface the discovered limit so the caller can
        // persist it. Next request will use the correct value pre-emptively.
        options.onMaxTokensLimitDiscovered?.(retryLimit);
      } else {
        throw classifyError(response.status, errorText, [options.apiKey]);
      }
    }

    const reader = response.body?.getReader();
    if (!reader) {
      connectHangTimer.clear();
      throw new Error('No response body');
    }

    // Idle timeout: if no data received within the window, treat as a network
    // hang. Aborting streamAbort rejects the pending reader.read() so chat()
    // can actually return; the catch below turns it into a retryable LLMError.
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

    // 正文里的 <think> 与写成文字的操作交给共用解析器（textToolCalls.ts），Ollama 适配器也用它
    const textParser = createTextToolCallParser(options.tools ?? []);
    /** Collected text-based tool calls */
    const textToolCalls: TextToolCall[] = [];

    function handleTextSegments(segments: TextSegment[]) {
      for (const segment of segments) {
        switch (segment.type) {
          case 'text':
            onEvent({ type: 'text', text: segment.text });
            break;
          case 'thinking':
            onEvent({ type: 'thinking', thinking: segment.thinking });
            break;
          case 'tool_call':
            textToolCalls.push(segment.call);
            break;
          case 'malformed':
            onEvent({ type: 'malformed_tool_call', raw: segment.raw });
            break;
        }
      }
    }

    function emitContent(chunk: string) {
      handleTextSegments(textParser.push(chunk));
    }

    /** Flush any remaining buffered content */
    function flushPendingContent() {
      handleTextSegments(textParser.flush());
    }

    /** Emit all buffered text-based tool calls as tool_use events */
    function emitTextToolCalls(): boolean {
      if (textToolCalls.length === 0) return false;
      for (const tc of textToolCalls) {
        onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      return true;
    }

    // 本地服务的空闲计时从第一段输出才开始，之前由 connectHangTimer 的 10 分钟管着
    let outputStarted = false;
    try {
      if (!localServer) heartbeat.reset();
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        if (!outputStarted) {
          outputStarted = true;
          connectHangTimer.clear();
        }
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
            if (typeof parsed.model === 'string') recorder.noteServedModel(parsed.model);
            if (parsed.usage) {
              // OpenAI 协议的 usage 是一次性的尾部结算，不是逐块累计。
              recorder.observeUsage(parsed.usage as Record<string, unknown>, 'final');
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
            } else if (choice.finish_reason === 'stop' || choice.finish_reason === 'stop_sequence') {
              // Emit text-based <tool_call> tool calls if any were buffered.
              // 'stop_sequence' is a stop-word match (some providers e.g. Together AI);
              // treat identically to 'stop'.
              const hasTextTC = emitTextToolCalls();
              if (hasTextTC) {
                onEvent({ type: 'done', stopReason: 'tool_use' });
              } else {
                onEvent({ type: 'done', stopReason: 'end_turn' });
              }
              doneEmitted = true;
            } else if (choice.finish_reason === 'length') {
              // Model output reached max_tokens. Tool calls arrive via two paths —
              // native (toolCallBuffers) and text-tag <tool_call> blocks
              // (textToolCalls). The text parser only buffers FULLY-CLOSED blocks,
              // so any buffered text tool call is complete. Sub-cases:
              //   (a) A complete tool call exists (native fully parsed, or text-tag)
              //       → emit it and signal tool_use. A decided, complete action runs.
              //   (b) A native tool call is present but partial / unparseable → DROP
              //       the broken tool calls and signal max_tokens so agentLoop's
              //       escalateMaxOutputTokens can double the limit and retry. Keeping
              //       the broken tool call would set collectedToolCalls.length > 0 and
              //       bypass the escalation trigger condition (agentLoop.ts L1284).
              //   (c) No tool calls at all (plain text truncated) → signal max_tokens.
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
                // Case (a), native: all native tool args complete despite truncation.
                for (const e of parsedAll) {
                  onEvent({ type: 'tool_use', id: e.id, name: e.name, input: e.input });
                }
                // Also flush any complete text-tag tool calls (same completeness invariant).
                emitTextToolCalls();
                onEvent({ type: 'done', stopReason: 'tool_use' });
              } else if (anyParseFailed) {
                // Case (b): a native tool call is truncated — drop everything and escalate.
                logger.warn('finish_reason=length, dropping tool calls for escalation', {
                  toolCallCount: toolCallBuffers.size,
                  partials: Array.from(toolCallBuffers.values()).map((t) => ({
                    name: t.name,
                    argsLength: t.args.length,
                    argsPreview: t.args.slice(0, LOG_TOOL_ARG_PREVIEW),
                  })),
                });
                onEvent({ type: 'done', stopReason: 'max_tokens' });
              } else {
                // No native tool calls. Emit any COMPLETE text-tag tool call before
                // escalating — dropping a fully-parsed <tool_call> here (case (a) for
                // the text path) would lose a decided action and force a needless
                // max_tokens retry. Only escalate when there is nothing executable.
                const hasTextTC = emitTextToolCalls();
                onEvent({ type: 'done', stopReason: hasTextTC ? 'tool_use' : 'max_tokens' });
              }
              doneEmitted = true;
            } else if (
              choice.finish_reason === 'content_filter' ||
              choice.finish_reason === 'refusal'
            ) {
              // Content was filtered or the model refused. Flush any COMPLETED tool
              // calls (dropping malformed/partial ones — same invariant as the length
              // branch) then close the stream cleanly. stopReason 'end_turn' is the
              // closest existing value — no dedicated moderation reason exists.
              const hasNativeTC = emitParseableToolCalls(toolCallBuffers, onEvent);
              const hasTextTC = emitTextToolCalls();
              const hasToolCalls = hasNativeTC || hasTextTC;
              logger.warn('content filtered or refused by provider', {
                finish_reason: choice.finish_reason,
              });
              observeCompatEvent({
                kind: 'content_filtered',
                modelId: options.model,
                requestHost,
                finishReason: choice.finish_reason as string,
              });
              onEvent({ type: 'done', stopReason: hasToolCalls ? 'tool_use' : 'end_turn' });
              doneEmitted = true;
            } else if (choice.finish_reason === 'error') {
              // Provider sent finish_reason='error' inside the stream (rare but seen
              // on some self-hosted endpoints). A provider may stream a full tool call
              // then close with 'error', so flush completed tool calls (dropping
              // malformed ones) before finishing. We do NOT throw here — throwing from
              // inside the SSE per-line try/catch would be swallowed and leave
              // doneEmitted=false, causing a duplicate done in the stream-end fallback.
              // Conservative path: flush + done + log.
              const hasNativeTC = emitParseableToolCalls(toolCallBuffers, onEvent);
              const hasTextTC = emitTextToolCalls();
              const hasToolCalls = hasNativeTC || hasTextTC;
              logger.warn('provider signalled error via finish_reason', {
                finish_reason: choice.finish_reason,
                hasToolCalls,
              });
              observeCompatEvent({
                kind: 'error_finish_reason',
                modelId: options.model,
                requestHost,
                finishReason: choice.finish_reason as string,
              });
              onEvent({ type: 'done', stopReason: hasToolCalls ? 'tool_use' : 'end_turn' });
              doneEmitted = true;
            } else if (choice.finish_reason) {
              // Unknown finish_reason — log so we can diagnose new providers.
              // Best-effort: flush any COMPLETED buffered tool calls (dropping
              // malformed ones, same invariant as the length branch) so callers
              // receive them, then emit a terminal done to prevent the stream hanging.
              const hadBufferedToolCalls = toolCallBuffers.size > 0;
              logger.warn('unknown finish_reason', {
                finish_reason: choice.finish_reason,
                hasToolCalls: hadBufferedToolCalls,
              });
              observeCompatEvent({
                kind: hadBufferedToolCalls ? 'dropped_tool_calls' : 'unknown_finish_reason',
                modelId: options.model,
                requestHost,
                finishReason: choice.finish_reason as string,
                ...(hadBufferedToolCalls ? { toolCallCount: toolCallBuffers.size } : {}),
              });
              const hasNativeTC = emitParseableToolCalls(toolCallBuffers, onEvent);
              const hasTextTC = emitTextToolCalls();
              const hasToolCalls = hasNativeTC || hasTextTC;
              onEvent({ type: 'done', stopReason: hasToolCalls ? 'tool_use' : 'end_turn' });
              doneEmitted = true;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Fallback: stream ended without [DONE] or finish_reason — emit pending text, tool calls and done
      if (!doneEmitted) {
        flushPendingContent();
        for (const [, tc] of toolCallBuffers) {
          const input = buildToolInput(tc, 'stream-end-fallback');
          onEvent({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        const hasTextTC = emitTextToolCalls();
        onEvent({ type: 'done', stopReason: toolCallBuffers.size > 0 || hasTextTC ? 'tool_use' : 'end_turn' });
      }
    } catch (streamErr) {
      // 本地服务响应头到了但 10 分钟内没有第一段输出：与响应头没到同样处理，不重试
      if (connectHangTimer.timedOut()) throw firstResponseTimeoutError();
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
      connectHangTimer.clear();
      heartbeat.clear();
      reader.releaseLock();
    }
  }
}
