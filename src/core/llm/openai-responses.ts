/**
 * OpenAI Responses API support (issue #86).
 *
 * gpt-5.5 on official OpenAI rejects /v1/chat/completions when a request
 * carries function tools + reasoning_effort. This module implements detection,
 * request-body building, and SSE-stream parsing for the /v1/responses endpoint
 * whose wire format differs from chat/completions in three ways:
 *   1. `input` (not `messages`) for conversation history
 *   2. `reasoning.effort` (not top-level `reasoning_effort`)
 *   3. Flat tool schema: {type,name,description,parameters} not {type,function:{...}}
 */

import type { Message, StreamEvent, TokenUsage, ToolCall, ToolCallForContext } from '../../types';
import type { ChatOptions, ToolChoice } from './adapter';
import { classifyError } from './adapter';

// ─── Detection ────────────────────────────────────────────────────────

/**
 * Returns true iff the host is exactly api.openai.com (case-insensitive).
 * Regex anchors the host segment to prevent prefix/suffix spoofing like
 * api.openai.com.evil.com.
 */
export function isOpenAIOfficialEndpoint(baseUrl: string): boolean {
  if (!baseUrl) return false;
  return /^https?:\/\/api\.openai\.com(?:[:/]|$)/i.test(baseUrl.trim());
}

/** Returns true for gpt-5.5 and its dated/alias variants only (not gpt-5 or gpt-5.1). */
export function isGpt55Model(model: string): boolean {
  return /gpt-?5\.5/i.test(model);
}

/** Routes to /responses only for gpt-5.5 on the official OpenAI endpoint. */
export function shouldUseResponsesApi(baseUrl: string, model: string): boolean {
  return isOpenAIOfficialEndpoint(baseUrl) && isGpt55Model(model);
}

// ─── Tool choice ──────────────────────────────────────────────────────

/**
 * Convert Abu's ToolChoice to the Responses API form.
 * The Responses API uses a flat {type:'function', name} for specific-tool
 * forcing — no nested `function` wrapper like chat/completions.
 */
export function toResponsesToolChoice(
  tc: ToolChoice | undefined,
): 'auto' | 'required' | { type: 'function'; name: string } | undefined {
  if (tc === undefined) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  return { type: 'function', name: tc.name };
}

// ─── Usage extraction ─────────────────────────────────────────────────

/**
 * Map the Responses API usage object to Abu's TokenUsage.
 * Field names differ from chat/completions (input_tokens vs prompt_tokens).
 */
export function extractResponsesUsage(usage: Record<string, unknown>): TokenUsage {
  const inputTokens = (usage.input_tokens as number) ?? 0;
  const outputTokens = (usage.output_tokens as number) ?? 0;
  const details = usage.input_tokens_details as Record<string, unknown> | undefined;
  const cached =
    details && typeof details.cached_tokens === 'number' ? details.cached_tokens : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cached !== undefined ? { cacheReadInputTokens: cached } : {}),
  };
}

// ─── Input serialization ──────────────────────────────────────────────

// Matches the note in openai-compatible.ts serializeForOpenAI so both paths
// give the model the same screenshot instruction when tool results contain images.
const SCREENSHOT_NOTE =
  '[SCREENSHOT] Tool results produced these screenshot(s). You MUST describe what you actually see in the image before deciding next action. If you cannot see the image, say "I cannot see the screenshot" — do NOT guess or fabricate what is on screen.';

const ORPHAN_PLACEHOLDER = '[Tool execution was interrupted]';

/**
 * Serialize Message[] into Responses API input items.
 *
 * Serializes directly from messages (not via PreparedTurn) to preserve the
 * original tool call IDs in function_call / function_call_output items. The
 * Responses API uses call_id as a correlation key across turns, so the
 * ID from the original ToolCall must survive into the history.
 */
function serializeInput(messages: Message[], supportsVision: boolean): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        if (msg.content) {
          items.push({ role: 'user', content: [{ type: 'input_text', text: msg.content }] });
        }
      } else {
        const parts: Record<string, unknown>[] = [];
        for (const c of msg.content) {
          if (c.type === 'text') {
            if (c.text) parts.push({ type: 'input_text', text: c.text });
          } else if (c.type === 'image' && supportsVision) {
            parts.push({
              type: 'input_image',
              image_url: `data:${c.source.media_type};base64,${c.source.data}`,
            });
          }
          // Documents: no Responses API equivalent — omit silently
        }
        if (parts.length > 0) {
          items.push({ role: 'user', content: parts });
        }
      }
    } else if (msg.role === 'assistant') {
      // Extract assistant text — content is typically a plain string in Abu
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .map((c) => (c.type === 'text' ? c.text : ''))
              .join('');

      // Emit assistant text item (omit thinking/reasoning — Responses API spec)
      if (text.trim()) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      }

      // Prefer toolCallsForContext for LLM history (mirrors messageNormalizer logic)
      const toolCallsSource: Array<ToolCall | ToolCallForContext> =
        msg.toolCallsForContext ?? msg.toolCalls ?? [];

      const pendingImages: Array<{ mediaType: string; data: string }> = [];
      for (const tc of toolCallsSource) {
        const callId = tc.id ?? `call_anon_${Date.now()}`;
        const result = tc.result ?? ORPHAN_PLACEHOLDER;

        items.push({
          type: 'function_call',
          call_id: callId,
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        });
        items.push({ type: 'function_call_output', call_id: callId, output: result });

        // Collect tool result images for a follow-up user item
        if (supportsVision && tc.resultContent) {
          for (const b of tc.resultContent) {
            if (b.type === 'image') {
              pendingImages.push({ mediaType: b.source.media_type, data: b.source.data });
            }
          }
        }
      }

      // Responses API doesn't support images inside function_call_output — same
      // constraint as chat/completions — so emit a user item with the screenshots
      if (pendingImages.length > 0) {
        items.push({
          role: 'user',
          content: [
            { type: 'input_text', text: SCREENSHOT_NOTE },
            ...pendingImages.map((img) => ({
              type: 'input_image',
              image_url: `data:${img.mediaType};base64,${img.data}`,
            })),
          ],
        });
      }
    }
  }

  return items;
}

// ─── Request body ─────────────────────────────────────────────────────

/**
 * Build the POST body for /v1/responses.
 *
 * Key differences from /v1/chat/completions that triggered the rejection:
 *   - `input` not `messages`
 *   - `max_output_tokens` not `max_tokens`
 *   - `reasoning.effort` not top-level `reasoning_effort`
 *   - Flat tool schema, not nested under `function`
 */
export function buildResponsesBody(
  messages: Message[],
  options: ChatOptions,
): Record<string, unknown> {
  const supportsVision = options.supportsVision !== false;

  const body: Record<string, unknown> = {
    model: options.model,
    stream: true,
    max_output_tokens: options.maxTokens ?? 4096,
    input: serializeInput(messages, supportsVision),
  };

  if (options.systemPrompt) {
    body.instructions = options.systemPrompt;
  }

  // reasoning.effort is the Responses API counterpart of the chat/completions
  // top-level reasoning_effort field — the latter is what causes the 400
  if (options.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort };
  }

  if (options.tools?.length) {
    // Flat tool shape — no nested `function` wrapper
    body.tools = options.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
    const tc = toResponsesToolChoice(options.toolChoice);
    if (tc !== undefined) {
      body.tool_choice = tc;
    }
  }

  return body;
}

// ─── SSE parser ───────────────────────────────────────────────────────

/**
 * Parse a tool-call arguments string into a Record.
 * - Empty string → {} (valid; schema validation surfaces missing required fields)
 * - Non-object parse result → {} (defensive)
 * - Unparseable JSON → null (caller marks _parse_error)
 */
function safeParseToolArgs(s: string): Record<string, unknown> | null {
  if (!s || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  } catch {
    return null;
  }
}

interface PendingCall {
  callId: string;
  name: string;
  args: string;
}

/**
 * Create a stateful SSE event mapper for the /v1/responses stream.
 *
 * The Responses API uses typed SSE events (response.output_text.delta,
 * response.function_call_arguments.delta, etc.) rather than choices[].delta
 * objects. The parser accumulates function call arguments across delta events
 * and emits StreamEvent values on each semantic boundary.
 */
export function createResponsesParser(
  onEvent: (e: StreamEvent) => void,
): { handle(obj: Record<string, unknown>): void; end(): void } {
  // Pending function calls keyed by output-item id (e.g. "fc_1")
  const pending = new Map<string, PendingCall>();
  // Prevents double-done if both response.completed and end() are reached
  let terminal = false;

  function flushToolCalls(): boolean {
    if (pending.size === 0) return false;
    for (const [, call] of pending) {
      const parsed = safeParseToolArgs(call.args);
      const input: Record<string, unknown> =
        parsed !== null
          ? parsed
          : { _parse_error: `Failed to parse tool input: ${call.args.slice(0, 200)}` };
      onEvent({ type: 'tool_use', id: call.callId, name: call.name, input });
    }
    return true;
  }

  function handle(obj: Record<string, unknown>): void {
    if (terminal) return;
    const evType = obj.type as string;

    if (evType === 'response.output_text.delta') {
      onEvent({ type: 'text', text: obj.delta as string });
      return;
    }

    if (evType === 'response.reasoning_summary_text.delta') {
      onEvent({ type: 'thinking', thinking: obj.delta as string });
      return;
    }

    if (evType === 'response.output_item.added') {
      const item = obj.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call') {
        // Key by item.id (output-item id); the call_id is the API-level correlation key
        pending.set(item.id as string, {
          callId: item.call_id as string,
          name: item.name as string,
          args: '',
        });
      }
      return;
    }

    if (evType === 'response.function_call_arguments.delta') {
      const itemId = obj.item_id as string;
      const delta = (obj.delta as string) ?? '';
      const existing = pending.get(itemId);
      if (existing) {
        existing.args += delta;
      } else {
        // Delta arrived before output_item.added — create a lazy entry
        pending.set(itemId, { callId: '', name: '', args: delta });
      }
      return;
    }

    if (evType === 'response.function_call_arguments.done') {
      const itemId = obj.item_id as string;
      const existing = pending.get(itemId);
      if (existing) {
        // Authoritative complete args override the accumulated deltas
        existing.args = (obj.arguments as string) ?? existing.args;
      }
      return;
    }

    if (evType === 'response.output_item.done') {
      const item = obj.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call') {
        const itemId = item.id as string;
        const existing = pending.get(itemId);
        if (existing) {
          // Reconcile any fields that may have been missed in earlier events
          if (!existing.callId) existing.callId = item.call_id as string;
          if (!existing.name) existing.name = item.name as string;
          if (!existing.args) existing.args = (item.arguments as string) ?? '';
        } else {
          pending.set(itemId, {
            callId: item.call_id as string,
            name: item.name as string,
            args: (item.arguments as string) ?? '',
          });
        }
      }
      return;
    }

    if (evType === 'response.completed') {
      const resp = obj.response as Record<string, unknown> | undefined;
      if (resp?.usage) {
        onEvent({
          type: 'usage',
          usage: extractResponsesUsage(resp.usage as Record<string, unknown>),
        });
      }
      const hadToolCalls = flushToolCalls();
      onEvent({ type: 'done', stopReason: hadToolCalls ? 'tool_use' : 'end_turn' });
      terminal = true;
      return;
    }

    if (evType === 'response.incomplete') {
      const resp = obj.response as Record<string, unknown> | undefined;
      const incompleteDetails = resp?.incomplete_details as Record<string, unknown> | undefined;
      const reason = incompleteDetails?.reason as string | undefined;

      if (resp?.usage) {
        onEvent({
          type: 'usage',
          usage: extractResponsesUsage(resp.usage as Record<string, unknown>),
        });
      }

      if (reason === 'max_output_tokens' && pending.size > 0) {
        // If every pending call's args parse cleanly the model may have finished
        // the JSON right at the limit — emit as tool_use. Otherwise drop broken
        // calls and signal max_tokens so agentLoop can escalate the token budget.
        const cleanParsed: Array<{ callId: string; name: string; input: Record<string, unknown> }> =
          [];
        let allClean = true;
        for (const [, call] of pending) {
          const parsed = safeParseToolArgs(call.args);
          if (parsed === null) {
            allClean = false;
            break;
          }
          cleanParsed.push({ callId: call.callId, name: call.name, input: parsed });
        }
        if (allClean) {
          for (const e of cleanParsed) {
            onEvent({ type: 'tool_use', id: e.callId, name: e.name, input: e.input });
          }
          onEvent({ type: 'done', stopReason: 'tool_use' });
        } else {
          onEvent({ type: 'done', stopReason: 'max_tokens' });
        }
      } else {
        onEvent({
          type: 'done',
          stopReason: reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn',
        });
      }
      terminal = true;
      return;
    }

    if (evType === 'response.failed') {
      const resp = obj.response as Record<string, unknown> | undefined;
      const err = resp?.error as Record<string, unknown> | undefined;
      // classifyError extracts message from JSON and returns a typed LLMError
      throw classifyError(500, JSON.stringify(err ?? {}));
    }
  }

  function end(): void {
    if (terminal) return;
    const hadToolCalls = flushToolCalls();
    onEvent({ type: 'done', stopReason: hadToolCalls ? 'tool_use' : 'end_turn' });
    terminal = true;
  }

  return { handle, end };
}
