import { describe, expect, it, vi } from 'vitest';
import { EventRouter } from './eventRouter';
import type { ExecutionPort } from './ports/executionPort';
import type { ExecutionStep, TaskExecution } from '@/types/execution';

function createHarness() {
  const step: ExecutionStep = {
    id: 'internal-step-id',
    executionId: 'exec-1',
    toolCallId: 'toolu-provider-id',
    type: 'file-read',
    label: 'Read file',
    status: 'running',
    toolName: 'read_file',
    toolInput: { path: '/tmp/chart.png' },
    source: 'agent',
    detailBlocks: [],
  };
  const execution: TaskExecution = {
    id: 'exec-1',
    conversationId: 'conv-1',
    loopId: 'loop-1',
    status: 'running',
    startTime: 0,
    plannedSteps: [],
    planParsed: false,
    steps: [step],
  };
  const executionStore = {
    getExecutionByLoopId: vi.fn(() => execution),
    setStepResult: vi.fn(),
    setStepError: vi.fn(),
    addDetailBlock: vi.fn(),
  } as unknown as ExecutionPort;
  const appendToolCallContext = vi.fn();

  return {
    router: new EventRouter({ executionStore, appendToolCallContext }),
    appendToolCallContext,
  };
}

describe('EventRouter tool-call context ids', () => {
  it('forwards the provider tool_use id when a step succeeds', async () => {
    const { router, appendToolCallContext } = createHarness();

    await router.route({
      type: 'step-end',
      loopId: 'loop-1',
      stepId: 'internal-step-id',
      result: 'ok',
    });

    expect(appendToolCallContext).toHaveBeenCalledWith('loop-1', {
      id: 'toolu-provider-id',
      name: 'read_file',
      input: { path: '/tmp/chart.png' },
      result: 'ok',
    });
  });

  it('forwards the provider tool_use id when a step fails', async () => {
    const { router, appendToolCallContext } = createHarness();

    await router.route({
      type: 'step-error',
      loopId: 'loop-1',
      stepId: 'internal-step-id',
      error: 'disk unavailable',
    });

    expect(appendToolCallContext).toHaveBeenCalledWith('loop-1', {
      id: 'toolu-provider-id',
      name: 'read_file',
      input: { path: '/tmp/chart.png' },
      result: 'Error: disk unavailable',
    });
  });
});
