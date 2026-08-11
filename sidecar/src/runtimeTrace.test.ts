import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SIDECAR_RUNTIME_TRACE_PREFIX,
  sidecarRuntimeErrorType,
  traceSidecarRuntimeEvent,
} from './runtimeTrace';

describe('sidecar runtime trace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits one safe JSON line without prompt or credential fields', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    traceSidecarRuntimeEvent('sidecar.agent_run_started', {
      runId: 'run-1',
      stage: 'token=super-secret-value',
    });

    expect(write).toHaveBeenCalledOnce();
    const line = String(write.mock.calls[0][0]);
    expect(line.startsWith(SIDECAR_RUNTIME_TRACE_PREFIX)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.slice(SIDECAR_RUNTIME_TRACE_PREFIX.length)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      process: 'sidecar',
      event: 'sidecar.agent_run_started',
      runId: 'run-1',
    });
    expect(parsed.stage).toContain('[REDACTED]');
    expect(line).not.toContain('super-secret-value');
  });

  it('rejects invalid or non-sidecar event names', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    traceSidecarRuntimeEvent('renderer.wrong_process', { runId: 'run-1' });
    traceSidecarRuntimeEvent('bad event', { runId: 'run-1' });
    expect(write).not.toHaveBeenCalled();
  });

  it('classifies errors without retaining their message', () => {
    expect(sidecarRuntimeErrorType(new RangeError('secret body'))).toBe('rangeerror');
    expect(sidecarRuntimeErrorType(42)).toBe('number');
  });
});
