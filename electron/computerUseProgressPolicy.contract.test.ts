// @vitest-environment node

/**
 * Contract test: the Host Gate's no-progress decision must agree with the
 * renderer's `computerUseController.assessProgress` on every shared fixture.
 *
 * Why this exists: Computer Use judges the same action twice. The Host Gate has
 * to, because it is the boundary the step/duration budget exists to restrain —
 * the renderer is the process being restrained and cannot be trusted to police
 * itself (see the budget comment atop `computerUseGate.cjs`). The renderer has
 * to, because it is the side holding the model's `expected_effect`. Until
 * 2026-09-11 both sides hardcoded the same `3` and `2` and the same decision
 * vocabulary, and stayed equal only because nobody had yet changed one of them.
 * The thresholds now come from `computerUsePolicy.json`; this replay is what
 * keeps the two state machines themselves from drifting apart.
 *
 * Same shape as `messageLedgerFold.contract.test.ts` — one spec, two consumers.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  createComputerUseController,
  type ComputerVerificationStatus,
} from '../src/core/agent/computerUseController';
import policy from '../src/core/tools/computerUsePolicy.json';

const require_ = createRequire(import.meta.url);
const { decideNoProgress, NO_PROGRESS_BEFORE_RECOVERY, NO_PROGRESS_AFTER_RECOVERY } = require_(
  './computerUseGate.cjs',
) as {
  decideNoProgress: (
    state: { consecutiveNoChange: number; recoveryUsed: boolean },
    changed: boolean,
  ) => { decision: string; consecutiveNoChange: number; recoveryUsed: boolean };
  NO_PROGRESS_BEFORE_RECOVERY: number;
  NO_PROGRESS_AFTER_RECOVERY: number;
};

/**
 * Observation sequences, written as what the tier actually sees: whether the UI
 * changed. `verified-change` is the renderer's word for `changed: true`.
 */
const SEQUENCES: Array<{ name: string; changes: boolean[] }> = [
  { name: 'a single unchanged observation', changes: [false] },
  { name: 'unchanged until the recovery threshold', changes: [false, false, false] },
  { name: 'unchanged past recovery into a stop', changes: [false, false, false, false, false] },
  { name: 'a change resetting the counter', changes: [false, false, true, false] },
  { name: 'alternating change and no-change', changes: [false, true, false, true, false] },
  { name: 'a change before any no-change', changes: [true, false, false, false] },
  {
    name: 'no-change past a stop, to pin post-stop behaviour',
    changes: [false, false, false, false, false, false, false],
  },
];

function replayHost(changes: boolean[]): string[] {
  const ledger = { consecutiveNoChange: 0, recoveryUsed: false };
  return changes.map((changed) => {
    const next = decideNoProgress(ledger, changed);
    ledger.consecutiveNoChange = next.consecutiveNoChange;
    ledger.recoveryUsed = next.recoveryUsed;
    return next.decision;
  });
}

function replayRenderer(changes: boolean[], name: string): string[] {
  const controller = createComputerUseController();
  const key = { conversationId: 'contract', loopId: name };
  return changes.map((changed) => {
    const status: ComputerVerificationStatus = changed ? 'verified-change' : 'no-change';
    return controller.assessProgress(key, {
      status,
      beforeStateId: 'before',
      afterStateId: 'after',
      reason: changed ? 'state-changed' : 'state-unchanged',
      observation: changed ? 'changed' : 'unchanged',
      expectation: 'not-requested',
    }, 'none').decision;
  });
}

/**
 * The decisions only the renderer can reach. They are judged from the model's
 * `expected_effect`, which never crosses to the Host — its receipt hardcodes
 * `expectation: 'not-requested'` — and they sit ABOVE the shared no-progress
 * counter in `assessProgress`. The cross-tier corpus below drives observations
 * only, so without these a change to either branch would slip past this file
 * entirely, which is the drift it exists to catch.
 */
function rendererOnlyDecisions(): string[] {
  const controller = createComputerUseController();
  const ambiguous = controller.assessProgress(
    { conversationId: 'contract', loopId: 'ambiguous' },
    {
      status: 'ambiguous',
      beforeStateId: 'before',
      afterStateId: null,
      reason: 'observation-failed',
      observation: 'unavailable',
      expectation: 'unverifiable',
    },
    'send',
  ).decision;
  const notSatisfied = controller.assessProgress(
    { conversationId: 'contract', loopId: 'not-satisfied' },
    {
      status: 'no-change',
      beforeStateId: 'before',
      afterStateId: 'after',
      reason: 'expected-effect-not-observed',
      observation: 'unchanged',
      expectation: 'not-satisfied',
    },
    'none',
  ).decision;
  return [ambiguous, notSatisfied];
}

describe('Computer Use no-progress policy contract', () => {
  it('reads both tiers thresholds from the shared policy file', () => {
    expect(NO_PROGRESS_BEFORE_RECOVERY).toBe(policy.progressPolicy.noProgressBeforeRecovery);
    expect(NO_PROGRESS_AFTER_RECOVERY).toBe(policy.progressPolicy.noProgressAfterRecovery);
  });

  it.each(SEQUENCES)('agrees across tiers on $name', ({ name, changes }) => {
    const host = replayHost(changes);
    const renderer = replayRenderer(changes, name);
    expect(host).toEqual(renderer);
  });

  it('reaches the decisions only the renderer can make', () => {
    expect(rendererOnlyDecisions()).toEqual([
      'stop-ambiguous-side-effect',
      'stop-expectation-not-satisfied',
    ]);
  });

  it('settles the renderer-only branches before the shared counter runs', () => {
    // They must short-circuit: an ambiguous consequential action is a stop in
    // its own right, not a no-progress observation, and must not quietly spend
    // the recovery budget the two tiers are keeping in step.
    const controller = createComputerUseController();
    const key = { conversationId: 'contract', loopId: 'short-circuit' };
    const assessment = controller.assessProgress(key, {
      status: 'ambiguous',
      beforeStateId: 'before',
      afterStateId: null,
      reason: 'observation-failed',
      observation: 'unavailable',
      expectation: 'unverifiable',
    }, 'send');
    expect(assessment.decision).toBe('stop-ambiguous-side-effect');
    expect(assessment.consecutiveNoChange).toBe(0);
    expect(assessment.recoveryUsed).toBe(false);
  });

  // Guards the replay itself: if the corpus could not reach a tier's decisions,
  // agreeing would prove nothing. Every decision either tier can produce must
  // actually appear somewhere in it.
  it('exercises every decision either tier can produce', () => {
    const host = new Set(SEQUENCES.flatMap((sequence) => replayHost(sequence.changes)));
    expect(host).toEqual(new Set(['continue', 'recover', 'stop-no-progress']));

    const renderer = new Set([
      ...SEQUENCES.flatMap((sequence) => replayRenderer(sequence.changes, sequence.name)),
      ...rendererOnlyDecisions(),
    ]);
    expect(renderer).toEqual(new Set([
      'continue',
      'recover',
      'stop-no-progress',
      'stop-ambiguous-side-effect',
      'stop-expectation-not-satisfied',
    ]));
  });
});
