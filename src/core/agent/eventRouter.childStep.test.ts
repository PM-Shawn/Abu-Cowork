import { describe, it, expect, vi } from 'vitest';
import { createEventRouter, type EventRouterDeps } from './eventRouter';
import type { ExecutionPort } from './ports/executionPort';
import type { ExecutionStep } from '../../types/execution';
import type { ToolResultContent } from '../../types';

/**
 * Child-step (subagent tool) completion — the seam that used to drop images.
 *
 * `SubagentProgressEvent`'s tool-end now carries `resultContent`;
 * completeChildStep must turn an image block into the same image + result
 * detail blocks a top-level step gets in handleStepEnd, and must persist the
 * image-bearing tool call onto the parent message (hidden + fromSubagent) via
 * the appendMessageToolCall dep so snapshot backfill has a payload to join on.
 */

const PNG = 'aGVsbG8=';
const IMAGE_RESULT: ToolResultContent[] = [
  { type: 'text', text: 'Image: /tmp/shot.png (37KB, image/png)' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
];

function makeChildStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: 'child-1',
    executionId: 'exec-1',
    toolCallId: 'toolu_sub_1',
    type: 'tool',
    label: 'Screenshot',
    status: 'running',
    toolName: 'computer',
    toolInput: { action: 'screenshot' },
    source: 'agent',
    detailBlocks: [],
    ...overrides,
  };
}

function makeHarness(childOverrides: Partial<ExecutionStep> = {}) {
  const childStep = makeChildStep(childOverrides);
  const parentStep: ExecutionStep = {
    id: 'parent-1',
    executionId: 'exec-1',
    type: 'delegate',
    label: 'Delegate to researcher',
    status: 'running',
    toolName: 'delegate_to_agent',
    toolInput: { agent_name: 'researcher' },
    source: 'agent',
    detailBlocks: [],
    childSteps: [childStep],
  };
  const execution = {
    id: 'exec-1',
    conversationId: 'conv-1',
    loopId: 'loop-1',
    status: 'running',
    steps: [parentStep],
    plannedSteps: [],
    startTime: 0,
  };
  const updateChildStep = vi.fn();
  const addChildStep = vi.fn();
  const setStepResult = vi.fn();
  const setStepError = vi.fn();
  const addDetailBlock = vi.fn();
  const executionStore = {
    getExecutionByLoopId: vi.fn().mockReturnValue(execution),
    updateChildStep,
    addChildStep,
    setStepResult,
    setStepError,
    addDetailBlock,
  } as unknown as ExecutionPort;
  const appendMessageToolCall = vi.fn();
  const deps: EventRouterDeps = { executionStore, appendMessageToolCall };
  const router = createEventRouter(deps, 'en-US');
  return {
    router,
    updateChildStep,
    addChildStep,
    setStepResult,
    setStepError,
    addDetailBlock,
    appendMessageToolCall,
    childStep,
  };
}

describe('EventRouter delegate terminal channel', () => {
  it('trusts step-end as success even when a completed report starts with Error:', () => {
    const { router, setStepResult, addDetailBlock } = makeHarness();

    router.route({
      type: 'step-end',
      loopId: 'loop-1',
      stepId: 'parent-1',
      result: 'Error: this is a quoted heading in the completed report',
    });

    expect(setStepResult).toHaveBeenCalledWith(
      'exec-1',
      'parent-1',
      'Error: this is a quoted heading in the completed report',
    );
    expect(addDetailBlock).toHaveBeenCalledWith(
      'exec-1',
      'parent-1',
      expect.objectContaining({ type: 'result', labelKey: 'summary', isExpanded: false }),
    );
  });
});

describe('EventRouter.completeChildStep', () => {
  it('attaches an image + result detail block when resultContent carries an image', () => {
    const { router, updateChildStep } = makeHarness();

    router.completeChildStep('loop-1', 'parent-1', 'child-1', 'Image: /tmp/shot.png (37KB, image/png)', false, IMAGE_RESULT);

    expect(updateChildStep).toHaveBeenCalledTimes(1);
    const blocks = updateChildStep.mock.calls[0][5];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      id: 'child-1-image',
      type: 'image',
      labelKey: 'image',
      imageData: { mediaType: 'image/png', base64: PNG },
      isExpanded: true,
    });
    expect(blocks[1]).toMatchObject({ id: 'child-1-result', stepId: 'child-1' });
  });

  it('persists the image-bearing tool call onto the parent message as hidden + fromSubagent', () => {
    const { router, appendMessageToolCall } = makeHarness();

    router.completeChildStep('loop-1', 'parent-1', 'child-1', 'shot taken', false, IMAGE_RESULT);

    expect(appendMessageToolCall).toHaveBeenCalledTimes(1);
    expect(appendMessageToolCall).toHaveBeenCalledWith('loop-1', {
      id: 'toolu_sub_1',
      name: 'computer',
      input: { action: 'screenshot' },
      result: 'shot taken',
      resultContent: IMAGE_RESULT,
      isError: undefined,
      hidden: true,
      fromSubagent: true,
    });
  });

  it('adds no detail blocks and records nothing for a text-only result', () => {
    const { router, updateChildStep, appendMessageToolCall } = makeHarness();

    router.completeChildStep('loop-1', 'parent-1', 'child-1', 'plain text', false, [
      { type: 'text', text: 'plain text' },
    ]);

    expect(updateChildStep).toHaveBeenCalledWith('exec-1', 'parent-1', 'child-1', 'plain text', false, undefined);
    expect(appendMessageToolCall).not.toHaveBeenCalled();
  });

  it('adds no detail blocks and records nothing when resultContent is absent (string tools)', () => {
    const { router, updateChildStep, appendMessageToolCall } = makeHarness();

    router.completeChildStep('loop-1', 'parent-1', 'child-1', 'ok', false);

    expect(updateChildStep).toHaveBeenCalledWith('exec-1', 'parent-1', 'child-1', 'ok', false, undefined);
    expect(appendMessageToolCall).not.toHaveBeenCalled();
  });

  it('still renders the image but skips persistence when the child step has no toolCallId', () => {
    const { router, updateChildStep, appendMessageToolCall } = makeHarness({ toolCallId: undefined });

    router.completeChildStep('loop-1', 'parent-1', 'child-1', 'shot', false, IMAGE_RESULT);

    const blocks = updateChildStep.mock.calls[0][5];
    expect(blocks).toHaveLength(2);
    expect(appendMessageToolCall).not.toHaveBeenCalled();
  });

  it('marks the recorded tool call as an error when the subagent tool failed', () => {
    const { router, appendMessageToolCall } = makeHarness();

    router.completeChildStep('loop-1', 'parent-1', 'child-1', 'Error: boom', true, IMAGE_RESULT);

    expect(appendMessageToolCall).toHaveBeenCalledWith('loop-1', expect.objectContaining({ isError: true }));
  });
});

describe('EventRouter.addChildStepToDelegate', () => {
  it('stamps the subagent tool_use id onto the child step for snapshot backfill', () => {
    const { router, addChildStep } = makeHarness();

    router.addChildStepToDelegate('loop-1', 'parent-1', {
      toolName: 'computer',
      toolInput: { action: 'screenshot' },
      toolCallId: 'toolu_sub_9',
    });

    expect(addChildStep).toHaveBeenCalledTimes(1);
    const created = addChildStep.mock.calls[0][2] as ExecutionStep;
    expect(created.toolCallId).toBe('toolu_sub_9');
  });
});
