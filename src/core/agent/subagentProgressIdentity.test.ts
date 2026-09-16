import { describe, expect, it, vi } from 'vitest';
import type { SubagentLoopOptions } from './subagentLoop';
import {
  makeSubagentProgressToolCallId,
  scopeSubagentLoopProgress,
  scopeSubagentProgressEvent,
  SUBAGENT_PROGRESS_TOOL_CALL_ID_MAX_BYTES,
} from './subagentProgressIdentity';

function makeOptions(onProgress: NonNullable<SubagentLoopOptions['onProgress']>): SubagentLoopOptions {
  return {
    agent: {
      name: 'tester',
      description: 'test agent',
      systemPrompt: 'test',
      filePath: '__preset__',
    },
    task: 'test task',
    onProgress,
  };
}

describe('subagent progress identity', () => {
  it('isolates identical provider ids from parallel subagent runs', () => {
    const first = makeSubagentProgressToolCallId('run-a', 'call_1');
    const second = makeSubagentProgressToolCallId('run-b', 'call_1');

    expect(first).not.toBe(second);
    expect(first).toBe('subagent-v1:run-a:call_1');
  });

  it('bounds hostile ids without collapsing different tails', () => {
    const sharedPrefix = 'x'.repeat(10_000);
    const first = makeSubagentProgressToolCallId(sharedPrefix, `${sharedPrefix}a`);
    const second = makeSubagentProgressToolCallId(sharedPrefix, `${sharedPrefix}b`);

    expect(first).not.toBe(second);
    expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(
      SUBAGENT_PROGRESS_TOOL_CALL_ID_MAX_BYTES,
    );
    expect(new TextEncoder().encode(second).byteLength).toBeLessThanOrEqual(
      SUBAGENT_PROGRESS_TOOL_CALL_ID_MAX_BYTES,
    );
  });

  it('handles lone surrogates without throwing or collapsing their identities', () => {
    const high = makeSubagentProgressToolCallId('run', '\ud800');
    const low = makeSubagentProgressToolCallId('run', '\udc00');
    const replacement = makeSubagentProgressToolCallId('run', '\ufffd');

    expect(high).not.toBe(low);
    expect(high).not.toBe(replacement);
    expect(low).not.toBe(replacement);
    expect(high).toMatch(/^subagent-v1:[\x20-\x7e]+$/);

    const transformedPart = high.slice(high.lastIndexOf(':') + 1);
    const craftedValidInput = decodeURIComponent(transformedPart);
    expect(makeSubagentProgressToolCallId('run', craftedValidInput)).not.toBe(high);
  });

  it('scopes tool events while leaving turn accounting unchanged', () => {
    expect(scopeSubagentProgressEvent('run/a', {
      type: 'tool-start',
      id: 'call:1',
      toolName: 'read_file',
      toolInput: {},
    })).toMatchObject({ id: 'subagent-v1:run%2Fa:call%3A1' });

    const turn = { type: 'turn-complete' as const, turn: 1, totalTurns: 2 };
    expect(scopeSubagentProgressEvent('run-a', turn)).toBe(turn);
  });

  it('gives every loop wrapper an independent default scope', () => {
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = scopeSubagentLoopProgress(makeOptions(firstProgress));
    const second = scopeSubagentLoopProgress(makeOptions(secondProgress));
    const rawEvent = {
      type: 'tool-start' as const,
      id: 'call_1',
      toolName: 'read_file',
      toolInput: {},
    };

    first.onProgress?.(rawEvent);
    second.onProgress?.(rawEvent);

    expect(firstProgress.mock.calls[0][0].id).not.toBe(secondProgress.mock.calls[0][0].id);
  });

  it('can use an explicit scope without changing turn events', () => {
    const onProgress = vi.fn();
    const options = scopeSubagentLoopProgress(makeOptions(onProgress), 'nested/a');
    const turn = { type: 'turn-complete' as const, turn: 1, totalTurns: 2 };

    options.onProgress?.({
      type: 'tool-end',
      id: 'call_1',
      toolName: 'read_file',
      result: 'done',
      error: false,
    });
    options.onProgress?.(turn);

    expect(onProgress.mock.calls[0][0].id).toBe('subagent-v1:nested%2Fa:call_1');
    expect(onProgress.mock.calls[1][0]).toBe(turn);
  });

  // N6: the same scope id is the run's identity for per-run RESOURCES too
  // (browser tab ownership), which the in-process loop reads off the options
  // and puts in every ToolExecutionContext.
  it('stamps the scope id onto the options as the run identity', () => {
    const options = scopeSubagentLoopProgress(makeOptions(vi.fn()), 'sar-explicit');

    expect(options.agentRunId).toBe('sar-explicit');
  });

  it('stamps it even for a run with no progress sink — the two consumers are independent', () => {
    const withoutProgress = { ...makeOptions(vi.fn()), onProgress: undefined };

    const options = scopeSubagentLoopProgress(withoutProgress, 'sar-silent');

    expect(options.agentRunId).toBe('sar-silent');
  });

  it('mints a distinct identity per run when none is given', () => {
    const first = scopeSubagentLoopProgress(makeOptions(vi.fn()));
    const second = scopeSubagentLoopProgress(makeOptions(vi.fn()));

    expect(first.agentRunId).toMatch(/^sar-/);
    expect(first.agentRunId).not.toBe(second.agentRunId);
  });
});
