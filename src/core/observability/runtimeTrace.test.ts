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

  it('keeps Computer Use correlation ids and structural facts without content fields', () => {
    traceRuntimeEvent('renderer.computer_use_observation', {
      conversationId: 'conversation-1',
      loopId: 'loop-1',
      computerRunId: 'conversation-1:loop-1',
      traceId: 'conversation-1:loop-1',
      toolCallId: 'tool-1',
      stateId: 'state-1',
      modelTier: 'structured',
      targetBundleId: 'com.apple.Notes',
      targetProcessId: 42,
      axTreeHash: 'sha256:abc',
      elementCount: 3,
      ...({
        prompt: 'private prompt',
        screenshot: 'base64-private',
        axLabels: ['private label'],
      } as unknown as Record<string, never>),
    });

    expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).toMatchObject({
      event: 'renderer.computer_use_observation',
      conversationId: 'conversation-1',
      loopId: 'loop-1',
      computerRunId: 'conversation-1:loop-1',
      toolCallId: 'tool-1',
      stateId: 'state-1',
      modelTier: 'structured',
      targetBundleId: 'com.apple.Notes',
      targetProcessId: 42,
      elementCount: 3,
    });
    expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).not.toHaveProperty('prompt');
    expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).not.toHaveProperty('screenshot');
    expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).not.toHaveProperty('axLabels');
  });

  it('classifies errors without retaining their message', () => {
    expect(runtimeErrorType(new TypeError('secret prompt'))).toBe('typeerror');
    expect(runtimeErrorType('secret prompt')).toBe('string');
  });

  it('keeps bounded route and exposure facts, including boolean gates', () => {
    traceRuntimeEvent('renderer.agent_tool_exposure', {
      conversationId: 'conversation-1',
      loopId: 'loop-1',
      routeType: 'general',
      turnIndex: 2,
      activeToolCount: 17,
      deferredToolCount: 9,
      computerUseExposed: true,
      ...({ toolNames: ['private-tool-name'] } as unknown as Record<string, never>),
    });

    expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).toMatchObject({
      routeType: 'general',
      turnIndex: 2,
      activeToolCount: 17,
      deferredToolCount: 9,
      computerUseExposed: true,
    });
    expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).not.toHaveProperty('toolNames');
  });

  describe('conversation join', () => {
    it('stamps the run conversationId onto later events that only carry a runId', () => {
      startRuntimeRun('run-join', 'sidecar', 'local_message_persisting', 'conversation-join');

      traceRuntimeEvent('renderer.first_frame_applied', { runId: 'run-join' });

      expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).toMatchObject({
        runId: 'run-join',
        conversationId: 'conversation-join',
      });
      expect(recordElectronRuntimeEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conversation-join' }),
      );
    });

    it('keeps an explicit conversationId and never invents one for unknown runs', () => {
      startRuntimeRun('run-join', 'sidecar', 'stage', 'conversation-join');

      traceRuntimeEvent('renderer.explicit', { runId: 'run-join', conversationId: 'conversation-explicit' });
      traceRuntimeEvent('renderer.unknown_run', { runId: 'run-absent' });

      const [explicit, unknown] = getRendererRuntimeTraceSnapshot().recentEvents;
      expect(explicit).toMatchObject({ conversationId: 'conversation-explicit' });
      expect(unknown).not.toHaveProperty('conversationId');
    });

    it('stops stamping once the run is finished', () => {
      startRuntimeRun('run-join', 'sidecar', 'stage', 'conversation-join');
      finishRuntimeRun('run-join');

      traceRuntimeEvent('renderer.after_finish', { runId: 'run-join' });

      expect(getRendererRuntimeTraceSnapshot().recentEvents[0]).not.toHaveProperty('conversationId');
    });
  });
});
