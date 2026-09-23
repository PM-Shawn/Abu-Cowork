import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const writeLineMock = vi.fn();
vi.mock('./protocol', () => ({
  writeLine: (...a: unknown[]) => writeLineMock(...a),
}));

import {
  sendRequest,
  sendNotification,
  resolvePendingResponse,
  rejectAllPendingRequests,
  setPreRequestFlush,
  REVERSE_RPC_DEFAULT_TIMEOUT_MS,
  HOOK_EMIT_TIMEOUT_MS,
  UNBOUNDED_REVERSE_RPC_METHODS,
} from './rpcClient';

/** The id of the most recently written request line. */
function lastSentId(): string {
  return (writeLineMock.mock.calls.at(-1)![0] as { id: string }).id;
}

describe('rpcClient', () => {
  beforeEach(() => {
    // #549: every request now arms a timer. Fake timers keep a pending
    // request from rejecting minutes later, inside an unrelated test.
    vi.useFakeTimers();
    writeLineMock.mockClear();
    setPreRequestFlush(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('sendRequest / resolvePendingResponse round trip', () => {
    it('mints a string id and resolves on a matching response', async () => {
      const promise = sendRequest('tool.invoke', { foo: 'bar' });
      expect(writeLineMock).toHaveBeenCalledTimes(1);
      const sentLine = writeLineMock.mock.calls[0][0] as { id: string; method: string };
      expect(typeof sentLine.id).toBe('string');
      expect(sentLine.method).toBe('tool.invoke');

      resolvePendingResponse(sentLine.id, { ok: true });
      await expect(promise).resolves.toEqual({ ok: true });
    });

    it('rejects on a matching error response', async () => {
      const promise = sendRequest('tool.invoke', {});
      const sentLine = writeLineMock.mock.calls[0][0] as { id: string };
      resolvePendingResponse(sentLine.id, undefined, { code: -32000, message: 'boom' });
      await expect(promise).rejects.toThrow('boom');
    });

    it('unknown/late/duplicate ids are silently ignored (no throw)', () => {
      expect(() => resolvePendingResponse('never-sent', 'whatever')).not.toThrow();
    });
  });

  describe('rejectAllPendingRequests', () => {
    it('rejects every pending outbound request', async () => {
      const p1 = sendRequest('a', {});
      const p2 = sendRequest('b', {});
      rejectAllPendingRequests(new Error('shutdown'));
      await expect(p1).rejects.toThrow('shutdown');
      await expect(p2).rejects.toThrow('shutdown');
    });
  });

  describe('setPreRequestFlush hook (design doc §3 flush-before-request discipline)', () => {
    it('zero behavior when unset — sendRequest works exactly as before', () => {
      expect(() => void sendRequest('m', {}).catch(() => {})).not.toThrow();
      expect(writeLineMock).toHaveBeenCalledTimes(1);
    });

    it('invokes the hook BEFORE the request line is written (order-observable)', () => {
      const order: string[] = [];
      writeLineMock.mockImplementation(() => order.push('write'));
      setPreRequestFlush(() => order.push('flush'));

      void sendRequest('agent.abort', {}).catch(() => {});

      expect(order).toEqual(['flush', 'write']);
    });

    it('is invoked once per sendRequest call', () => {
      const flushSpy = vi.fn();
      setPreRequestFlush(flushSpy);

      void sendRequest('a', {}).catch(() => {});
      void sendRequest('b', {}).catch(() => {});

      expect(flushSpy).toHaveBeenCalledTimes(2);
    });

    it('notifications do NOT trigger the flush hook', () => {
      const flushSpy = vi.fn();
      setPreRequestFlush(flushSpy);

      sendNotification('agent.delta', { frames: [] });

      expect(flushSpy).not.toHaveBeenCalled();
      expect(writeLineMock).toHaveBeenCalledTimes(1);
    });

    it('can be cleared by passing undefined', () => {
      const flushSpy = vi.fn();
      setPreRequestFlush(flushSpy);
      setPreRequestFlush(undefined);

      void sendRequest('a', {}).catch(() => {});

      expect(flushSpy).not.toHaveBeenCalled();
    });
  });

  describe('#549 reverse-RPC timeout', () => {
    it('rejects a bounded request after 60s and ignores a late response', async () => {
      const promise = sendRequest('tool.list', {});
      const assertion = expect(promise).rejects.toMatchObject({ code: 'reverse_rpc_timeout' });
      await vi.advanceTimersByTimeAsync(REVERSE_RPC_DEFAULT_TIMEOUT_MS);
      await assertion;
      expect(() => resolvePendingResponse(lastSentId(), [])).not.toThrow();
    });

    it('keeps user/tool-duration methods unbounded', async () => {
      for (const method of ['tool.invoke', 'native.invoke', 'approval.check']) {
        expect(UNBOUNDED_REVERSE_RPC_METHODS.has(method)).toBe(true);
        let settled = false;
        const promise = sendRequest(method, {});
        void promise.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(settled).toBe(false);
        resolvePendingResponse(lastSentId(), 'ok');
        await expect(promise).resolves.toBe('ok');
      }
    });

    it('bounds hook.emit at 10 minutes (R11 — the hook bus itself is unbounded)', async () => {
      expect(UNBOUNDED_REVERSE_RPC_METHODS.has('hook.emit')).toBe(false);
      expect(HOOK_EMIT_TIMEOUT_MS).toBe(10 * 60_000);
      const promise = sendRequest('hook.emit', {});
      const assertion = expect(promise).rejects.toMatchObject({ code: 'reverse_rpc_timeout' });
      await vi.advanceTimersByTimeAsync(REVERSE_RPC_DEFAULT_TIMEOUT_MS);
      expect(vi.getTimerCount()).toBe(1); // still pending well past the default
      await vi.advanceTimersByTimeAsync(HOOK_EMIT_TIMEOUT_MS);
      await assertion;
    });

    it('clears the timer when a response arrives', async () => {
      const promise = sendRequest('workspace.authorizedWritablePaths', {});
      resolvePendingResponse(lastSentId(), ['/a']);
      await expect(promise).resolves.toEqual(['/a']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears every timer when all pending requests are rejected', async () => {
      const p1 = sendRequest('tool.list', {});
      const p2 = sendRequest('hook.emit', {});
      rejectAllPendingRequests(new Error('shutdown'));
      await expect(p1).rejects.toThrow('shutdown');
      await expect(p2).rejects.toThrow('shutdown');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
