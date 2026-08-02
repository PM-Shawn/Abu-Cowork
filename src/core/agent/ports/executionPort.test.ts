import { describe, it, expect, afterEach } from 'vitest';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import type { ExecutionStep, DetailBlock } from '@/types/execution';
import {
  createInProcessExecutionPort,
  getExecutionPort,
  setExecutionPort,
  type ExecutionPort,
} from './executionPort';

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: 'step-1',
    executionId: 'exec-1',
    type: 'tool',
    label: 'test step',
    status: 'running',
    toolName: 'test_tool',
    toolInput: {},
    source: 'agent',
    detailBlocks: [],
    ...overrides,
  };
}

function makeDetailBlock(overrides: Partial<DetailBlock> = {}): DetailBlock {
  return {
    id: 'block-1',
    stepId: 'step-1',
    type: 'result',
    label: 'result',
    content: 'hello',
    isTruncated: false,
    ...overrides,
  };
}

describe('createInProcessExecutionPort', () => {
  afterEach(() => {
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
  });

  it('createExecution() creates and returns a running TaskExecution', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    expect(exec.conversationId).toBe('conv-1');
    expect(exec.loopId).toBe('loop-1');
    expect(exec.status).toBe('running');
    expect(useTaskExecutionStore.getState().executions[exec.id]).toEqual(exec);
  });

  it('cancelExecution() marks the execution as cancelled', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.cancelExecution(exec.id);
    expect(useTaskExecutionStore.getState().executions[exec.id]?.status).toBe('cancelled');
  });

  it('getExecutionByLoopId() finds the execution created for that loopId', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-42');
    expect(port.getExecutionByLoopId('loop-42')?.id).toBe(exec.id);
  });

  it('getExecutionByLoopId() returns undefined for an unknown loopId', () => {
    const port = createInProcessExecutionPort();
    expect(port.getExecutionByLoopId('does-not-exist')).toBeUndefined();
  });

  it('getExecutionByConversationId() finds the execution created for that conversationId', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-99', 'loop-1');
    expect(port.getExecutionByConversationId('conv-99')?.id).toBe(exec.id);
  });

  it('getExecutionByConversationId() returns undefined for an unknown conversationId', () => {
    const port = createInProcessExecutionPort();
    expect(port.getExecutionByConversationId('does-not-exist')).toBeUndefined();
  });

  it('evictExecution() removes a non-running execution from the store', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    // evictExecution only evicts non-running executions (see taskExecutionStore.ts) —
    // cancel first so the eviction guard doesn't no-op.
    port.cancelExecution(exec.id);
    port.evictExecution(exec.id);
    expect(useTaskExecutionStore.getState().executions[exec.id]).toBeUndefined();
  });

  it('reflects store updates made outside the port on the next call (not cached)', () => {
    const port = createInProcessExecutionPort();
    expect(port.getExecutionByLoopId('loop-x')).toBeUndefined();
    const exec = useTaskExecutionStore.getState().createExecution('conv-1', 'loop-x');
    expect(port.getExecutionByLoopId('loop-x')?.id).toBe(exec.id);
  });
});

// P1-3b-pre: the step-mutation family folded in to cover eventRouter.ts's
// `deps.executionStore` DI seam (previously a raw `taskExecutionStore`
// capture in agentLoop.ts — see this file's top-level JSDoc "Scope note").
describe('createInProcessExecutionPort — step-mutation family', () => {
  afterEach(() => {
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
  });

  it('completeExecution() marks the execution completed', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.completeExecution(exec.id);
    expect(useTaskExecutionStore.getState().executions[exec.id]?.status).toBe('completed');
  });

  it('errorExecution() marks the execution errored', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.errorExecution(exec.id, 'boom');
    expect(useTaskExecutionStore.getState().executions[exec.id]?.status).toBe('error');
  });

  it('addStep() pushes a step onto the execution', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.addStep(exec.id, makeStep({ id: 'step-1', executionId: exec.id }));
    expect(useTaskExecutionStore.getState().executions[exec.id]?.steps).toHaveLength(1);
    expect(useTaskExecutionStore.getState().executions[exec.id]?.steps[0].id).toBe('step-1');
  });

  it('setStepResult() sets the tool result and completes the step', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.addStep(exec.id, makeStep({ id: 'step-1', executionId: exec.id }));
    port.setStepResult(exec.id, 'step-1', 'ok');
    const step = useTaskExecutionStore.getState().executions[exec.id]?.steps[0];
    expect(step?.toolResult).toBe('ok');
    expect(step?.status).toBe('completed');
  });

  it('setStepError() sets the error message and errors the step', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.addStep(exec.id, makeStep({ id: 'step-1', executionId: exec.id }));
    port.setStepError(exec.id, 'step-1', 'nope');
    const step = useTaskExecutionStore.getState().executions[exec.id]?.steps[0];
    expect(step?.errorMessage).toBe('nope');
    expect(step?.status).toBe('error');
  });

  it('addChildStep() / updateChildStep() nest and update a delegate child step', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.addStep(exec.id, makeStep({ id: 'parent-1', executionId: exec.id, type: 'delegate' }));
    port.addChildStep(exec.id, 'parent-1', makeStep({ id: 'child-1', executionId: exec.id }));
    let parent = useTaskExecutionStore.getState().executions[exec.id]?.steps[0];
    expect(parent?.childSteps).toHaveLength(1);

    port.updateChildStep(exec.id, 'parent-1', 'child-1', 'child result', false);
    parent = useTaskExecutionStore.getState().executions[exec.id]?.steps[0];
    expect(parent?.childSteps?.[0].toolResult).toBe('child result');
    expect(parent?.childSteps?.[0].status).toBe('completed');
  });

  it('addDetailBlock() pushes a detail block onto the step', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.addStep(exec.id, makeStep({ id: 'step-1', executionId: exec.id }));
    port.addDetailBlock(exec.id, 'step-1', makeDetailBlock({ stepId: 'step-1' }));
    expect(useTaskExecutionStore.getState().executions[exec.id]?.steps[0].detailBlocks).toHaveLength(1);
  });

  it('appendThinking() / setThinkingDuration() accumulate thinking text and set duration', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.appendThinking(exec.id, 'hello ');
    port.appendThinking(exec.id, 'world');
    port.setThinkingDuration(exec.id, 3);
    const stored = useTaskExecutionStore.getState().executions[exec.id];
    expect(stored?.thinking).toBe('hello world');
    expect(stored?.thinkingDuration).toBe(3);
  });

  it('setUsage() sets token usage on the execution', () => {
    const port = createInProcessExecutionPort();
    const exec = port.createExecution('conv-1', 'loop-1');
    port.setUsage(exec.id, { inputTokens: 10, outputTokens: 20 });
    expect(useTaskExecutionStore.getState().executions[exec.id]?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});

describe('getExecutionPort / setExecutionPort', () => {
  const defaultPort = getExecutionPort();

  afterEach(() => {
    // restore the default in-process port so other test files aren't affected
    setExecutionPort(defaultPort);
  });

  it('getExecutionPort() returns a working in-process port by default', () => {
    const port = getExecutionPort();
    expect(typeof port.createExecution).toBe('function');
    expect(typeof port.cancelExecution).toBe('function');
    expect(typeof port.getExecutionByLoopId).toBe('function');
    expect(typeof port.evictExecution).toBe('function');
  });

  it('setExecutionPort() swaps the module-level port returned by getExecutionPort()', () => {
    const stub: ExecutionPort = {
      createExecution: () => ({
        id: 'stub-exec',
        conversationId: 'c',
        loopId: 'l',
        status: 'running',
        startTime: 0,
        plannedSteps: [],
        planParsed: false,
        steps: [],
      }),
      cancelExecution: () => {},
      getExecutionByLoopId: () => undefined,
      getExecutionByConversationId: () => undefined,
      evictExecution: () => {},
      completeExecution: () => {},
      errorExecution: () => {},
      addStep: () => {},
      setStepResult: () => {},
      setStepError: () => {},
      addChildStep: () => {},
      updateChildStep: () => {},
      addDetailBlock: () => {},
      appendThinking: () => {},
      setThinkingDuration: () => {},
      setUsage: () => {},
    };
    setExecutionPort(stub);
    expect(getExecutionPort()).toBe(stub);
    expect(getExecutionPort().createExecution('c', 'l').id).toBe('stub-exec');
  });
});
