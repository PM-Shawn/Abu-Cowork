import { describe, it, expect } from 'vitest';
import {
  backfillDetailBlockImages,
  snapshotExecutionSteps,
  snapshotToExecutionSteps,
} from './executionSnapshot';
import type { Message, ToolCall } from '@/types';
import type { DetailBlock, ExecutionStep } from '@/types/execution';

const PLACEHOLDER = 'Image: /tmp/line_chart.png (37KB, image/png)';
const OTHER_PLACEHOLDER = 'Image: /tmp/bar_chart.png (12KB, image/png)';

function imageBlock(stepId: string, overrides: Partial<DetailBlock> = {}): DetailBlock {
  return {
    id: `${stepId}-image`,
    stepId,
    type: 'image',
    label: 'Image',
    labelKey: 'image',
    content: PLACEHOLDER,
    isTruncated: false,
    isExpanded: true,
    ...overrides,
  };
}

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  const id = overrides.id ?? 'step-1';
  return {
    id,
    executionId: 'exec-1',
    type: 'file-read',
    label: 'Read file',
    status: 'completed',
    toolName: 'read_file',
    toolInput: {},
    source: 'agent',
    detailBlocks: [imageBlock(id)],
    ...overrides,
  };
}

function imageToolCall(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    name: 'read_file',
    input: { path: '/tmp/line_chart.png' },
    result: PLACEHOLDER,
    resultContent: [
      { type: 'text', text: PLACEHOLDER },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `base64-${id}` } },
    ],
    ...overrides,
  };
}

function assistantMessage(id: string, toolCalls: ToolCall[]): Message {
  return { id, role: 'assistant', content: '', timestamp: 0, toolCalls };
}

describe('executionSnapshot', () => {
  describe('snapshot round-trip', () => {
    it('carries toolCallId through snapshot and restore', () => {
      const steps = [step({ id: 'step-1', toolCallId: 'toolu_1' })];

      const snapshots = snapshotExecutionSteps(steps);
      expect(snapshots[0].toolCallId).toBe('toolu_1');

      const restored = snapshotToExecutionSteps(snapshots);
      expect(restored[0].toolCallId).toBe('toolu_1');
      // Base64 must NOT be duplicated into the snapshot.
      expect(JSON.stringify(snapshots)).not.toContain('base64-');
      expect(restored[0].detailBlocks[0].imageData).toBeUndefined();
    });

    it('carries toolCallId on nested child steps', () => {
      const steps = [
        step({
          id: 'parent',
          type: 'delegate',
          detailBlocks: [],
          childSteps: [step({ id: 'child', toolCallId: 'toolu_child' })],
        }),
      ];

      const restored = snapshotToExecutionSteps(snapshotExecutionSteps(steps));
      expect(restored[0].childSteps?.[0].toolCallId).toBe('toolu_child');
    });

    it('leaves toolCallId undefined for synthetic steps that have none', () => {
      const restored = snapshotToExecutionSteps(snapshotExecutionSteps([step()]));
      expect(restored[0].toolCallId).toBeUndefined();
    });
  });

  describe('backfillDetailBlockImages', () => {
    it('backfills by exact toolCallId match', () => {
      const steps = [step({ id: 'step-1', toolCallId: 'toolu_1' })];
      const messages = [
        assistantMessage('msg-a', [imageToolCall('toolu_1')]),
        assistantMessage('msg-b', []),
      ];

      const result = backfillDetailBlockImages(steps, messages);

      expect(result[0].detailBlocks[0].imageData).toEqual({
        mediaType: 'image/png',
        base64: 'base64-toolu_1',
      });
      // Input must not be mutated.
      expect(steps[0].detailBlocks[0].imageData).toBeUndefined();
    });

    it('finds the tool call on a different message than the snapshot', () => {
      // Real shape: snapshot rides the LAST assistant message, the tool call
      // with resultContent rides an earlier one.
      const steps = [step({ id: 'step-1', toolCallId: 'toolu_1' })];
      const messages = [
        assistantMessage('msg-early', [imageToolCall('toolu_1')]),
        assistantMessage('msg-final', [{ id: 'toolu_2', name: 'write_file', input: {}, result: 'ok' }]),
      ];

      const result = backfillDetailBlockImages(steps, messages);
      expect(result[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
    });

    it('backfills nested child steps', () => {
      const steps = [
        step({
          id: 'parent',
          type: 'delegate',
          detailBlocks: [],
          childSteps: [step({ id: 'child', toolCallId: 'toolu_1' })],
        }),
      ];

      const result = backfillDetailBlockImages(steps, [
        assistantMessage('msg-a', [imageToolCall('toolu_1')]),
      ]);
      expect(result[0].childSteps?.[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
    });

    it('never overwrites a live imageData payload', () => {
      const live = { mediaType: 'image/png', base64: 'live-payload' };
      const steps = [
        step({
          id: 'step-1',
          toolCallId: 'toolu_1',
          detailBlocks: [imageBlock('step-1', { imageData: live })],
        }),
      ];

      const result = backfillDetailBlockImages(steps, [
        assistantMessage('msg-a', [imageToolCall('toolu_1')]),
      ]);
      expect(result).toBe(steps);
      expect(result[0].detailBlocks[0].imageData).toBe(live);
    });

    describe('legacy snapshots without toolCallId', () => {
      it('matches on the exact placeholder text', () => {
        const steps = [step({ id: 'step-1' })];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [imageToolCall('toolu_1')]),
        ]);
        expect(result[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
      });

      it('pairs same-count candidates in order of appearance', () => {
        const steps = [
          step({ id: 'step-1', detailBlocks: [imageBlock('step-1')] }),
          step({ id: 'step-2', detailBlocks: [imageBlock('step-2')] }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [imageToolCall('toolu_1'), imageToolCall('toolu_2')]),
        ]);
        expect(result[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
        expect(result[1].detailBlocks[0].imageData?.base64).toBe('base64-toolu_2');
      });

      it('gives up when candidates outnumber blocks (ambiguous)', () => {
        const steps = [step({ id: 'step-1' })];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [imageToolCall('toolu_1'), imageToolCall('toolu_2')]),
        ]);
        expect(result).toBe(steps);
        expect(result[0].detailBlocks[0].imageData).toBeUndefined();
      });

      it('gives up when blocks outnumber candidates (ambiguous)', () => {
        const steps = [
          step({ id: 'step-1', detailBlocks: [imageBlock('step-1')] }),
          step({ id: 'step-2', detailBlocks: [imageBlock('step-2')] }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [imageToolCall('toolu_1')]),
        ]);
        expect(result).toBe(steps);
      });

      it('resolves distinct placeholders independently', () => {
        const steps = [
          step({ id: 'step-1', detailBlocks: [imageBlock('step-1')] }),
          step({ id: 'step-2', detailBlocks: [imageBlock('step-2', { content: OTHER_PLACEHOLDER })] }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [
            imageToolCall('toolu_1'),
            imageToolCall('toolu_2', { result: OTHER_PLACEHOLDER }),
          ]),
        ]);
        expect(result[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
        expect(result[1].detailBlocks[0].imageData?.base64).toBe('base64-toolu_2');
      });

      it('does not reuse a candidate already claimed by a toolCallId match', () => {
        // step-1 claims toolu_1 by id; step-2 (legacy, same placeholder text)
        // then has zero unclaimed candidates left → stays a placeholder.
        const steps = [
          step({ id: 'step-1', toolCallId: 'toolu_1', detailBlocks: [imageBlock('step-1')] }),
          step({ id: 'step-2', detailBlocks: [imageBlock('step-2')] }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [imageToolCall('toolu_1')]),
        ]);
        expect(result[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
        expect(result[1].detailBlocks[0].imageData).toBeUndefined();
      });
    });

    describe('graceful degradation', () => {
      it('returns the same reference when no tool call carries an image block', () => {
        const steps = [step({ id: 'step-1', toolCallId: 'toolu_1' })];
        const messages = [
          assistantMessage('msg-a', [
            {
              id: 'toolu_1',
              name: 'read_file',
              input: {},
              result: PLACEHOLDER,
              resultContent: [{ type: 'text', text: PLACEHOLDER }],
            },
          ]),
        ];

        const result = backfillDetailBlockImages(steps, messages);
        expect(result).toBe(steps);
        expect(result[0].detailBlocks[0].imageData).toBeUndefined();
      });

      it('returns the same reference when messages have no tool calls at all', () => {
        const steps = [step({ id: 'step-1', toolCallId: 'toolu_1' })];
        const result = backfillDetailBlockImages(steps, [
          { id: 'msg-a', role: 'assistant', content: 'done', timestamp: 0 },
        ]);
        expect(result).toBe(steps);
      });

      it('ignores an image resultContent block with an empty payload', () => {
        const steps = [step({ id: 'step-1', toolCallId: 'toolu_1' })];
        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [
            imageToolCall('toolu_1', {
              resultContent: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
              ],
            }),
          ]),
        ]);
        expect(result).toBe(steps);
      });

      it('leaves non-image detail blocks untouched', () => {
        const steps = [
          step({
            id: 'step-1',
            toolCallId: 'toolu_1',
            detailBlocks: [
              {
                id: 'step-1-result',
                stepId: 'step-1',
                type: 'result',
                label: 'Result',
                content: PLACEHOLDER,
                isTruncated: false,
                isExpanded: false,
              },
            ],
          }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [imageToolCall('toolu_1')]),
        ]);
        expect(result).toBe(steps);
      });

      it('returns the same reference for an empty step list', () => {
        const steps: ExecutionStep[] = [];
        expect(backfillDetailBlockImages(steps, [])).toBe(steps);
      });
    });
  });
});
