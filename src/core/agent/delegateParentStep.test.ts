import { describe, it, expect, vi } from 'vitest';
import { createParentStepResolver } from './delegateParentStep';

const executions = new Map<string, { steps: Array<{ id: string; toolCallId?: string }> }>();
vi.mock('./ports/executionPort', () => ({
  getExecutionPort: () => ({ getExecutionByLoopId: (loopId: string) => executions.get(loopId) }),
}));

function ctx(over: Partial<{ toolCallToStepId: Map<string, string>; running: string | null }> = {}) {
  return {
    loopId: 'loop-1',
    toolCallToStepId: over.toolCallToStepId ?? new Map<string, string>(),
    eventRouter: { getCurrentStepId: () => over.running ?? null } as never,
  };
}

describe('createParentStepResolver', () => {
  it('finds the step by tool call id only once the step exists, then caches it', () => {
    executions.clear();
    const resolve = createParentStepResolver(ctx(), 'call-1');
    expect(resolve()).toBeUndefined();
    executions.set('loop-1', { steps: [{ id: 'step-delegate', toolCallId: 'call-1' }] });
    expect(resolve()).toBe('step-delegate');
    executions.clear();
    expect(resolve()).toBe('step-delegate');
  });

  it('prefers the mapped step, then the running step, then the last mapped step', () => {
    executions.clear();
    expect(createParentStepResolver(ctx({ toolCallToStepId: new Map([['call-1', 'mapped']]) }), 'call-1')()).toBe('mapped');
    expect(createParentStepResolver(ctx({ running: 'running-step' }), undefined)()).toBe('running-step');
    expect(createParentStepResolver(ctx({ toolCallToStepId: new Map([['a', 's1'], ['b', 's2']]) }), undefined)()).toBe('s2');
  });
});

it('does not cache a sibling while its explicit parent frame is delayed (F6)', () => {
  executions.clear();
  const mapping = new Map([['sibling-call', 'sibling-step']]);
  const resolve = createParentStepResolver(ctx({ toolCallToStepId: mapping, running: 'sibling-step' }), 'own-call');
  expect(resolve()).toBeUndefined();
  mapping.set('own-call', 'own-step');
  expect(resolve()).toBe('own-step');
});
