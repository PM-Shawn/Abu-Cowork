import { describe, expect, it } from 'vitest';
import {
  createComputerUseController,
  type ComputerAxElement,
  type ComputerObservationInput,
  ComputerUseStateError,
  verifyComputerEffect,
} from './computerUseController';

const runA = { conversationId: 'conversation-a', loopId: 'loop-a' };
const runB = { conversationId: 'conversation-b', loopId: 'loop-b' };

function element(overrides: Partial<ComputerAxElement> = {}): ComputerAxElement {
  return {
    id: 1,
    role: 'AXTextField',
    label: 'Name',
    value: '',
    bounds: [10, 20, 100, 30],
    actions: ['AXSetValue'],
    depth: 2,
    ...overrides,
  };
}

function observation(overrides: Partial<ComputerObservationInput> = {}): ComputerObservationInput {
  return {
    target: { appName: 'Notes', bundleId: 'com.apple.Notes', processId: 42 },
    axSessionId: 'ax-session-1',
    elements: [element()],
    capabilityTier: 'structured',
    ...overrides,
  };
}

function makeController() {
  let now = 1_000;
  let id = 0;
  return {
    controller: createComputerUseController({
      now: () => now,
      createStateId: () => `state-${++id}`,
    }),
    advance(ms: number) {
      now += ms;
    },
  };
}

function expectStateError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerUseStateError);
    expect((error as ComputerUseStateError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ComputerUseStateError(${code})`);
}

describe('computerUseController', () => {
  it('isolates observations by conversation and loop', () => {
    const { controller } = makeController();
    const stateA = controller.recordObservation(runA, observation({ axSessionId: 'ax-a' }));
    const stateB = controller.recordObservation(runB, observation({ axSessionId: 'ax-b' }));

    expect(controller.getLatestState(runA)).toBe(stateA);
    expect(controller.getLatestState(runB)).toBe(stateB);
    expect(stateA.stateId).not.toBe(stateB.stateId);
  });

  it('requires the latest observed state before a write action', () => {
    const { controller } = makeController();
    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: 'missing',
      consequence: 'none',
    }), 'state-required');

    const state = controller.recordObservation(runA, observation());
    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: 'older-state',
      consequence: 'none',
    }), 'state-mismatch');
    expect(controller.getLatestState(runA)).toBe(state);
  });

  it('expires observations after thirty seconds', () => {
    const { controller, advance } = makeController();
    const state = controller.recordObservation(runA, observation());
    advance(30_001);

    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      consequence: 'none',
    }), 'state-expired');
  });

  it('rejects a target identity that differs from the observation', () => {
    const { controller } = makeController();
    const state = controller.recordObservation(runA, observation());

    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      target: { appName: 'Mail', bundleId: 'com.apple.mail', processId: 99 },
      consequence: 'none',
    }), 'target-mismatch');
  });

  it('consumes state before dispatch and does not make it reusable after failure', () => {
    const { controller } = makeController();
    const state = controller.recordObservation(runA, observation());
    controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      consequence: 'none',
    });
    controller.failAction(runA);

    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      consequence: 'none',
    }), 'state-consumed');
  });

  it('allows only one write action in flight for a run', () => {
    const { controller } = makeController();
    const state = controller.recordObservation(runA, observation());
    controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      consequence: 'none',
    });

    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      consequence: 'none',
    }), 'action-in-flight');
  });

  it('requires a specific expected effect for consequential actions', () => {
    const { controller } = makeController();
    const state = controller.recordObservation(runA, observation());

    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      consequence: 'send',
      expectedEffect: { type: 'any-state-change' },
    }), 'weak-verification-for-consequence');
  });

  it('records a new state and verifies a changed element value after an action', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation());
    controller.prepareAction(runA, {
      expectedStateId: before.stateId,
      consequence: 'none',
    });

    const result = controller.completeAction(
      runA,
      before,
      observation({
        axSessionId: 'ax-session-2',
        elements: [element({ value: 'Shawn' })],
      }),
      { type: 'element-value', elementId: 1, equals: 'Shawn' },
    );

    expect(result.state?.stateId).toBe('state-2');
    expect(result.state?.axDiff).toEqual({ added: [], removed: [], changed: [1] });
    expect(result.verification.status).toBe('verified-change');
    expect(result.verification.reason).toBe('expected-effect-observed');
  });

  it('reports no-change and ambiguous verification outcomes', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation());
    const unchanged = controller.recordObservation(runA, observation({ axSessionId: 'ax-session-2' }));

    expect(verifyComputerEffect(before, unchanged, { type: 'any-state-change' })).toMatchObject({
      status: 'no-change',
      reason: 'state-unchanged',
    });
    expect(verifyComputerEffect(before, null, { type: 'any-state-change' })).toMatchObject({
      status: 'ambiguous',
      reason: 'observation-failed',
    });
  });

  it('invalidates one run without touching another run', () => {
    const { controller } = makeController();
    controller.recordObservation(runA, observation({ axSessionId: 'ax-a' }));
    const stateB = controller.recordObservation(runB, observation({ axSessionId: 'ax-b' }));

    expect(controller.invalidate(runA)).toBe('ax-a');
    expect(controller.getLatestState(runA)).toBeNull();
    expect(controller.getLatestState(runB)).toBe(stateB);
  });

  it('allows one recovery after three unchanged actions, then stops after two more', () => {
    const { controller } = makeController();
    let state = controller.recordObservation(runA, observation());
    const decisions: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      controller.prepareAction(runA, {
        expectedStateId: state.stateId,
        consequence: 'none',
      });
      const completed = controller.completeAction(
        runA,
        state,
        observation({ axSessionId: `ax-session-${index + 2}` }),
        { type: 'any-state-change' },
      );
      decisions.push(controller.assessProgress(
        runA,
        completed.verification,
        'none',
      ).decision);
      state = completed.state!;
      if (index < 4) {
        controller.clearObservation(runA);
        state = controller.recordObservation(
          runA,
          observation({ axSessionId: `fresh-session-${index}` }),
        );
      }
    }

    expect(decisions).toEqual([
      'continue',
      'continue',
      'recover',
      'continue',
      'stop-no-progress',
    ]);
    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      consequence: 'none',
    }), 'run-stopped');
  });

  it('stops a run immediately when a consequential action has an ambiguous result', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation());
    controller.prepareAction(runA, {
      expectedStateId: before.stateId,
      consequence: 'send',
      expectedEffect: { type: 'element-value', elementId: 1, equals: 'sent' },
    });
    const completed = controller.completeAction(
      runA,
      before,
      null,
      { type: 'element-value', elementId: 1, equals: 'sent' },
    );

    expect(controller.assessProgress(
      runA,
      completed.verification,
      'send',
    ).decision).toBe('stop-ambiguous-side-effect');
    controller.recordObservation(runA, observation({ axSessionId: 'fresh-session' }));
    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: controller.getLatestState(runA)!.stateId,
      consequence: 'send',
      expectedEffect: { type: 'element-value', elementId: 1, equals: 'sent' },
    }), 'run-stopped');
  });
});
