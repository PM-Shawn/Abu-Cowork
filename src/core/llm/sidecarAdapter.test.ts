import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamEvent } from '../../types';
import { formatLlmTerminalError, LLMError } from './adapter';

// Fake pub/sub + request/notify surface for sidecarManager — lets tests fire
// llm.event/llm.chatMeta notifications and control what request() does,
// without touching the real Tauri invoke bridge. SidecarRpcError is kept
// REAL (via importActual) so `instanceof SidecarRpcError` in
// sidecarAdapter.ts's reconstructError() behaves exactly as in production.
// Everything the `vi.mock` factory below references must come from
// `vi.hoisted()` — vitest hoists `vi.mock` calls above all other top-level
// code (including plain `const`), so a factory that closes over an ordinary
// module-scope variable hits a TDZ ReferenceError at mock-registration time.
type NotificationHandler = (params: unknown) => void;

const { notificationHandlers, requestMock, notifySidecarMock, onSidecarNotificationMock, fire } = vi.hoisted(() => {
  const handlers = new Map<string, NotificationHandler[]>();
  const onSidecarNotification = vi.fn((method: string, handler: NotificationHandler) => {
    const list = handlers.get(method) ?? [];
    list.push(handler);
    handlers.set(method, list);
    return () => {
      const current = handlers.get(method);
      if (!current) return;
      handlers.set(method, current.filter((h) => h !== handler));
    };
  });
  return {
    notificationHandlers: handlers,
    requestMock: vi.fn(),
    notifySidecarMock: vi.fn(),
    onSidecarNotificationMock: onSidecarNotification,
    fire: (method: string, params: unknown) => {
      for (const h of handlers.get(method) ?? []) h(params);
    },
  };
});

vi.mock('../sidecar/sidecarManager', async () => {
  const actual = await vi.importActual<typeof import('../sidecar/sidecarManager')>('../sidecar/sidecarManager');
  return {
    SidecarRpcError: actual.SidecarRpcError,
    request: requestMock,
    notifySidecar: notifySidecarMock,
    onSidecarNotification: onSidecarNotificationMock,
  };
});

import { SidecarLLMAdapter } from './sidecarAdapter';
import { SidecarRpcError } from '../sidecar/sidecarManager';

describe('SidecarLLMAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestMock.mockReset();
    notifySidecarMock.mockReset();
    onSidecarNotificationMock.mockClear();
    notificationHandlers.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('event forwarding', () => {
    it('forwards llm.event notifications to onEvent in arrival order', async () => {
      // request() resolves only after we've fired both events, mirroring the
      // real protocol (response settles once the stream completes).
      requestMock.mockImplementation((_method: string, params: { callId: string }) => new Promise((resolve) => {
        queueMicrotask(() => {
          fire('llm.event', { callId: params.callId, seq: 0, event: { type: 'text', text: 'a' } });
          resolve({ ok: true });
        });
      }));

      const adapter = new SidecarLLMAdapter('claude');
      const events: StreamEvent[] = [];
      await adapter.chat([], { model: 'm', apiKey: 'k' }, (e) => events.push(e));
      expect(events).toEqual([{ type: 'text', text: 'a' }]);
    });

    it('filters notifications by callId so concurrent calls do not cross-talk', async () => {
      let capturedCallId1 = '';
      let capturedCallId2 = '';
      requestMock
        .mockImplementationOnce((_method: string, params: { callId: string }) => {
          capturedCallId1 = params.callId;
          return new Promise((resolve) => {
            queueMicrotask(() => {
              fire('llm.event', { callId: capturedCallId1, seq: 0, event: { type: 'text', text: 'one' } });
              fire('llm.event', { callId: 'someone-elses-call', seq: 0, event: { type: 'text', text: 'intruder' } });
              resolve({ ok: true });
            });
          });
        })
        .mockImplementationOnce((_method: string, params: { callId: string }) => {
          capturedCallId2 = params.callId;
          return Promise.resolve({ ok: true });
        });

      const adapter = new SidecarLLMAdapter('claude');
      const events: StreamEvent[] = [];
      await adapter.chat([], { model: 'm', apiKey: 'k' }, (e) => events.push(e));
      await adapter.chat([], { model: 'm', apiKey: 'k' }, () => {});

      expect(capturedCallId1).not.toBe(capturedCallId2);
      expect(events).toEqual([{ type: 'text', text: 'one' }]);
    });

    it('unsubscribes from notifications once chat() settles', async () => {
      requestMock.mockResolvedValue({ ok: true });
      const adapter = new SidecarLLMAdapter('claude');
      await adapter.chat([], { model: 'm', apiKey: 'k' }, () => {});

      expect(notificationHandlers.get('llm.event') ?? []).toHaveLength(0);
      expect(notificationHandlers.get('llm.chatMeta') ?? []).toHaveLength(0);
    });

    it('forwards onMaxTokensLimitDiscovered via llm.chatMeta', async () => {
      let callId = '';
      requestMock.mockImplementation((_method: string, params: { callId: string }) => {
        callId = params.callId;
        return new Promise((resolve) => {
          queueMicrotask(() => {
            fire('llm.chatMeta', { callId, kind: 'maxTokensLimitDiscovered', limit: 8192 });
            resolve({ ok: true });
          });
        });
      });

      const adapter = new SidecarLLMAdapter('claude');
      const discovered: number[] = [];
      await adapter.chat([], { model: 'm', apiKey: 'k', onMaxTokensLimitDiscovered: (l) => discovered.push(l) }, () => {});
      expect(discovered).toEqual([8192]);
    });

    it('does not throw on a seq gap — forwards the event anyway (logs a warning)', async () => {
      let callId = '';
      requestMock.mockImplementation((_method: string, params: { callId: string }) => {
        callId = params.callId;
        return new Promise((resolve) => {
          queueMicrotask(() => {
            fire('llm.event', { callId, seq: 0, event: { type: 'text', text: 'a' } });
            fire('llm.event', { callId, seq: 5, event: { type: 'text', text: 'gap!' } }); // gap: 1..4 skipped
            resolve({ ok: true });
          });
        });
      });

      const adapter = new SidecarLLMAdapter('claude');
      const events: StreamEvent[] = [];
      await expect(adapter.chat([], { model: 'm', apiKey: 'k' }, (e) => events.push(e))).resolves.toBeUndefined();
      expect(events).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'gap!' }]);
    });
  });

  describe('error reconstruction', () => {
    it('reconstructs a faithful LLMError from a SidecarRpcError carrying LLMError data', async () => {
      requestMock.mockRejectedValue(
        new SidecarRpcError(-32000, 'rate limited', {
          name: 'LLMError', code: 'rate_limit', retryable: true, retryAfterMs: 3000, message: 'rate limited',
        }),
      );
      const adapter = new SidecarLLMAdapter('claude');
      await expect(adapter.chat([], { model: 'm', apiKey: 'k' }, () => {})).rejects.toMatchObject({
        name: 'LLMError', code: 'rate_limit', retryable: true, retryAfterMs: 3000, message: 'rate limited',
      });
    });

    it('reconstructs status and upstream details without a raw provider body', async () => {
      const upstream = {
        status: 403,
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'sidecar-adapter-trace-403',
        summary: 'The content safety system rejected the request.',
      } as const;
      requestMock.mockRejectedValue(
        new SidecarRpcError(-32000, upstream.summary, {
          name: 'LLMError',
          code: 'content_policy',
          retryable: false,
          statusCode: 403,
          message: upstream.summary,
          upstream,
        }),
      );
      const adapter = new SidecarLLMAdapter('claude');

      await expect(adapter.chat([], { model: 'm', apiKey: 'k' }, () => {})).rejects.toMatchObject({
        code: 'content_policy',
        statusCode: 403,
        upstream,
        rawBody: undefined,
      });
    });

    it.each([
      '{"private":"legacy provider body"}',
      '<html><body>legacy proxy response</body></html>',
    ])('does not promote a legacy structured RPC message into terminal text: %s', async (message) => {
      requestMock.mockRejectedValue(
        new SidecarRpcError(-32000, message, {
          name: 'LLMError',
          code: 'authentication',
          retryable: false,
          message,
        }),
      );
      const adapter = new SidecarLLMAdapter('claude');

      const caught = await adapter.chat([], { model: 'm', apiKey: 'k' }, () => {}).catch((error) => error);
      expect(caught).toMatchObject({ code: 'authentication', retryable: false, message: 'authentication' });
      expect(formatLlmTerminalError(caught)).toBe('authentication');
      expect(JSON.stringify(caught)).not.toContain('legacy provider body');
      expect(JSON.stringify(caught)).not.toContain('legacy proxy response');
    });

    it.each([
      ['unknown code', { code: 'made_up', retryable: false }],
      ['content policy marked retryable', { code: 'content_policy', retryable: true }],
      ['network-blocked marked retryable', { code: 'network_blocked', retryable: true }],
      ['negative retry delay', { code: 'rate_limit', retryable: true, retryAfterMs: -1 }],
      ['invalid status', { code: 'authentication', retryable: false, statusCode: 403.5 }],
      ['content policy with 401 status', { code: 'content_policy', retryable: false, statusCode: 401, upstream: { status: 401 } }],
      ['rate limit with 403 status', { code: 'rate_limit', retryable: true, statusCode: 403, upstream: { status: 403 } }],
      ['unknown field', { code: 'authentication', retryable: false, rawBody: 'private' }],
    ])('rejects malformed LLM wire data: %s', async (_label, fields) => {
      requestMock.mockRejectedValue(new SidecarRpcError(-32000, 'untrusted', {
        name: 'LLMError',
        message: 'untrusted',
        ...fields,
      }));
      const adapter = new SidecarLLMAdapter('claude');

      await expect(adapter.chat([], { model: 'm', apiKey: 'k' }, () => {})).rejects.toMatchObject({
        code: 'unknown',
        retryable: false,
        message: 'Invalid sidecar LLM error response',
      });
    });

    it('a SidecarRpcError without LLMError-shaped data becomes a retryable network_error', async () => {
      requestMock.mockRejectedValue(new SidecarRpcError(-32603, 'Internal error', { name: 'TypeError', message: 'boom' }));
      const adapter = new SidecarLLMAdapter('claude');
      await expect(adapter.chat([], { model: 'm', apiKey: 'k' }, () => {})).rejects.toMatchObject({
        code: 'network_error', retryable: true,
      });
    });

    it('close-mid-stream (plain Error, not SidecarRpcError) surfaces as a retryable network_error', async () => {
      requestMock.mockRejectedValue(new Error('Sidecar process closed'));
      const adapter = new SidecarLLMAdapter('claude');
      await expect(adapter.chat([], { model: 'm', apiKey: 'k' }, () => {})).rejects.toMatchObject({
        code: 'network_error', retryable: true,
      });
      await expect(adapter.chat([], { model: 'm', apiKey: 'k' }, () => {})).rejects.toBeInstanceOf(LLMError);
    });

    it('sanitizes a structured plain transport Error before it reaches terminal formatting', async () => {
      requestMock.mockRejectedValue(new Error('{"private":"plain transport body"}'));
      const adapter = new SidecarLLMAdapter('claude');

      const caught = await adapter.chat([], { model: 'm', apiKey: 'k' }, () => {}).catch((error) => error);
      expect(caught).toMatchObject({ code: 'network_error', retryable: true, message: 'Sidecar transport failed' });
      expect(formatLlmTerminalError(caught)).toBe('Sidecar transport failed');
      expect(JSON.stringify(caught)).not.toContain('plain transport body');
    });
  });

  describe('abort', () => {
    it('throws immediately for an already-aborted signal, without calling request()', async () => {
      const controller = new AbortController();
      controller.abort();
      const adapter = new SidecarLLMAdapter('claude');
      await expect(adapter.chat([], { model: 'm', apiKey: 'k', signal: controller.signal }, () => {}))
        .rejects.toMatchObject({ code: 'cancelled' });
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('sends llm.abort when the signal aborts mid-flight', async () => {
      requestMock.mockImplementation(() => new Promise(() => {})); // never settles
      const controller = new AbortController();
      const adapter = new SidecarLLMAdapter('claude');

      const chatPromise = adapter.chat([], { model: 'm', apiKey: 'k', signal: controller.signal }, () => {});
      // Attach the rejection observer BEFORE advancing timers below — the
      // grace-timeout rejection races Node's unhandledRejection detector
      // against whenever a `.catch`/`.rejects` gets attached; anything that
      // leaves `chatPromise` unobserved while fake timers fire risks a false
      // "Promise rejection was handled asynchronously" failure even though
      // the assertion itself passes (matches the idiom already used in
      // sidecarManager.test.ts's "rejects a request that times out" case).
      const assertion = expect(chatPromise).rejects.toMatchObject({ code: 'cancelled' });
      await Promise.resolve();
      controller.abort();
      await Promise.resolve();

      expect(notifySidecarMock).toHaveBeenCalledWith('llm.abort', expect.objectContaining({ callId: expect.any(String) }));

      // Resolve the defensive grace timer path to let the test finish cleanly.
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    });

    it('the 5s defensive grace timer rejects with a cancelled LLMError if the sidecar never settles after abort', async () => {
      requestMock.mockImplementation(() => new Promise(() => {})); // permanently hung
      const controller = new AbortController();
      const adapter = new SidecarLLMAdapter('claude');

      const chatPromise = adapter.chat([], { model: 'm', apiKey: 'k', signal: controller.signal }, () => {});
      await Promise.resolve();
      controller.abort();

      await vi.advanceTimersByTimeAsync(4_999);
      // Not yet — grace period hasn't elapsed.
      let settled = false;
      chatPromise.catch(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(chatPromise).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    });

    it('does not arm the grace timer / send llm.abort if the request already resolved before abort fires', async () => {
      requestMock.mockResolvedValue({ ok: true });
      const controller = new AbortController();
      const adapter = new SidecarLLMAdapter('claude');
      await adapter.chat([], { model: 'm', apiKey: 'k', signal: controller.signal }, () => {});

      controller.abort(); // fires after chat() already settled — listener was removed in finally
      expect(notifySidecarMock).not.toHaveBeenCalled();
    });
  });
});
