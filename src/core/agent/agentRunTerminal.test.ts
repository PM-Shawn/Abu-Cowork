import { describe, expect, it } from 'vitest';
import {
  areAgentRunTerminalsEqual,
  createAgentRunTerminal,
  isAgentRunTerminal,
  sanitizeReceivedAgentRunTerminal,
  terminalStateForAgentLoopResult,
} from './agentRunTerminal';
import { FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE } from './__contractFixtures__/agentRunTerminalFixture';

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
      result: { reason: 'error', error: 'boom', messageTaken: true },
      failure: { errorType: 'provider_error', message: 'boom', stack: 'stack' },
    })).toBe(true);
    expect(isAgentRunTerminal({
      version: 1,
      runId: 'run-1',
      state: 'completed',
      result: { reason: 'error', error: 'boom', messageTaken: true },
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

  it('validates and compares bounded upstream error details', () => {
    const fixture = structuredClone(FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE);
    expect(isAgentRunTerminal(fixture)).toBe(true);
    expect(areAgentRunTerminalsEqual(fixture, structuredClone(fixture))).toBe(true);
    expect(areAgentRunTerminalsEqual(fixture, {
      ...fixture,
      failure: {
        ...fixture.failure,
        upstream: { ...fixture.failure.upstream, traceId: 'different-trace' },
      },
    })).toBe(false);
    expect(areAgentRunTerminalsEqual(fixture, {
      ...fixture,
      result: { ...fixture.result, messageTaken: false },
    })).toBe(false);
    expect(areAgentRunTerminalsEqual(fixture, {
      ...fixture,
      result: { ...fixture.result, stopReason: 'sidecar_unavailable' },
    })).toBe(false);
  });

  it('drops failure-only fields from a completed sender result', () => {
    expect(createAgentRunTerminal('completed-projection', {
      reason: 'completed',
      error: 'must not cross',
      upstream: { status: 403 },
    })).toEqual({
      version: 1,
      runId: 'completed-projection',
      state: 'completed',
      result: { reason: 'completed' },
    });
  });

  it.each([
    '{"private":"legacy provider body"}',
    '<html><body>legacy proxy body</body></html>',
  ])('sanitizes legacy terminal text before renderer use: %s', (message) => {
    const terminal = createAgentRunTerminal(
      'legacy-terminal',
      { reason: 'error', error: message, messageTaken: true },
      { errorType: 'llmerror', message, stack: `LLMError: ${message}\n    at legacy-adapter.ts:1:1` },
    );

    const sanitized = sanitizeReceivedAgentRunTerminal(terminal, 'safe terminal failure');

    expect(sanitized.result.error).toBe('safe terminal failure');
    expect(sanitized.failure?.message).toBe('safe terminal failure');
    expect(sanitized.failure?.stack).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain('legacy provider body');
    expect(JSON.stringify(sanitized)).not.toContain('legacy proxy body');
  });

  it.each([
    ['missing status', { error_type: 'content_policy' }],
    ['non-integer status', { status: 403.5 }],
    ['out-of-range status', { status: 999 }],
    ['empty error_type', { status: 403, error_type: '' }],
    ['non-string traceId', { status: 403, traceId: 42 }],
    ['non-string summary', { status: 403, summary: {} }],
    ['privacy-unsafe extra field', { status: 403, rawBody: 'private prompt text' }],
  ])('rejects malformed upstream details: %s', (_label, upstream) => {
    expect(isAgentRunTerminal({
      ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE,
      result: {
        ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.result,
        upstream,
      },
      failure: {
        ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.failure,
        upstream,
      },
    })).toBe(false);
  });

  it('rejects conflicting upstream projections duplicated in result and failure', () => {
    expect(isAgentRunTerminal({
      ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE,
      failure: {
        ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.failure,
        upstream: {
          ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.failure.upstream,
          traceId: 'conflicting-trace',
        },
      },
    })).toBe(false);
  });

  it.each([
    ['terminal', {
      ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE,
      rawBody: 'private prompt text',
    }],
    ['result', {
      ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE,
      result: {
        ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.result,
        rawBody: 'private prompt text',
      },
    }],
    ['failure', {
      ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE,
      failure: {
        ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.failure,
        rawBody: 'private prompt text',
      },
    }],
  ])('rejects unknown privacy-unsafe keys on the %s object', (_label, terminal) => {
    expect(isAgentRunTerminal(terminal)).toBe(false);
  });

  it.each([
    ['missing messageTaken', {
      ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE,
      result: { reason: 'error', error: 'failed' },
    }],
    ['non-boolean messageTaken', {
      ...FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE,
      result: { reason: 'error', error: 'failed', messageTaken: 'yes' },
    }],
    ['invalid stopReason', {
      version: 1,
      runId: 'invalid-stop-reason',
      state: 'completed',
      result: { reason: 'completed', stopReason: 'anything' },
    }],
    ['completed with error text', {
      version: 1,
      runId: 'completed-with-error',
      state: 'completed',
      result: { reason: 'completed', error: 'must not survive' },
    }],
    ['completed with upstream failure details', {
      version: 1,
      runId: 'completed-with-upstream',
      state: 'completed',
      result: { reason: 'completed', upstream: { status: 403 } },
    }],
  ])('rejects invalid AgentLoopResult semantics: %s', (_label, terminal) => {
    expect(isAgentRunTerminal(terminal)).toBe(false);
  });
});
