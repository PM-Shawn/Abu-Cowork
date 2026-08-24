import { describe, expect, it } from 'vitest';
import {
  batchSummaryHasNonSuccess,
  mergeBatchTerminalSummaries,
  normalizeBatchTerminalSummary,
  subagentStopReasonFromBatchSummary,
} from './batchTerminalSummary';

const expected = { conversationId: 'conv-1', batchToolCallId: 'tc-1' };

function validSummary(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    batch: expected,
    taskCount: 2,
    counts: { succeeded: 1, failed: 0, stopped: 1, incomplete: 0 },
    tasks: [
      { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
      { taskIndex: 1, status: 'stopped', terminalReason: 'aborted' },
    ],
    ...overrides,
  };
}

describe('batch terminal summary normalization', () => {
  it('materializes a canonical allowlisted summary and drops untrusted extras', () => {
    const normalized = normalizeBatchTerminalSummary({
      ...validSummary(),
      prompt: 'do not persist me',
      resultContent: [{ type: 'image', source: { data: 'base64' } }],
      tasks: [
        {
          taskIndex: 0,
          status: 'succeeded',
          terminalReason: 'completed',
          output: 'do not persist me',
          steps: [{ resultContent: 'x' }],
        },
        {
          taskIndex: 1,
          status: 'stopped',
          terminalReason: 'aborted',
          base64: 'do not persist me',
        },
      ],
    }, expected);

    expect(normalized).toEqual({
      version: 1,
      batch: expected,
      taskCount: 2,
      counts: { succeeded: 1, failed: 0, stopped: 1, incomplete: 0 },
      tasks: [
        { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
        { taskIndex: 1, status: 'stopped', terminalReason: 'aborted' },
      ],
    });
    expect(JSON.stringify(normalized)).not.toContain('prompt');
    expect(JSON.stringify(normalized)).not.toContain('output');
    expect(JSON.stringify(normalized)).not.toContain('resultContent');
    expect(JSON.stringify(normalized)).not.toContain('base64');
  });

  it('rejects forged identity, malformed counts, duplicate/out-of-range indices, and illegal status-reason pairs', () => {
    expect(normalizeBatchTerminalSummary(validSummary({
      batch: { conversationId: 'other-conv', batchToolCallId: 'tc-1' },
    }), expected)).toBeUndefined();
    expect(normalizeBatchTerminalSummary(validSummary({
      counts: { succeeded: 999, failed: 999, stopped: 999, incomplete: 999 },
    }), expected)).toBeUndefined();
    expect(normalizeBatchTerminalSummary(validSummary({
      tasks: [
        { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
        { taskIndex: 0, status: 'stopped', terminalReason: 'aborted' },
      ],
    }), expected)).toBeUndefined();
    expect(normalizeBatchTerminalSummary(validSummary({
      tasks: [{ taskIndex: 3, status: 'stopped', terminalReason: 'aborted' }],
    }), expected)).toBeUndefined();
    expect(normalizeBatchTerminalSummary(validSummary({
      tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'completed' }],
    }), expected)).toBeUndefined();
  });

  it('merges cumulative partial summaries monotonically and recomputes counts from tasks', () => {
    const first = normalizeBatchTerminalSummary({
      version: 1,
      batch: expected,
      taskCount: 2,
      counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
      tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
    }, expected)!;
    const lateMixed = normalizeBatchTerminalSummary({
      version: 1,
      batch: expected,
      taskCount: 2,
      counts: { succeeded: 2, failed: 0, stopped: 0, incomplete: 0 },
      tasks: [
        { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
        { taskIndex: 1, status: 'succeeded', terminalReason: 'completed' },
      ],
    }, expected)!;

    const merged = mergeBatchTerminalSummaries(first, lateMixed);

    expect(merged.counts).toEqual({ succeeded: 1, failed: 0, stopped: 1, incomplete: 0 });
    expect(merged.tasks).toEqual([
      { taskIndex: 0, status: 'stopped', terminalReason: 'aborted' },
      { taskIndex: 1, status: 'succeeded', terminalReason: 'completed' },
    ]);
    expect(batchSummaryHasNonSuccess(merged)).toBe(true);
    expect(subagentStopReasonFromBatchSummary(merged)).toBe('aborted');
  });

  it('keeps the existing summary when an incoming merge has a mismatched identity or taskCount', () => {
    const existing = normalizeBatchTerminalSummary({
      version: 1,
      batch: expected,
      taskCount: 2,
      counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
      tasks: [{ taskIndex: 1, status: 'stopped', terminalReason: 'aborted' }],
    }, expected)!;
    const smallerIncoming = normalizeBatchTerminalSummary({
      version: 1,
      batch: expected,
      taskCount: 1,
      counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
      tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
    }, expected)!;
    const forgedIncoming = normalizeBatchTerminalSummary({
      version: 1,
      batch: { conversationId: 'conv-1', batchToolCallId: 'tc-other' },
      taskCount: 2,
      counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
      tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
    })!;

    expect(mergeBatchTerminalSummaries(existing, smallerIncoming)).toBe(existing);
    expect(mergeBatchTerminalSummaries(existing, forgedIncoming)).toBe(existing);
  });
});
