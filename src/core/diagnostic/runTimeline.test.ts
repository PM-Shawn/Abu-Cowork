import { describe, expect, it } from 'vitest';
import { buildDiagnosticRunTimeline } from './runTimeline';
import type { RendererRuntimeTraceSnapshot } from '@/core/observability/runtimeTrace';

function rendererSnapshot(events: RendererRuntimeTraceSnapshot['recentEvents']): RendererRuntimeTraceSnapshot {
  return { schemaVersion: 1, takenAt: 500, recentEvents: events, activeRuns: [] };
}

describe('buildDiagnosticRunTimeline', () => {
  it('correlates a recovered replay into one completed run', () => {
    const timeline = buildDiagnosticRunTimeline(rendererSnapshot([
      { schemaVersion: 1, timestamp: 100, process: 'renderer', event: 'renderer.local_message_persisted', runId: 'run-1', clientMessageId: 'msg-1' },
      { schemaVersion: 1, timestamp: 110, process: 'renderer', event: 'renderer.agent_start_ack_missing', runId: 'run-1' },
      { schemaVersion: 1, timestamp: 120, process: 'renderer', event: 'renderer.agent_run_transport_replayed', runId: 'run-1', replayCount: 1 },
      { schemaVersion: 1, timestamp: 130, process: 'renderer', event: 'renderer.first_frame_applied', runId: 'run-1' },
      { schemaVersion: 1, timestamp: 150, process: 'renderer', event: 'renderer.agent_run_completed', runId: 'run-1' },
    ]), [], 600);

    expect(timeline).toMatchObject({ schemaVersion: 1, runCount: 1, rootCauseCounts: { start_ack: 1 } });
    expect(timeline.runs[0]).toMatchObject({
      runId: 'run-1',
      clientMessageId: 'msg-1',
      terminalOutcome: 'completed',
      rootCause: 'start_ack',
      replayCount: 1,
      committed: true,
      finishedAt: 150,
    });
  });

  it('classifies a post-commit sidecar close as transport failure', () => {
    const mainLines = [
      JSON.stringify({ schemaVersion: 1, timestamp: 200, process: 'sidecar', event: 'sidecar.agent_delta_emitted', runId: 'run-2' }),
      JSON.stringify({ schemaVersion: 1, timestamp: 220, process: 'main', event: 'main.rpc_orphaned_on_sidecar_close', runId: 'run-2' }),
      JSON.stringify({ schemaVersion: 1, timestamp: 230, process: 'renderer', event: 'renderer.agent_run_failed', runId: 'run-2', stage: 'failed_after_commit' }),
    ];

    const timeline = buildDiagnosticRunTimeline(rendererSnapshot([]), mainLines, 600);

    expect(timeline.runs[0]).toMatchObject({
      terminalOutcome: 'failed',
      rootCause: 'sidecar_transport',
      committed: true,
    });
  });

  it.each([
    ['completed', 'completed', 'none'],
    ['error', 'failed', 'runtime_failure'],
    ['aborted', 'interrupted', 'user_stopped'],
  ] as const)('uses sidecar outcome %s when the renderer terminal trace is missing', (sidecarOutcome, terminalOutcome, rootCause) => {
    const timeline = buildDiagnosticRunTimeline(rendererSnapshot([]), [
      JSON.stringify({ schemaVersion: 1, timestamp: 100, process: 'sidecar', event: 'sidecar.agent_loop_started', runId: 'run-3' }),
      JSON.stringify({ schemaVersion: 1, timestamp: 160, process: 'sidecar', event: 'sidecar.agent_run_completed', runId: 'run-3', outcome: sidecarOutcome }),
    ], 600);

    expect(timeline.runs[0]).toMatchObject({
      terminalOutcome,
      rootCause,
      finishedAt: 160,
    });
  });

  it('counts malformed or non-correlatable main events without leaking them into runs', () => {
    const timeline = buildDiagnosticRunTimeline(rendererSnapshot([]), [
      '{broken',
      JSON.stringify({ timestamp: 1, process: 'main', event: 'main.sidecar_closed' }),
    ], 600);

    expect(timeline.runCount).toBe(0);
    expect(timeline.uncorrelatedEventCount).toBe(2);
  });
});

describe('#549 root causes', () => {
  function snapshot(events: Array<Record<string, unknown>>): RendererRuntimeTraceSnapshot {
    return {
      schemaVersion: 1,
      takenAt: 10,
      activeRuns: [],
      recentEvents: events.map((event, index) => ({
        schemaVersion: 1,
        timestamp: index + 1,
        process: 'renderer',
        runId: 'run-1',
        ...event,
      })) as RendererRuntimeTraceSnapshot['recentEvents'],
    };
  }

  it('classifies oversize before the generic sidecar_transport cause', () => {
    const timeline = buildDiagnosticRunTimeline(snapshot([
      { event: 'renderer.agent_run_failed', stage: 'payload_too_large', errorType: 'payload_too_large' },
    ]), [], 10);

    expect(timeline.runs[0]).toMatchObject({ terminalOutcome: 'failed', rootCause: 'payload_too_large' });
    expect(timeline.rootCauseCounts.payload_too_large).toBe(1);
  });

  it('keeps oversize as the cause even when the sidecar closed in the same run', () => {
    const timeline = buildDiagnosticRunTimeline(snapshot([
      { event: 'renderer.agent_run_failed', stage: 'payload_too_large', errorType: 'payload_too_large' },
    ]), [
      JSON.stringify({ schemaVersion: 1, timestamp: 5, process: 'main', event: 'main.sidecar_closed', runId: 'run-1' }),
    ], 10);

    expect(timeline.runs[0].rootCause).toBe('payload_too_large');
  });

  it('classifies an unavailable sidecar', () => {
    const timeline = buildDiagnosticRunTimeline(snapshot([
      { event: 'renderer.agent_run_failed', stage: 'sidecar_unavailable', errorType: 'sidecar_timeout' },
    ]), [], 10);

    expect(timeline.runs[0].rootCause).toBe('sidecar_unavailable');
  });

  it('a params-build failure stays a runtime failure', () => {
    const timeline = buildDiagnosticRunTimeline(snapshot([
      { event: 'renderer.agent_run_failed', stage: 'params_build_failed', errorType: 'error' },
    ]), [], 10);

    expect(timeline.runs[0].rootCause).toBe('runtime_failure');
  });

  // The subagent transport path reports oversize through `stage` because its
  // `errorType` is not stable (renderer pre-check vs sidecar reply produce
  // different error classes), so the classifier must read the stage only.
  it('reads oversize from the stage, never from errorType', () => {
    const timeline = buildDiagnosticRunTimeline(snapshot([
      { event: 'renderer.subagent_run_failed', stage: 'transport_failed', errorType: 'payload_too_large' },
    ]), [], 10);

    expect(timeline.runs[0].rootCause).toBe('runtime_failure');
  });

  it.each([
    ['renderer.agent_run_failed', 'payload_too_large', 'payload_too_large'],
    ['renderer.agent_run_failed', 'sidecar_unavailable', 'sidecar_unavailable'],
    ['renderer.agent_run_failed', 'params_build_failed', 'runtime_failure'],
    ['renderer.subagent_run_failed', 'payload_too_large', 'payload_too_large'],
    ['renderer.subagent_run_failed', 'sidecar_unavailable', 'sidecar_unavailable'],
    ['renderer.subagent_run_failed', 'params_build_failed', 'runtime_failure'],
    ['renderer.subagent_run_failed', 'transport_failed', 'runtime_failure'],
  ] as const)('%s at stage %s ends the run as failed with a finishedAt', (event, stage, rootCause) => {
    const timeline = buildDiagnosticRunTimeline(snapshot([
      { event: 'renderer.local_message_persisted' },
      { event, stage },
    ]), [], 10);

    expect(timeline.runs[0]).toMatchObject({ terminalOutcome: 'failed', rootCause, finishedAt: 2 });
  });
});
