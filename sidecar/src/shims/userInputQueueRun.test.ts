/**
 * userInputQueueRun.ts — P1-3B-4's real forwarding shim: wraps the REAL
 * `src/core/agent/userInputQueue.ts` module (imported directly here, same
 * "test the shim against the real underlying module" discipline
 * `lifecycleHooksRun.test.ts` uses for `agentRunContext`) and adds the
 * `input.consumed` notify side effect to `drainQueuedInputs`/
 * `clearInputQueue`, resolved via the ambient `agentRunContext` ALS, and the
 * `input.steeringEnded` notify to `endSteeringRun`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import * as rpcClient from '../rpcClient';
import {
  enqueueUserInput,
  enqueueUserInputWithId,
  getQueuedInputs,
  removeQueuedInput,
  hasQueuedInputs,
  hasSystemQueuedInputs,
  drainQueuedInputs,
  drainSystemQueuedInputs,
  clearInputQueue,
  restoreSteeringInputs,
  takeSteeringInputs,
  beginSteeringRun,
  endSteeringRun,
  requeueUserInput,
} from './userInputQueueRun';

function makeAgentCtx(overrides?: Partial<AgentRunContext>): AgentRunContext {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    chatDelta: {} as AgentRunContext['chatDelta'],
    conversationReader: {} as AgentRunContext['conversationReader'],
    executionPort: {} as AgentRunContext['executionPort'],
    abortRegistry: {} as AgentRunContext['abortRegistry'],
    scratchpadPort: {} as AgentRunContext['scratchpadPort'],
    capsPort: {} as AgentRunContext['capsPort'],
    workspaceReader: {} as AgentRunContext['workspaceReader'],
    toolInvoker: {} as AgentRunContext['toolInvoker'],
    resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false },
    locale: 'en-US',
    pushFrame: () => {},
    ...overrides,
  };
}

const CONV = 'conv-shim-test';

describe('userInputQueueRun shim', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearInputQueue(CONV); // real clearInputQueue — resets the underlying real module's state between tests
  });

  describe('pass-through re-exports (real behavior, unchanged)', () => {
    it('enqueueUserInput / getQueuedInputs / hasQueuedInputs behave exactly like the real module', () => {
      expect(hasQueuedInputs(CONV)).toBe(false);
      enqueueUserInput(CONV, 'hello');
      expect(hasQueuedInputs(CONV)).toBe(true);
      expect(getQueuedInputs(CONV).map((qi) => qi.text)).toEqual(['hello']);
    });

    it('enqueueUserInputWithId preserves the caller id through the shim', () => {
      enqueueUserInputWithId(CONV, 'preserved-id', 'staged');
      expect(getQueuedInputs(CONV)[0].id).toBe('preserved-id');
    });

    it('requeueUserInput puts a hand-off back through the shim', () => {
      requeueUserInput(CONV, { id: 'back', text: 'x', timestamp: 1, delivery: 'steer', runId: 'run-old' });
      expect(getQueuedInputs(CONV).map((qi) => [qi.id, qi.delivery])).toEqual([['back', undefined]]);
    });

    it('removeQueuedInput removes by id through the shim', () => {
      enqueueUserInputWithId(CONV, 'to-remove', 'x');
      removeQueuedInput(CONV, 'to-remove');
      expect(getQueuedInputs(CONV)).toHaveLength(0);
    });
  });

  describe('drainQueuedInputs — consumed-notify', () => {
    it('drains the real queue AND notifies input.consumed with the drained ids, inside a run context', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      enqueueUserInputWithId(CONV, 'q1', 'one');
      enqueueUserInputWithId(CONV, 'q2', 'two');

      const drained = agentRunContext.run(makeAgentCtx({ runId: 'run-42', conversationId: CONV }), () =>
        drainQueuedInputs(CONV),
      );

      expect(drained.map((qi) => qi.text)).toEqual(['one', 'two']);
      expect(getQueuedInputs(CONV)).toHaveLength(0); // real queue actually drained
      expect(spy).toHaveBeenCalledWith('input.consumed', { runId: 'run-42', queueIds: ['q1', 'q2'] });
    });

    it('does not notify when nothing was queued (empty drain)', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      agentRunContext.run(makeAgentCtx({ runId: 'run-42', conversationId: CONV }), () => drainQueuedInputs(CONV));
      expect(spy).not.toHaveBeenCalled();
    });

    it('defensively no-ops the notify (but still drains) when called OUTSIDE an agentRunContext scope', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      enqueueUserInputWithId(CONV, 'q1', 'one');

      const drained = drainQueuedInputs(CONV); // no agentRunContext.run(...) wrapper

      expect(drained.map((qi) => qi.text)).toEqual(['one']);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('drainSystemQueuedInputs — selective consumed-notify', () => {
    it('notifies only system ids and leaves user follow-ups queued', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      enqueueUserInputWithId(CONV, 'user-1', 'later');
      enqueueUserInputWithId(CONV, 'system-1', 'background result', true);

      const drained = agentRunContext.run(
        makeAgentCtx({ runId: 'run-42', conversationId: CONV }),
        () => drainSystemQueuedInputs(CONV),
      );

      expect(drained.map((item) => item.id)).toEqual(['system-1']);
      expect(hasSystemQueuedInputs(CONV)).toBe(false);
      expect(getQueuedInputs(CONV).map((item) => item.id)).toEqual(['user-1']);
      expect(spy).toHaveBeenCalledWith('input.consumed', { runId: 'run-42', queueIds: ['system-1'] });
    });
  });

  describe('clearInputQueue — consumed-notify', () => {
    it('clears the real queue AND notifies input.consumed with the ids that were cleared', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      enqueueUserInputWithId(CONV, 'c1', 'one');
      enqueueUserInputWithId(CONV, 'c2', 'two');

      agentRunContext.run(makeAgentCtx({ runId: 'run-99', conversationId: CONV }), () => clearInputQueue(CONV));

      expect(getQueuedInputs(CONV)).toHaveLength(0);
      expect(spy).toHaveBeenCalledWith('input.consumed', { runId: 'run-99', queueIds: ['c1', 'c2'] });
    });

    it('does not notify when the queue was already empty', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      agentRunContext.run(makeAgentCtx({ runId: 'run-99', conversationId: CONV }), () => clearInputQueue(CONV));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('takeSteeringInputs — asks the shell, which owns the queue', () => {
    it('sends input.takeSteering for the ambient run and returns the shell\'s items as steering entries', async () => {
      const spy = vi.spyOn(rpcClient, 'sendRequest').mockResolvedValue({
        items: [
          { id: 'q1', text: '改成蓝色', timestamp: 10 },
          { id: 'q2', text: '再加一页', timestamp: 11 },
        ],
      });

      const taken = await agentRunContext.run(makeAgentCtx({ runId: 'run-7', conversationId: CONV }), () =>
        takeSteeringInputs(CONV, 'run-1'),
      );

      expect(spy).toHaveBeenCalledExactlyOnceWith('input.takeSteering', { runId: 'run-7' });
      expect(taken).toEqual([
        { id: 'q1', text: '改成蓝色', timestamp: 10, delivery: 'steer' },
        { id: 'q2', text: '再加一页', timestamp: 11, delivery: 'steer' },
      ]);
    });

    it('never touches the sidecar\'s own queue: a user entry staged here is neither taken nor sent', async () => {
      vi.spyOn(rpcClient, 'sendRequest').mockResolvedValue({ items: [] });
      enqueueUserInput(CONV, 'local only');
      const taken = await agentRunContext.run(makeAgentCtx({ conversationId: CONV }), () => takeSteeringInputs(CONV, 'run-1'));
      expect(taken).toEqual([]);
      expect(getQueuedInputs(CONV).map((item) => item.text)).toEqual(['local only']);
    });

    it('outside a run context takes nothing and sends nothing', async () => {
      const spy = vi.spyOn(rpcClient, 'sendRequest');
      await expect(takeSteeringInputs(CONV, 'run-1')).resolves.toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('a failed request takes nothing instead of failing the step', async () => {
      vi.spyOn(rpcClient, 'sendRequest').mockRejectedValue(new Error('Shell request "input.takeSteering" timed out'));
      const taken = await agentRunContext.run(makeAgentCtx({ conversationId: CONV }), () => takeSteeringInputs(CONV, 'run-1'));
      expect(taken).toEqual([]);
    });

    it('drops malformed items and malformed replies', async () => {
      const spy = vi.spyOn(rpcClient, 'sendRequest');
      spy.mockResolvedValueOnce({
        items: [
          { id: 'ok', text: 'keep', timestamp: 1 },
          { id: '', text: 'no id', timestamp: 1 },
          { id: 'blank', text: '   ', timestamp: 1 },
          { id: 'no-time', text: 'x' },
          'not an object',
          null,
        ],
      });
      spy.mockResolvedValueOnce(null);
      spy.mockResolvedValueOnce({ items: 'nope' });
      const run = () => agentRunContext.run(makeAgentCtx({ conversationId: CONV }), () => takeSteeringInputs(CONV, 'run-1'));

      expect((await run()).map((item) => item.id)).toEqual(['ok']);
      expect(await run()).toEqual([]);
      expect(await run()).toEqual([]);
    });

    it('restoreSteeringInputs is a no-op here (the shell restores what never arrived)', () => {
      const notify = vi.spyOn(rpcClient, 'sendNotification');
      const request = vi.spyOn(rpcClient, 'sendRequest');
      agentRunContext.run(makeAgentCtx({ conversationId: CONV }), () =>
        restoreSteeringInputs(CONV, [{ id: 'q1', text: 'x', timestamp: 1, delivery: 'steer' }]),
      );
      expect(getQueuedInputs(CONV)).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('the run\'s steering: the shell binds, the loop tells it when it stops reading', () => {
    it('beginSteeringRun updates this copy only and tells the shell nothing', () => {
      const notify = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      agentRunContext.run(makeAgentCtx({ runId: 'run-3', conversationId: CONV }), () => beginSteeringRun(CONV, 'run-3'));
      expect(enqueueUserInput(CONV, 'typed here')?.runId).toBe('run-3');
      expect(notify).not.toHaveBeenCalled();
    });

    it('endSteeringRun releases this copy\'s entries and tells the shell for the ambient run', () => {
      const notify = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      beginSteeringRun(CONV, 'run-3');
      enqueueUserInput(CONV, 'typed here');

      agentRunContext.run(makeAgentCtx({ runId: 'run-3', conversationId: CONV }), () => endSteeringRun(CONV, 'run-3'));

      expect(notify).toHaveBeenCalledExactlyOnceWith('input.steeringEnded', { runId: 'run-3' });
      expect(getQueuedInputs(CONV).map((item) => item.delivery)).toEqual([undefined]);
    });

    it('endSteeringRun outside a run context tells the shell nothing', () => {
      const notify = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      endSteeringRun(CONV, 'run-3');
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
