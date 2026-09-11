import { describe, expect, it } from 'vitest';
import {
  createComputerUseController,
  type ComputerAxElement,
  type ComputerObservationInput,
  type ExpectedEffect,
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
    target: { windowRef: null, appName: 'Notes', bundleId: 'com.apple.Notes', processId: 42 },
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
      target: { windowRef: null, appName: 'Mail', bundleId: 'com.apple.mail', processId: 99 },
      consequence: 'none',
    }), 'target-mismatch');
  });

  it('rejects the same app and process when the WindowRef differs', () => {
    const { controller } = makeController();
    const state = controller.recordObservation(runA, observation({
      target: {
        windowRef: 'wr-a', appName: 'Notes', bundleId: 'com.apple.Notes', processId: 42,
      },
    }));

    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: state.stateId,
      target: {
        windowRef: 'wr-b', appName: 'Notes', bundleId: 'com.apple.Notes', processId: 42,
      },
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

  // An element id is a per-snapshot index, so it is identity only when the
  // element's role and label survive the action to corroborate it. These two
  // pin both halves of that rule on the completeAction path, not just on
  // verifyComputerEffect. The durable fix is to carry the platform's own
  // element identity (Windows UIA exposes a runtime id the native helper
  // already validates against) through to the renderer; until then corroboration
  // is what separates a real verification from a neighbouring element's value.
  it('verifies an element-value expectation when role and label corroborate the id', () => {
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
    expect(result.verification).toMatchObject({
      status: 'verified-change',
      observation: 'changed',
      expectation: 'satisfied',
      reason: 'expected-effect-observed',
    });
  });

  it('does not treat a repeated numeric id as stable element identity', () => {
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
        // Same id 1, but it now names a different control entirely.
        elements: [element({ role: 'AXButton', label: 'Save', value: 'Shawn' })],
      }),
      { type: 'element-value', elementId: 1, equals: 'Shawn' },
    );

    expect(result.state?.stateId).toBe('state-2');
    expect(result.state?.axDiff).toEqual({ added: [], removed: [], changed: [1] });
    expect(result.verification).toMatchObject({
      status: 'ambiguous',
      observation: 'changed',
      expectation: 'unverifiable',
      reason: 'effect-not-observable',
    });
  });

  it('keeps an element-value expectation unverifiable when indices are reassigned', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation({
      elements: [
        element({ id: 1, role: 'AXTextField', label: 'Name', value: '' }),
        element({ id: 2, role: 'AXButton', label: 'Save', value: null }),
      ],
    }));
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      elements: [
        element({ id: 1, role: 'AXButton', label: 'Save', value: 'Shawn' }),
        element({ id: 2, role: 'AXTextField', label: 'Name', value: '' }),
      ],
    }));

    expect(verifyComputerEffect(
      before,
      after,
      { type: 'element-value', elementId: 1, equals: 'Shawn' },
    )).toMatchObject({
      status: 'ambiguous',
      observation: 'changed',
      expectation: 'unverifiable',
      reason: 'effect-not-observable',
    });
  });

  it('does not treat the target bundle as frontmost-app evidence', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation());
    const after = controller.recordObservation(runA, observation({ axSessionId: 'ax-session-2' }));

    expect(verifyComputerEffect(
      before,
      after,
      { type: 'frontmost-app', bundleId: 'com.apple.Notes' },
    )).toMatchObject({
      status: 'ambiguous',
      observation: 'unchanged',
      expectation: 'unverifiable',
      reason: 'effect-not-observable',
    });
  });

  it.each([
    { name: 'no matcher fields', effect: { type: 'element-appears' } },
    { name: 'empty role', effect: { type: 'element-appears', role: '' } },
    { name: 'whitespace label', effect: { type: 'element-appears', label: '   ' } },
    {
      name: 'empty role and whitespace label',
      effect: { type: 'element-appears', role: '', label: '\t' },
    },
  ] satisfies Array<{ name: string; effect: ExpectedEffect }>) (
    'keeps element-appears unverifiable with $name',
    ({ effect }) => {
      const { controller } = makeController();
      const before = controller.recordObservation(runA, observation());
      const after = controller.recordObservation(runA, observation({
        axSessionId: 'ax-session-2',
        elements: [element({ role: 'AXDialog', label: 'Sent' })],
      }));

      expect(verifyComputerEffect(before, after, effect)).toMatchObject({
        status: 'ambiguous',
        observation: 'changed',
        expectation: 'unverifiable',
        reason: 'effect-not-observable',
      });
    },
  );

  it.each([
    {
      name: 'role only',
      effect: { type: 'element-appears', role: 'AXDialog' },
    },
    {
      name: 'label only',
      effect: { type: 'element-appears', label: 'Sent' },
    },
  ] satisfies Array<{ name: string; effect: ExpectedEffect }>) (
    'satisfies a non-empty element-appears matcher with $name',
    ({ effect }) => {
      const { controller } = makeController();
      const before = controller.recordObservation(runA, observation());
      const after = controller.recordObservation(runA, observation({
        axSessionId: 'ax-session-2',
        elements: [element({ role: 'AXDialog', label: 'Sent' })],
      }));

      expect(verifyComputerEffect(before, after, effect)).toMatchObject({
        expectation: 'satisfied',
        reason: 'expected-effect-observed',
      });
    },
  );

  // Regression: routing expectation evidence through deriveVerificationEvidence
  // once left only element-appears evaluated, so every other effect type became
  // permanently unverifiable — a verified write degraded to ambiguous, which
  // stops the run. Only src/eval's replay manifest caught it, and scoped reviews
  // of this file do not run that manifest. Assert the decidable arms here too.
  const named = element({ id: 1, role: 'AXTextField', label: 'Name', value: 'draft' });
  const saveButton = element({ id: 2, role: 'AXButton', label: 'Save', value: null });

  it.each([
    {
      name: 'element-value',
      afterElements: [element({ id: 1, role: 'AXTextField', label: 'Name', value: 'sent' })],
      satisfied: { type: 'element-value', elementId: 1, equals: 'sent' },
      notSatisfied: { type: 'element-value', elementId: 1, equals: 'draft' },
    },
    {
      name: 'element-state on value',
      afterElements: [element({ id: 1, role: 'AXTextField', label: 'Name', value: 'sent' })],
      satisfied: { type: 'element-state', elementId: 1, attribute: 'value', equals: 'sent' },
      notSatisfied: { type: 'element-state', elementId: 1, attribute: 'value', equals: 'draft' },
    },
    {
      name: 'element-disappears',
      // The Save button is gone; the Name field survives, so asserting that IT
      // disappeared must come back not-satisfied rather than unverifiable.
      afterElements: [element({ id: 1, role: 'AXTextField', label: 'Name', value: 'sent' })],
      satisfied: { type: 'element-disappears', elementId: 2 },
      notSatisfied: { type: 'element-disappears', elementId: 1 },
    },
  ] satisfies Array<{
    name: string;
    afterElements: ComputerAxElement[];
    satisfied: ExpectedEffect;
    notSatisfied: ExpectedEffect;
  }>)('decides $name instead of reporting it unverifiable', (testCase) => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation({
      elements: [named, saveButton],
    }));
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      elements: testCase.afterElements,
    }));

    expect(verifyComputerEffect(before, after, testCase.satisfied)).toMatchObject({
      status: 'verified-change',
      expectation: 'satisfied',
      reason: 'expected-effect-observed',
    });
    expect(verifyComputerEffect(before, after, testCase.notSatisfied)).toMatchObject({
      status: 'no-change',
      expectation: 'not-satisfied',
      reason: 'expected-effect-not-observed',
    });
  });

  // Review finding: a boolean `equals` reaches here (parseExpectedEffect accepts
  // one) and used to compare string-or-null against true, which can only be
  // false — reporting a check that was never possible as a check that failed,
  // and latching the terminal stop-expectation-not-satisfied.
  it('keeps element-state unverifiable when equals is not a string', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation({
      elements: [element({ id: 3, role: 'AXCheckBox', label: 'Done', value: 'off' })],
    }));
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      elements: [element({ id: 3, role: 'AXCheckBox', label: 'Done', value: 'on' })],
    }));

    expect(verifyComputerEffect(before, after, {
      type: 'element-state',
      elementId: 3,
      attribute: 'value',
      equals: true,
    })).toMatchObject({
      status: 'ambiguous',
      expectation: 'unverifiable',
      reason: 'effect-not-observable',
    });
  });

  // Review finding: matching the departed element only by role+label called a
  // real disappearance a failure whenever a same-kind sibling survived — a
  // modal's OK button next to the OK button in the window behind it.
  it('sees a disappearance even when a same-kind sibling survives', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation({
      elements: [
        element({ id: 5, role: 'AXButton', label: 'OK' }),
        element({ id: 6, role: 'AXButton', label: 'OK' }),
      ],
    }));
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      elements: [element({ id: 6, role: 'AXButton', label: 'OK' })],
    }));

    expect(verifyComputerEffect(before, after, { type: 'element-disappears', elementId: 5 }))
      .toMatchObject({ expectation: 'satisfied', reason: 'expected-effect-observed' });
  });

  it('will not claim an element survived when its kind was swapped out', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation({
      elements: [element({ id: 5, role: 'AXButton', label: 'OK' })],
    }));
    // Same population of AXButton/OK, but id 5 now names something else — the
    // original may have gone and a new one arrived, and nothing distinguishes them.
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      elements: [
        element({ id: 5, role: 'AXMenuItem', label: 'Close' }),
        element({ id: 7, role: 'AXButton', label: 'OK' }),
      ],
    }));

    expect(verifyComputerEffect(before, after, { type: 'element-disappears', elementId: 5 }))
      .toMatchObject({ expectation: 'unverifiable', reason: 'effect-not-observable' });
  });

  it('keeps element-state unverifiable for an attribute the observation cannot expose', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation());
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      elements: [element({ value: 'sent' })],
    }));

    expect(verifyComputerEffect(before, after, {
      type: 'element-state',
      elementId: 1,
      attribute: 'checked',
      equals: 'true',
    })).toMatchObject({
      status: 'ambiguous',
      expectation: 'unverifiable',
      reason: 'effect-not-observable',
    });
  });

  it('uses whitespace only for matcher presence and keeps non-empty matching exact', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation());
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      elements: [element({ role: 'AXDialog', label: 'Sent' })],
    }));

    expect(verifyComputerEffect(
      before,
      after,
      { type: 'element-appears', label: ' Sent ' },
    )).toMatchObject({
      expectation: 'not-satisfied',
      reason: 'expected-effect-not-observed',
    });
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

  it('treats an identical replacement modal HWND as a state change', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation({
      modalWindowId: 'hwnd:0x200',
    }));
    const after = controller.recordObservation(runA, observation({
      axSessionId: 'ax-session-2',
      modalWindowId: 'hwnd:0x201',
    }));

    expect(verifyComputerEffect(before, after, { type: 'any-state-change' })).toMatchObject({
      status: 'verified-change',
      reason: 'state-changed',
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

  it('stops immediately when a reliable explicit expectation is not satisfied', () => {
    const { controller } = makeController();
    const before = controller.recordObservation(runA, observation());
    controller.prepareAction(runA, {
      expectedStateId: before.stateId,
      consequence: 'none',
      expectedEffect: { type: 'element-appears', role: 'AXDialog', label: 'Sent' },
    });
    const completed = controller.completeAction(
      runA,
      before,
      observation({ axSessionId: 'ax-session-2' }),
      { type: 'element-appears', role: 'AXDialog', label: 'Sent' },
    );

    expect(completed.verification).toMatchObject({
      observation: 'unchanged',
      expectation: 'not-satisfied',
    });
    expect(controller.assessProgress(
      runA,
      completed.verification,
      'none',
    ).decision).toBe('stop-expectation-not-satisfied');
    expectStateError(() => controller.prepareAction(runA, {
      expectedStateId: completed.state!.stateId,
      consequence: 'none',
    }), 'run-stopped');
  });
});
