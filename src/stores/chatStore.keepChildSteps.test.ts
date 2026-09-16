import { describe, it, expect } from 'vitest';
import { keepExistingChildSteps } from './chatStore';
import type { ExecutionStepSnapshot } from '@/types/execution';

const child: ExecutionStepSnapshot = { id: 'c1', type: 'tool', label: 'sleep', status: 'completed', toolName: 'run_command' };

describe('keepExistingChildSteps', () => {
  it('carries children forward when the newer snapshot arrives bare (by id, then tool call id)', () => {
    const previous: ExecutionStepSnapshot[] = [
      { id: 's1', toolCallId: 'call-1', type: 'delegate', label: 'x', status: 'running', toolName: 'delegate_to_agent', childSteps: [child] },
    ];
    const next: ExecutionStepSnapshot[] = [
      { id: 's1', toolCallId: 'call-1', type: 'delegate', label: 'x', status: 'completed', toolName: 'delegate_to_agent' },
      { id: 's2', type: 'tool', label: 'y', status: 'completed', toolName: 'read_file' },
    ];
    expect(keepExistingChildSteps(previous, next)[0]).toMatchObject({ status: 'completed', childSteps: [child] });
    expect(keepExistingChildSteps(previous, next)[1].childSteps).toBeUndefined();
    const renamed: ExecutionStepSnapshot[] = [{ id: 'other-id', toolCallId: 'call-1', type: 'delegate', label: 'x', status: 'completed', toolName: 'delegate_to_agent' }];
    expect(keepExistingChildSteps(previous, renamed)[0].childSteps).toEqual([child]);
  });

  it('never overrides children the newer snapshot already has, and is a no-op without a previous snapshot', () => {
    const newer: ExecutionStepSnapshot[] = [{ id: 's1', type: 'delegate', label: 'x', status: 'completed', toolName: 'delegate_to_agent', childSteps: [{ ...child, id: 'c2' }] }];
    expect(keepExistingChildSteps([{ id: 's1', type: 'delegate', label: 'x', status: 'running', toolName: 'delegate_to_agent', childSteps: [child] }], newer)[0].childSteps).toEqual([{ ...child, id: 'c2' }]);
    expect(keepExistingChildSteps(undefined, newer)).toBe(newer);
  });
});
