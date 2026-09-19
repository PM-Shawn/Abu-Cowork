import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegateProgressRecorder,
  DELEGATE_DRAIN_MAX_ATTEMPTS,
  DELEGATE_DRAIN_POLL_MS,
} from './delegateProgressRecorder';

function makeRecorder(resolveParentStepId: () => string | undefined, onSettle = vi.fn()) {
  const addChildStepToDelegate = vi.fn((_loopId: string, _parent: string, payload: { toolCallId?: string }) => `child-${payload.toolCallId}`);
  const completeChildStep = vi.fn();
  const recorder = createDelegateProgressRecorder({
    loopCtx: { loopId: 'loop-1', eventRouter: { addChildStepToDelegate, completeChildStep } as never },
    resolveParentStepId,
    batchTask: { index: 2, label: 'member task', agent: 'research' },
    onSettle,
    logLabel: 'test',
  });
  return { recorder, addChildStepToDelegate, completeChildStep, onSettle };
}

describe('createDelegateProgressRecorder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('queues events until the parent step resolves, then records them in order with the batch tag', async () => {
    const parent: { stepId?: string } = {};
    const { recorder, addChildStepToDelegate, completeChildStep, onSettle } = makeRecorder(() => parent.stepId);

    recorder.record({ type: 'tool-start', id: 't1', toolName: 'web_search', toolInput: { query: 'q' } });
    recorder.record({ type: 'turn-complete', turn: 1, totalTurns: 5 });
    recorder.record({ type: 'tool-end', id: 't1', toolName: 'web_search', result: 'no key', error: true });
    expect(addChildStepToDelegate).not.toHaveBeenCalled();

    parent.stepId = 'parent-step';
    await recorder.drain();

    expect(addChildStepToDelegate).toHaveBeenCalledWith('loop-1', 'parent-step', {
      toolName: 'web_search',
      toolInput: { query: 'q' },
      toolCallId: 't1',
      batchTask: { index: 2, label: 'member task', agent: 'research' },
    });
    expect(completeChildStep).toHaveBeenCalledWith('loop-1', 'parent-step', 'child-t1', 'no key', true, undefined);
    expect(addChildStepToDelegate.mock.invocationCallOrder[0]).toBeLessThan(completeChildStep.mock.invocationCallOrder[0]);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded drain when the parent step never appears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const { recorder, addChildStepToDelegate, onSettle } = makeRecorder(() => undefined);

    recorder.record({ type: 'tool-start', id: 't1', toolName: 'read_file', toolInput: {} });
    const drained = recorder.drain();
    await vi.advanceTimersByTimeAsync(DELEGATE_DRAIN_POLL_MS * (DELEGATE_DRAIN_MAX_ATTEMPTS + 1));
    await drained;

    expect(addChildStepToDelegate).not.toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops queued events on settle and leaves no retry timer armed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const parent: { stepId?: string } = {};
    const { recorder, addChildStepToDelegate } = makeRecorder(() => parent.stepId);

    recorder.record({ type: 'tool-start', id: 't1', toolName: 'read_file', toolInput: {} });
    recorder.settle();
    parent.stepId = 'parent-step';
    vi.runAllTimers();

    expect(addChildStepToDelegate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
