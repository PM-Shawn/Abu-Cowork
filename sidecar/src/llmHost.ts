/**
 * LLM host — sidecar-side handler for the `llm.chat` / `llm.abort` protocol
 * extension (P1-1). Instantiates the real `ClaudeAdapter` /
 * `OpenAICompatibleAdapter` (bundled straight from `src/core/llm`, shimmed
 * only at their Tauri/logging/observability leaves — see
 * `scripts/build-sidecar.mjs`) and drives them exactly as the shell used to
 * drive them in-process. The JSON-RPC REQUEST for `llm.chat` settles only
 * once the whole stream completes (or errors); progress is reported via the
 * `llm.event` NOTIFICATION stream, coalesced through `eventCoalescer.ts`.
 *
 * Exported as a factory (`createLlmHost`) taking a `sender` so this module is
 * testable without spawning a real process — main.ts wires it to
 * `protocol.ts`'s `writeLine`.
 */

import type { Message, StreamEvent } from '@/types';
import type { ChatOptions, LLMAdapter, AdapterKind } from '@/core/llm/adapter';
import { LLMError } from '@/core/llm/adapter';
import { ClaudeAdapter } from '@/core/llm/claude';
import { OpenAICompatibleAdapter } from '@/core/llm/openai-compatible';
import { createEventCoalescer } from './eventCoalescer';
import { RpcError } from './protocol';
import { createLogger } from './shims/logger';

const logger = createLogger('llmHost');

/** ~16ms sender-side coalescing window — see eventCoalescer.ts module doc. */
const COALESCE_WINDOW_MS = 16;

/** ChatOptions minus the two non-JSON-serializable members (signal, callback) — see ChatOptions in adapter.ts. */
export type SerializableChatOptions = Omit<ChatOptions, 'signal' | 'onMaxTokensLimitDiscovered'>;

export interface LlmChatParams {
  callId: string;
  adapterKind: AdapterKind;
  messages: Message[];
  options: SerializableChatOptions;
}

export interface LlmAbortParams {
  callId: string;
}

export interface SidecarRpcSender {
  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params: unknown): void;
}

interface ActiveCall {
  controller: AbortController;
  coalescer: ReturnType<typeof createEventCoalescer>;
  timer: ReturnType<typeof setTimeout> | null;
  seq: number;
}

export interface LlmHost {
  handleChat(params: unknown): Promise<{ ok: true }>;
  handleAbort(params: unknown): void;
  /** Abort every in-flight call — used by the `shutdown` notification handler before exit. */
  shutdownAll(): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseChatParams(params: unknown): LlmChatParams {
  if (!isRecord(params)) throw new RpcError(-32602, 'Invalid params: expected object');
  const { callId, adapterKind, messages, options } = params;
  if (typeof callId !== 'string' || !callId) {
    throw new RpcError(-32602, 'Invalid params: callId must be a non-empty string');
  }
  if (adapterKind !== 'claude' && adapterKind !== 'openai-compatible') {
    throw new RpcError(-32602, 'Invalid params: adapterKind must be "claude" or "openai-compatible"');
  }
  if (!Array.isArray(messages)) {
    throw new RpcError(-32602, 'Invalid params: messages must be an array');
  }
  if (!isRecord(options)) {
    throw new RpcError(-32602, 'Invalid params: options must be an object');
  }
  return {
    callId,
    adapterKind,
    messages: messages as Message[],
    options: options as unknown as SerializableChatOptions,
  };
}

function parseAbortParams(params: unknown): LlmAbortParams {
  if (!isRecord(params) || typeof params.callId !== 'string') {
    throw new RpcError(-32602, 'Invalid params: callId must be a string');
  }
  return { callId: params.callId };
}

function createAdapter(kind: AdapterKind): LLMAdapter {
  return kind === 'claude' ? new ClaudeAdapter() : new OpenAICompatibleAdapter();
}

/** Reconstruct the `data` payload the shell's SidecarLLMAdapter uses to rebuild a faithful LLMError. */
function errorDataFor(err: unknown): { name: string; code?: string; retryable?: boolean; retryAfterMs?: number; message: string } {
  if (err instanceof LLMError) {
    return {
      name: 'LLMError',
      code: err.code,
      retryable: err.retryable,
      retryAfterMs: err.retryAfterMs,
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : 'Error';
  return { name, message };
}

export function createLlmHost(sender: SidecarRpcSender): LlmHost {
  const activeCalls = new Map<string, ActiveCall>();

  function emit(call: ActiveCall, callId: string, event: StreamEvent): void {
    sender.notify('llm.event', { callId, seq: call.seq++, event });
  }

  function emitAll(call: ActiveCall, callId: string, events: StreamEvent[]): void {
    for (const event of events) emit(call, callId, event);
  }

  function armFlushTimer(call: ActiveCall, callId: string): void {
    if (call.timer) return; // already scheduled — the pure coalescer already merged into the same pending slot
    call.timer = setTimeout(() => {
      call.timer = null;
      emitAll(call, callId, call.coalescer.flush());
    }, COALESCE_WINDOW_MS);
  }

  function clearFlushTimer(call: ActiveCall): void {
    if (call.timer) {
      clearTimeout(call.timer);
      call.timer = null;
    }
  }

  /** Final defensive flush + timer teardown once the adapter's chat() promise settles (success or throw). */
  function drain(call: ActiveCall, callId: string): void {
    clearFlushTimer(call);
    emitAll(call, callId, call.coalescer.flush());
  }

  async function handleChat(rawParams: unknown): Promise<{ ok: true }> {
    const params = parseChatParams(rawParams);
    const { callId } = params;

    if (activeCalls.has(callId)) {
      // Defensive — callId is generated shell-side and should never collide,
      // but a colliding id would otherwise silently clobber the earlier call's state.
      throw new RpcError(-32602, `Invalid params: callId "${callId}" is already active`);
    }

    const controller = new AbortController();
    const call: ActiveCall = { controller, coalescer: createEventCoalescer(), timer: null, seq: 0 };
    activeCalls.set(callId, call);

    const onEvent = (event: StreamEvent): void => {
      const toEmit = call.coalescer.push(event);
      emitAll(call, callId, toEmit);
      if (call.coalescer.hasPending()) {
        armFlushTimer(call, callId);
      } else {
        clearFlushTimer(call);
      }
    };

    const adapterOptions: ChatOptions = {
      ...params.options,
      signal: controller.signal,
      onMaxTokensLimitDiscovered: (limit: number) => {
        sender.notify('llm.chatMeta', { callId, kind: 'maxTokensLimitDiscovered', limit });
      },
    };

    try {
      const adapter = createAdapter(params.adapterKind);
      await adapter.chat(params.messages, adapterOptions, onEvent);
      drain(call, callId);
      return { ok: true };
    } catch (err) {
      drain(call, callId);
      logger.warn('llm.chat failed', { callId, error: err instanceof Error ? err.message : String(err) });
      throw new RpcError(-32000, err instanceof Error ? err.message : String(err), errorDataFor(err));
    } finally {
      activeCalls.delete(callId);
    }
  }

  function handleAbort(rawParams: unknown): void {
    const { callId } = parseAbortParams(rawParams);
    const call = activeCalls.get(callId);
    if (!call) return; // unknown callId (already finished, or never existed) — silent no-op per spec
    call.controller.abort();
  }

  function shutdownAll(): void {
    for (const call of activeCalls.values()) {
      call.controller.abort();
    }
  }

  return { handleChat, handleAbort, shutdownAll };
}

/** Exported for tests that want the raw window constant without importing internals. */
export const __COALESCE_WINDOW_MS = COALESCE_WINDOW_MS;
