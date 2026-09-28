import type { ChatOptions, LLMAdapter } from './adapter';
import { LLMError, classifyError, isContextOverflowMessage } from './adapter';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import { getTauriFetch } from './tauriFetch';
import { normalizeMessages, type PreparedContentBlock, type PreparedTurn } from './messageNormalizer';
import { createHeartbeat, anySignal, DEFAULT_STREAM_HANG_TIMEOUT_MS } from './heartbeat';
import { createDefaultUsageRecorder, type UsageAttemptRecorder } from './usageRecorder';
import { createTextToolCallParser, type TextSegment, type TextToolCall } from './textToolCalls';
import { ollamaApiRoot } from './contextWindowProbe';
import { DOCUMENT_UNSUPPORTED_NOTE, TOOL_RESULT_IMAGES_NOTE } from './openai-compatible';

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

interface OllamaChatChunk {
  model?: string;
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  error?: string;
}

let ollamaToolCallCounter = 0;
function nextOllamaToolCallId(): string {
  ollamaToolCallCounter += 1;
  return `ollama-tc-${Date.now().toString(36)}-${ollamaToolCallCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function userMessage(blocks: PreparedContentBlock[]): OllamaMessage {
  const content = blocks
    .map((block) => (block.type === 'text' ? block.text : block.type === 'document' ? DOCUMENT_UNSUPPORTED_NOTE : ''))
    .join('');
  const images = blocks.flatMap((block) => (block.type === 'image' ? [block.data] : []));
  return images.length > 0 ? { role: 'user', content, images } : { role: 'user', content };
}

/** 归一化后的对话转成 Ollama /api/chat 的消息格式。 */
export function toOllamaMessages(turns: PreparedTurn[], systemPrompt?: string, volatileTail?: string): OllamaMessage[] {
  const result: OllamaMessage[] = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
  for (const turn of turns) {
    if (turn.kind === 'user') {
      result.push(userMessage(turn.content));
      continue;
    }
    const assistant: OllamaMessage = { role: 'assistant', content: turn.text };
    if (turn.thinking) assistant.thinking = turn.thinking;
    if (turn.toolCalls.length > 0) {
      assistant.tool_calls = turn.toolCalls.map((call) => ({ id: call.id, function: { name: call.name, arguments: call.input } }));
    }
    result.push(assistant);
    const images: string[] = [];
    for (const call of turn.toolCalls) {
      result.push({ role: 'tool', content: call.result, tool_name: call.name, tool_call_id: call.id });
      images.push(...call.resultImages.map((image) => image.data));
    }
    if (images.length > 0) result.push({ role: 'user', content: TOOL_RESULT_IMAGES_NOTE, images });
  }
  if (volatileTail) result.push({ role: 'user', content: volatileTail });
  return result;
}

function toOllamaTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

/** 流式中途的错误没有状态码：超长类的按 400 分类，其余按服务端错误。 */
function streamError(message: string): LLMError {
  return classifyError(isContextOverflowMessage(message) ? 400 : 500, JSON.stringify({ error: { message } }));
}

function idleTimeoutError(): LLMError {
  return new LLMError(`连接空闲超时：${DEFAULT_STREAM_HANG_TIMEOUT_MS / 1000} 秒未收到任何数据`, 'network_error', { retryable: true });
}

/**
 * Ollama 原生接口适配器。OpenAI 兼容接口不转发上下文长度，Ollama 会按显存给默认值
 * 并从最早的消息开始静默丢弃；这里每次请求都带 options.num_ctx。
 */
export class OllamaNativeAdapter implements LLMAdapter {
  async chat(messages: Message[], options: ChatOptions, emitEvent: (event: StreamEvent) => void): Promise<void> {
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
      await this.stream(messages, options, onEvent, recorder);
    } catch (err) {
      recorder.settle(options.signal?.aborted ? 'cancelled' : 'failed');
      throw err;
    } finally {
      recorder.settle('interrupted');
    }
  }

  private async stream(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void,
    recorder: UsageAttemptRecorder,
  ): Promise<void> {
    if (options.contextWindow === undefined) {
      throw new LLMError('Ollama request is missing its context window', 'invalid_request', { retryable: false });
    }
    if (!options.baseUrl) {
      throw new LLMError('Ollama request is missing its address', 'invalid_request', { retryable: false });
    }
    const hasTools = !!options.tools?.length && options.declaredCapabilities?.supportsTools !== false;
    const turns = normalizeMessages(messages, { supportsVision: options.supportsVision !== false });
    const body: Record<string, unknown> = {
      model: options.model,
      messages: toOllamaMessages(turns, options.systemPrompt, options.volatileContextTail),
      stream: true,
      options: {
        num_ctx: options.contextWindow,
        num_predict: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
      },
      ...(hasTools ? { tools: toOllamaTools(options.tools!) } : {}),
    };

    const fetchFn = await getTauriFetch();
    const streamAbort = new AbortController();
    const signal = options.signal ? anySignal([options.signal, streamAbort.signal]) : streamAbort.signal;
    let connectTimedOut = false;
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      streamAbort.abort();
    }, DEFAULT_STREAM_HANG_TIMEOUT_MS);
    let response: Response;
    recorder.beginAttempt();
    try {
      response = await fetchFn(`${ollamaApiRoot(options.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (fetchErr) {
      if (connectTimedOut) {
        throw new LLMError(`连接超时：${DEFAULT_STREAM_HANG_TIMEOUT_MS / 1000} 秒未收到服务器响应头`, 'network_error', {
          retryable: true,
          retryAfterMs: 2000,
        });
      }
      throw new LLMError(fetchErr instanceof Error ? fetchErr.message : String(fetchErr), 'network_error', {
        retryable: true,
        retryAfterMs: 2000,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) throw classifyError(response.status, await response.text());
    const reader = response.body?.getReader();
    if (!reader) throw new LLMError('Ollama returned no response body', 'network_error', { retryable: true });

    let idleTimedOut = false;
    const heartbeat = createHeartbeat(DEFAULT_STREAM_HANG_TIMEOUT_MS, () => {
      idleTimedOut = true;
      streamAbort.abort();
    });
    const parser = createTextToolCallParser(options.tools ?? []);
    const textToolCalls: TextToolCall[] = [];
    const nativeToolCalls: TextToolCall[] = [];
    const handleSegments = (segments: TextSegment[]): void => {
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
    };

    let finished = false;
    const handleLine = (line: string): void => {
      const chunk = JSON.parse(line) as OllamaChatChunk;
      if (typeof chunk.error === 'string') throw streamError(chunk.error);
      if (typeof chunk.model === 'string') recorder.noteServedModel(chunk.model);
      if (chunk.message?.thinking) onEvent({ type: 'thinking', thinking: chunk.message.thinking });
      if (chunk.message?.content) handleSegments(parser.push(chunk.message.content));
      for (const call of chunk.message?.tool_calls ?? []) {
        nativeToolCalls.push({ id: call.id || nextOllamaToolCallId(), name: call.function.name, input: call.function.arguments ?? {} });
      }
      if (!chunk.done) return;
      finished = true;
      handleSegments(parser.flush());
      const cached = typeof chunk.prompt_eval_cached_count === 'number' ? chunk.prompt_eval_cached_count : undefined;
      const wire = {
        prompt_tokens: chunk.prompt_eval_count ?? 0,
        completion_tokens: chunk.eval_count ?? 0,
        ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
      };
      // 最后一帧的计数就是这次请求的结算，按 OpenAI 口径（prompt_tokens 已含缓存）记账
      recorder.observeUsage(wire, 'final');
      onEvent({
        type: 'usage',
        usage: {
          inputTokens: wire.prompt_tokens,
          outputTokens: wire.completion_tokens,
          ...(cached !== undefined ? { cacheReadInputTokens: cached } : {}),
        },
      });
      const calls = [...nativeToolCalls, ...textToolCalls];
      for (const call of calls) onEvent({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      onEvent({
        type: 'done',
        stopReason: calls.length > 0 ? 'tool_use' : chunk.done_reason === 'length' ? 'max_tokens' : 'end_turn',
      });
    };

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      heartbeat.reset();
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        heartbeat.reset();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) handleLine(line.trim());
          if (finished) break;
        }
      }
      if (!finished && buffer.trim()) handleLine(buffer.trim());
      if (!finished) {
        throw new LLMError('Ollama stream ended before it finished', 'network_error', { retryable: true });
      }
    } catch (streamErr) {
      if (idleTimedOut) throw idleTimeoutError();
      if (streamErr instanceof LLMError) throw streamErr;
      throw new LLMError(streamErr instanceof Error ? streamErr.message : String(streamErr), 'network_error', { retryable: true });
    } finally {
      heartbeat.clear();
      reader.releaseLock();
    }
  }
}
