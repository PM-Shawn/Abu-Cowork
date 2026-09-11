import { beforeEach, describe, expect, it } from 'vitest';
import { getI18n, initLanguage } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { ToolCall } from '@/types';
import {
  rowsFromLegacyResult,
  shouldRenderBatchProgressCard,
} from './batchProgressViewModel';

function legacyToolCall(result: string, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'legacy-batch',
    name: TOOL_NAMES.RUN_AGENT_BATCH,
    input: { tasks: [{ task: 'Inspect page' }, { task: 'Write summary' }] },
    result,
    ...extra,
  };
}

describe('legacy batch progress inference', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  it('infers all succeeded rows from the historical English aggregate header', () => {
    const toolCall = legacyToolCall('2 sub-tasks total: 2 succeeded, 0 failed');

    expect(rowsFromLegacyResult(toolCall, getI18n())?.map((row) => row.status)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    expect(shouldRenderBatchProgressCard(toolCall)).toBe(true);
  });

  it('infers mixed terminal rows from historical Chinese aggregate sections', () => {
    const toolCall = legacyToolCall([
      '共 2 个子任务，成功 1，失败 1',
      '',
      '### 子任务 1: Inspect page',
      'page result',
      '',
      '### 子任务 2: Write summary',
      '[失败] worker error',
    ].join('\n'));

    expect(rowsFromLegacyResult(toolCall, getI18n())?.map((row) => row.status)).toEqual([
      'succeeded',
      'failed',
    ]);
  });

  it('infers structured legacy rows only from a complete boolean ok projection', () => {
    const toolCall = legacyToolCall(JSON.stringify([
      { task: 'Inspect page', ok: true, data: { title: 'A' } },
      { task: 'Write summary', ok: false, error: 'invalid output' },
    ]));

    expect(rowsFromLegacyResult(toolCall, getI18n())?.map((row) => row.status)).toEqual([
      'succeeded',
      'failed',
    ]);
  });

  it('rejects unrecognized or count-mismatched terminal output so the generic result can render', () => {
    const unrecognized = legacyToolCall('ok');
    const mismatched = legacyToolCall('3 sub-tasks total: 3 succeeded, 0 failed');

    expect(rowsFromLegacyResult(unrecognized, getI18n())).toBeUndefined();
    expect(rowsFromLegacyResult(mismatched, getI18n())).toBeUndefined();
    expect(shouldRenderBatchProgressCard(unrecognized)).toBe(false);
    expect(shouldRenderBatchProgressCard(mismatched)).toBe(false);
  });
});
