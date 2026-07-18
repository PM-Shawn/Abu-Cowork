import { describe, it, expect, afterEach } from 'vitest';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import {
  createInProcessExecutionPort,
  getExecutionPort,
  setExecutionPort,
  type ExecutionPort,
} from './executionPort';

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
      evictExecution: () => {},
    };
    setExecutionPort(stub);
    expect(getExecutionPort()).toBe(stub);
    expect(getExecutionPort().createExecution('c', 'l').id).toBe('stub-exec');
  });
});
