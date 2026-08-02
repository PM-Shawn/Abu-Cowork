import { describe, it, expect, vi, beforeEach } from 'vitest';

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
} from './rpcClient';

describe('rpcClient', () => {
  beforeEach(() => {
    writeLineMock.mockClear();
    setPreRequestFlush(undefined);
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
      expect(() => sendRequest('m', {})).not.toThrow();
      expect(writeLineMock).toHaveBeenCalledTimes(1);
    });

    it('invokes the hook BEFORE the request line is written (order-observable)', () => {
      const order: string[] = [];
      writeLineMock.mockImplementation(() => order.push('write'));
      setPreRequestFlush(() => order.push('flush'));

      sendRequest('agent.abort', {});

      expect(order).toEqual(['flush', 'write']);
    });

    it('is invoked once per sendRequest call', () => {
      const flushSpy = vi.fn();
      setPreRequestFlush(flushSpy);

      sendRequest('a', {});
      sendRequest('b', {});

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

      sendRequest('a', {});

      expect(flushSpy).not.toHaveBeenCalled();
    });
  });
});
