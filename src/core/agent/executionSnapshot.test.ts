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

/**
 * Two placeholder strings that really do collide in production, verbatim:
 *
 * - AUTO_SCREENSHOT is computerTools' post-action screenshot text. It embeds
 *   only the resolution and scale, so every screenshot taken on one display in
 *   one loop produces a byte-identical string.
 * - IMAGE_ONLY is what toolResultToString returns whenever a tool result has no
 *   text block at all.
 *
 * Both make the legacy (toolCallId-less) path lean entirely on positional
 * pairing, so these fixtures pin that invariant instead of a synthetic one.
 */
const AUTO_SCREENSHOT =
  'Auto-screenshot after action: 1512x982 (scale: 2.00x)\n'
  + 'Examine the screenshot to verify the action result and determine next steps.';
const IMAGE_ONLY = '[image]';

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

    it('fails closed when a duplicate legacy raw id has lost one payload to eviction', () => {
      const steps = [
        step({ id: 'step-1', toolCallId: undefined }),
        step({ id: 'step-2', toolCallId: undefined }),
      ];
      const surviving = imageToolCall('duplicate-raw-id');
      const evicted = imageToolCall('duplicate-raw-id', { resultContent: undefined });

      const result = backfillDetailBlockImages(steps, [
        assistantMessage('msg-a', [surviving]),
        assistantMessage('msg-b', [evicted]),
      ]);

      expect(result[0].detailBlocks[0].imageData).toBeUndefined();
      expect(result[1].detailBlocks[0].imageData).toBeUndefined();
    });

    it('fails closed instead of cross-filling legacy duplicate provider ids', () => {
      const steps = [
        step({ id: 'step-1', toolCallId: 'call_1' }),
        step({ id: 'step-2', toolCallId: 'call_1' }),
      ];
      const messages = [
        assistantMessage('msg-a', [imageToolCall('call_1', {
          resultContent: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'FIRST' },
          }],
        })]),
        assistantMessage('msg-b', [imageToolCall('call_1', {
          resultContent: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'SECOND' },
          }],
        })]),
      ];

      const result = backfillDetailBlockImages(steps, messages);

      expect(result).toBe(steps);
      expect(result[0].detailBlocks[0].imageData).toBeUndefined();
      expect(result[1].detailBlocks[0].imageData).toBeUndefined();
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

      it('pairs repeated auto-screenshots — a real verbatim collision — by position', () => {
        // Three post-action screenshots on the same display: computerTools emits
        // the identical text for all three, so position is the ONLY signal.
        const steps = [
          step({ id: 'step-1', detailBlocks: [imageBlock('step-1', { content: AUTO_SCREENSHOT })] }),
          step({ id: 'step-2', detailBlocks: [imageBlock('step-2', { content: AUTO_SCREENSHOT })] }),
          step({ id: 'step-3', detailBlocks: [imageBlock('step-3', { content: AUTO_SCREENSHOT })] }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [
            imageToolCall('toolu_1', { name: 'computer', result: AUTO_SCREENSHOT }),
            imageToolCall('toolu_2', { name: 'computer', result: AUTO_SCREENSHOT }),
          ]),
          assistantMessage('msg-b', [
            imageToolCall('toolu_3', { name: 'computer', result: AUTO_SCREENSHOT }),
          ]),
        ]);

        // The order invariant: steps and toolCalls are built by the same
        // synchronous loop, so the Nth block belongs to the Nth tool call —
        // across message boundaries too.
        expect(result[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
        expect(result[1].detailBlocks[0].imageData?.base64).toBe('base64-toolu_2');
        expect(result[2].detailBlocks[0].imageData?.base64).toBe('base64-toolu_3');
      });

      it('pairs the bare "[image]" result string — the other real collision — by position', () => {
        const steps = [
          step({ id: 'step-1', detailBlocks: [imageBlock('step-1', { content: IMAGE_ONLY })] }),
          step({ id: 'step-2', detailBlocks: [imageBlock('step-2', { content: IMAGE_ONLY })] }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [
            imageToolCall('toolu_1', {
              result: IMAGE_ONLY,
              resultContent: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-toolu_1' } },
              ],
            }),
            imageToolCall('toolu_2', {
              result: IMAGE_ONLY,
              resultContent: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-toolu_2' } },
              ],
            }),
          ]),
        ]);
        expect(result[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
        expect(result[1].detailBlocks[0].imageData?.base64).toBe('base64-toolu_2');
      });

      it('gives up on colliding auto-screenshots when the counts disagree', () => {
        const steps = [
          step({ id: 'step-1', detailBlocks: [imageBlock('step-1', { content: AUTO_SCREENSHOT })] }),
          step({ id: 'step-2', detailBlocks: [imageBlock('step-2', { content: AUTO_SCREENSHOT })] }),
        ];

        const result = backfillDetailBlockImages(steps, [
          assistantMessage('msg-a', [
            imageToolCall('toolu_1', { result: AUTO_SCREENSHOT }),
            imageToolCall('toolu_2', { result: AUTO_SCREENSHOT }),
            imageToolCall('toolu_3', { result: AUTO_SCREENSHOT }),
          ]),
        ]);
        expect(result).toBe(steps);
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

    /**
     * This backfill re-runs on nearly every render (ChatView rebuilds
     * messageGroups unmemoized, so MessageGroup's memo sees a new `messages`
     * array each tick). Handing back a fresh payload object each time would
     * invalidate DetailBlockView's data-URL useMemo and re-concatenate a
     * multi-MB base64 string per finished group per tick.
     */
    describe('payload reference stability', () => {
      it('returns the identical imageData object across repeated calls', () => {
        const toolCall = imageToolCall('toolu_1');
        const messages = [assistantMessage('msg-a', [toolCall])];

        const first = backfillDetailBlockImages(
          [step({ id: 'step-1', toolCallId: 'toolu_1' })],
          messages,
        );
        const second = backfillDetailBlockImages(
          [step({ id: 'step-1', toolCallId: 'toolu_1' })],
          messages,
        );

        expect(first[0].detailBlocks[0].imageData).toBe(second[0].detailBlocks[0].imageData);
      });

      it('stays stable when the messages array is rebuilt around the same tool call', () => {
        // Exactly what ChatView does: a new array, same underlying objects.
        const toolCall = imageToolCall('toolu_1');
        const first = backfillDetailBlockImages(
          [step({ id: 'step-1', toolCallId: 'toolu_1' })],
          [assistantMessage('msg-a', [toolCall])],
        );
        const second = backfillDetailBlockImages(
          [step({ id: 'step-1', toolCallId: 'toolu_1' })],
          [assistantMessage('msg-a', [toolCall])],
        );

        expect(first[0].detailBlocks[0].imageData).toBe(second[0].detailBlocks[0].imageData);
      });

      it('picks up a genuinely changed tool call instead of serving a stale payload', () => {
        // immer replaces the object on change, so identity-keyed caching must
        // miss here — otherwise an edited result would render the old image.
        const before = backfillDetailBlockImages(
          [step({ id: 'step-1', toolCallId: 'toolu_1' })],
          [assistantMessage('msg-a', [imageToolCall('toolu_1')])],
        );
        const after = backfillDetailBlockImages(
          [step({ id: 'step-1', toolCallId: 'toolu_1' })],
          [
            assistantMessage('msg-a', [
              imageToolCall('toolu_1', {
                resultContent: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-updated' } },
                ],
              }),
            ]),
          ],
        );

        expect(before[0].detailBlocks[0].imageData?.base64).toBe('base64-toolu_1');
        expect(after[0].detailBlocks[0].imageData?.base64).toBe('base64-updated');
      });
    });
  });
});
