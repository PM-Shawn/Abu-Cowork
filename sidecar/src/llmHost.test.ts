import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, StreamEvent } from '@/types';
import type { ChatOptions } from '@/core/llm/adapter';
import { LLMError } from '@/core/llm/adapter';
import { RpcError } from './protocol';

// Fakes let each test script the adapter's chat() behavior (emit events,
// respect abort, resolve/reject) without touching the real Anthropic SDK /
// fetch — mirrors the sidecarAdapter.test.ts pattern of mocking the seam.
const claudeChat = vi.fn();
const openaiChat = vi.fn();

// Plain `function` (not an arrow) — `createAdapter()` instantiates these via
// `new`, and arrow functions can't be used as constructors.
vi.mock('@/core/llm/claude', () => ({
  ClaudeAdapter: vi.fn().mockImplementation(function ClaudeAdapter() { return { chat: claudeChat }; }),
}));
vi.mock('@/core/llm/openai-compatible', () => ({
  OpenAICompatibleAdapter: vi.fn().mockImplementation(function OpenAICompatibleAdapter() { return { chat: openaiChat }; }),
}));

import { createLlmHost, type SidecarRpcSender } from './llmHost';

function makeSender() {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const sender: SidecarRpcSender = {
    notify: (method, params) => notifications.push({ method, params }),
  };
  return { sender, notifications };
}

function chatParams(overrides: Partial<{ callId: string; adapterKind: string; messages: Message[]; options: unknown }> = {}) {
  return {
    callId: 'call-1',
    adapterKind: 'claude',
    messages: [] as Message[],
    options: { model: 'claude-x', apiKey: 'k' },
    ...overrides,
  };
}

describe('llmHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    claudeChat.mockReset();
    openaiChat.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('param validation', () => {
    it.each([
      ['non-object params', 42],
      ['missing callId', { adapterKind: 'claude', messages: [], options: {} }],
      ['empty callId', { callId: '', adapterKind: 'claude', messages: [], options: {} }],
      ['bad adapterKind', { callId: 'c', adapterKind: 'bogus', messages: [], options: {} }],
      ['messages not array', { callId: 'c', adapterKind: 'claude', messages: 'nope', options: {} }],
      ['options not object', { callId: 'c', adapterKind: 'claude', messages: [], options: null }],
    ])('rejects %s with RpcError -32602', async (_label, params) => {
      const { sender } = makeSender();
      const host = createLlmHost(sender);
      await expect(host.handleChat(params)).rejects.toMatchObject({ code: -32602 });
    });

    it('handleAbort with invalid params throws RpcError -32602', () => {
      const { sender } = makeSender();
      const host = createLlmHost(sender);
      expect(() => host.handleAbort({})).toThrow(RpcError);
      expect(() => host.handleAbort(42)).toThrow(RpcError);
    });
  });

  describe('chat lifecycle', () => {
    it('resolves { ok: true } once the adapter chat() promise resolves, after emitting llm.event notifications in order', async () => {
      claudeChat.mockImplementation(async (_messages: Message[], _options: ChatOptions, onEvent: (e: StreamEvent) => void) => {
        onEvent({ type: 'tool_use', id: 't1', name: 'foo', input: {} });
        onEvent({ type: 'done', stopReason: 'end_turn' });
      });

      const { sender, notifications } = makeSender();
      const host = createLlmHost(sender);
      const result = await host.handleChat(chatParams());

      expect(result).toEqual({ ok: true });
      const events = notifications.filter((n) => n.method === 'llm.event');
      expect(events).toHaveLength(2);
      expect(events[0].params).toMatchObject({ callId: 'call-1', seq: 0, event: { type: 'tool_use', id: 't1' } });
      expect(events[1].params).toMatchObject({ callId: 'call-1', seq: 1, event: { type: 'done', stopReason: 'end_turn' } });
    });

    it('routes adapterKind to the matching adapter constructor', async () => {
      claudeChat.mockResolvedValue(undefined);
      openaiChat.mockResolvedValue(undefined);
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      await host.handleChat(chatParams({ callId: 'c1', adapterKind: 'claude' }));
      expect(claudeChat).toHaveBeenCalledTimes(1);
      expect(openaiChat).not.toHaveBeenCalled();

      await host.handleChat(chatParams({ callId: 'c2', adapterKind: 'openai-compatible' }));
      expect(openaiChat).toHaveBeenCalledTimes(1);
    });

    it('coalesces rapid text deltas within the ~16ms window before emitting', async () => {
      claudeChat.mockImplementation(async (_m: Message[], _o: ChatOptions, onEvent: (e: StreamEvent) => void) => {
        onEvent({ type: 'text', text: 'Hel' });
        onEvent({ type: 'text', text: 'lo' });
        // Give the fake-timer-driven flush a chance before resolving —
        // real adapters stream over ticks; here we simulate the delay.
        await Promise.resolve();
        onEvent({ type: 'done', stopReason: 'end_turn' });
      });

      const { sender, notifications } = makeSender();
      const host = createLlmHost(sender);
      const promise = host.handleChat(chatParams());
      await promise;

      const events = notifications.filter((n) => n.method === 'llm.event').map((n) => n.params as { event: StreamEvent });
      // The two text deltas must have merged into ONE 'Hello' event — 'done'
      // is non-mergeable and forces the flush, so we never see a bare 'Hel'.
      expect(events.map((e) => e.event)).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });

    it('forwards onMaxTokensLimitDiscovered as an llm.chatMeta notification', async () => {
      claudeChat.mockImplementation(async (_m: Message[], options: ChatOptions) => {
        options.onMaxTokensLimitDiscovered?.(8192);
      });
      const { sender, notifications } = makeSender();
      const host = createLlmHost(sender);
      await host.handleChat(chatParams());

      const meta = notifications.find((n) => n.method === 'llm.chatMeta');
      expect(meta?.params).toEqual({ callId: 'call-1', kind: 'maxTokensLimitDiscovered', limit: 8192 });
    });

    it('rejects a second llm.chat with the same callId while the first is still active', async () => {
      let releaseFirst: (() => void) | undefined;
      claudeChat.mockImplementation(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      const first = host.handleChat(chatParams({ callId: 'dup' }));
      await expect(host.handleChat(chatParams({ callId: 'dup' }))).rejects.toMatchObject({ code: -32602 });

      releaseFirst?.();
      await first;
    });
  });

  describe('error serialization', () => {
    it('an LLMError thrown by the adapter surfaces as RpcError -32000 with reconstructable data', async () => {
      claudeChat.mockRejectedValue(new LLMError('rate limited', 'rate_limit', { retryable: true, retryAfterMs: 5000 }));
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      await expect(host.handleChat(chatParams())).rejects.toMatchObject({
        code: -32000,
        data: { name: 'LLMError', code: 'rate_limit', retryable: true, retryAfterMs: 5000, message: 'rate limited' },
      });
    });

    it('preserves bounded upstream error details in the legacy llm.chat RPC error', async () => {
      const upstream = {
        status: 403,
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'llm-host-trace-403',
        summary: 'The content safety system rejected the request.',
      } as const;
      claudeChat.mockRejectedValue(new LLMError(upstream.summary, 'content_policy', {
        retryable: false,
        statusCode: 403,
        rawBody: '{"must":"not cross the llm RPC"}',
        upstream,
      }));
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      await expect(host.handleChat(chatParams())).rejects.toMatchObject({
        code: -32000,
        data: {
          name: 'LLMError',
          code: 'content_policy',
          retryable: false,
          statusCode: 403,
          message: upstream.summary,
          upstream,
        },
      });
      await expect(host.handleChat(chatParams())).rejects.not.toMatchObject({
        data: expect.objectContaining({ rawBody: expect.anything() }),
      });
    });

    it('does not put a message-less JSON provider body in the outer RPC error message', async () => {
      const rawBody = '{"private":"credential-adjacent provider metadata"}';
      claudeChat.mockRejectedValue(new LLMError(rawBody, 'authentication', {
        retryable: false,
        statusCode: 403,
        rawBody,
        upstream: { status: 403 },
      }));
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      await expect(host.handleChat(chatParams())).rejects.toMatchObject({
        code: -32000,
        message: 'HTTP 403 · authentication',
        data: expect.objectContaining({
          message: 'HTTP 403 · authentication',
          upstream: { status: 403 },
        }),
      });
      await expect(host.handleChat(chatParams())).rejects.not.toMatchObject({
        message: expect.stringContaining('private'),
      });
    });

    it('fresh-projects a mutated LLMError upstream object before writing RPC data', async () => {
      const error = new LLMError('safe provider failure', 'unknown');
      error.upstream = {
        status: 403,
        rawBody: 'private prompt text',
      } as never;
      claudeChat.mockRejectedValue(error);
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      let caught: unknown;
      try {
        await host.handleChat(chatParams());
      } catch (err) {
        caught = err;
      }

      expect(caught).toMatchObject({
        code: -32000,
        message: 'safe provider failure',
        data: expect.objectContaining({ message: 'safe provider failure' }),
      });
      expect((caught as { data?: { upstream?: unknown } }).data?.upstream).toBeUndefined();
      expect(JSON.stringify(caught)).not.toContain('rawBody');
      expect(JSON.stringify(caught)).not.toContain('private prompt text');
    });

    it('a non-LLMError thrown by the adapter still serializes name/message (no code/retryable)', async () => {
      claudeChat.mockRejectedValue(new TypeError('boom'));
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      await expect(host.handleChat(chatParams())).rejects.toMatchObject({
        code: -32000,
        data: { name: 'TypeError', message: 'boom' },
      });
    });

    it('flushes any pending coalesced delta before rejecting on error (stream-end flush covers the error path too)', async () => {
      claudeChat.mockImplementation(async (_m: Message[], _o: ChatOptions, onEvent: (e: StreamEvent) => void) => {
        onEvent({ type: 'text', text: 'partial' });
        throw new LLMError('boom', 'unknown');
      });
      const { sender, notifications } = makeSender();
      const host = createLlmHost(sender);

      await expect(host.handleChat(chatParams())).rejects.toBeInstanceOf(RpcError);
      const events = notifications.filter((n) => n.method === 'llm.event');
      expect(events).toHaveLength(1);
      expect(events[0].params).toMatchObject({ event: { type: 'text', text: 'partial' } });
    });
  });

  describe('abort', () => {
    it('handleAbort aborts the matching active call\'s signal', async () => {
      let seenSignal: AbortSignal | undefined;
      claudeChat.mockImplementation((_m: Message[], options: ChatOptions) => {
        seenSignal = options.signal;
        return new Promise<void>(() => {}); // never resolves — we only check abort propagation
      });
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      void host.handleChat(chatParams({ callId: 'abortme' }));
      await Promise.resolve(); // let handleChat reach adapter.chat()
      expect(seenSignal?.aborted).toBe(false);

      host.handleAbort({ callId: 'abortme' });
      expect(seenSignal?.aborted).toBe(true);
    });

    it('handleAbort on an unknown callId is a silent no-op', () => {
      const { sender } = makeSender();
      const host = createLlmHost(sender);
      expect(() => host.handleAbort({ callId: 'does-not-exist' })).not.toThrow();
    });

    it('shutdownAll aborts every active call', async () => {
      const signals: AbortSignal[] = [];
      claudeChat.mockImplementation((_m: Message[], options: ChatOptions) => {
        signals.push(options.signal!);
        return new Promise<void>(() => {});
      });
      const { sender } = makeSender();
      const host = createLlmHost(sender);

      void host.handleChat(chatParams({ callId: 'a' }));
      void host.handleChat(chatParams({ callId: 'b' }));
      await Promise.resolve();
      await Promise.resolve();

      expect(signals).toHaveLength(2);
      host.shutdownAll();
      expect(signals.every((s) => s.aborted)).toBe(true);
    });
  });
});
