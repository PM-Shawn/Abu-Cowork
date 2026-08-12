import { describe, expect, it } from 'vitest';
import {
  createAgentRunTerminal,
  isAgentRunTerminal,
  terminalStateForAgentLoopResult,
} from './agentRunTerminal';

describe('agentRunTerminal', () => {
  it.each([
    [{ reason: 'completed' } as const, 'completed'],
    [{ reason: 'max_turns' } as const, 'completed'],
    [{ reason: 'awaiting_user' } as const, 'completed'],
    [{ reason: 'aborted' } as const, 'interrupted'],
    [{ reason: 'error', error: 'boom' } as const, 'failed'],
  ])('maps result %j to %s', (result, state) => {
    expect(terminalStateForAgentLoopResult(result)).toBe(state);
    expect(createAgentRunTerminal('run-1', result)).toEqual({
      version: 1,
      runId: 'run-1',
      state,
      result,
      ...(state === 'failed' ? {
        failure: { errorType: 'agent_loop_error', message: 'boom' },
      } : {}),
    });
  });

  it('validates version, result shape, and state/result consistency', () => {
    expect(isAgentRunTerminal({
      version: 1,
      runId: 'run-1',
      state: 'failed',
      result: { reason: 'error', error: 'boom' },
      failure: { errorType: 'provider_error', message: 'boom', stack: 'stack' },
    })).toBe(true);
    expect(isAgentRunTerminal({
      version: 1,
      runId: 'run-1',
      state: 'completed',
      result: { reason: 'error', error: 'boom' },
      failure: { errorType: 'provider_error', message: 'boom' },
    })).toBe(false);
    expect(isAgentRunTerminal({
      version: 2,
      runId: 'run-1',
      state: 'completed',
      result: { reason: 'completed' },
    })).toBe(false);
    expect(isAgentRunTerminal({
      version: 1,
      runId: '',
      state: 'completed',
      result: { reason: 'completed' },
    })).toBe(false);
  });
});
