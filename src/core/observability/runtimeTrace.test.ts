import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordElectronRuntimeEventMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/electronHost', () => ({
  recordElectronRuntimeEvent: (...args: unknown[]) => recordElectronRuntimeEventMock(...args),
}));

import {
  __resetRuntimeTraceForTests,
  finishRuntimeRun,
  getRendererRuntimeTraceSnapshot,
  markRuntimeRunStage,
  runtimeErrorType,
  startRuntimeRun,
  traceRuntimeEvent,
} from './runtimeTrace';

describe('renderer runtime trace', () => {
  beforeEach(() => {
    __resetRuntimeTraceForTests();
    recordElectronRuntimeEventMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  it('records only renderer events and forwards the allowlisted fields', () => {
    traceRuntimeEvent('renderer.agent_run_dispatched', {
      runId: 'run-1',
      stage: 'authorization=Bearer abcdefghijklmnop',
      ...({ prompt: 'private conversation text' } as unknown as Record<string, never>),
    });
    traceRuntimeEvent('sidecar.invalid', { runId: 'ignored' });
    traceRuntimeEvent('not valid!', { runId: 'ignored' });

    const snapshot = getRendererRuntimeTraceSnapshot();
    expect(snapshot.recentEvents).toHaveLength(1);
    expect(snapshot.recentEvents[0]).toMatchObject({
      event: 'renderer.agent_run_dispatched',
      runId: 'run-1',
    });
    expect(snapshot.recentEvents[0].stage).toContain('[REDACTED]');
    expect(snapshot.recentEvents[0]).not.toHaveProperty('prompt');
    expect(recordElectronRuntimeEventMock.mock.calls[0][0]).not.toHaveProperty('prompt');
    expect(recordElectronRuntimeEventMock).toHaveBeenCalledTimes(1);
  });

  it('reports active stages and removes terminal runs', () => {
    startRuntimeRun('run-2', 'electron-sidecar', 'params_build');
    vi.advanceTimersByTime(250);
    markRuntimeRunStage('run-2', 'waiting_for_first_delta');

    expect(getRendererRuntimeTraceSnapshot().activeRuns).toEqual([{
      runId: 'run-2',
      executionPath: 'electron-sidecar',
      stage: 'waiting_for_first_delta',
      durationMs: 250,
    }]);

    finishRuntimeRun('run-2');
    expect(getRendererRuntimeTraceSnapshot().activeRuns).toEqual([]);
  });

  it('classifies errors without retaining their message', () => {
    expect(runtimeErrorType(new TypeError('secret prompt'))).toBe('typeerror');
    expect(runtimeErrorType('secret prompt')).toBe('string');
  });
});
