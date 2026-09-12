/**
 * Execution-receipt contract — one corpus, three tiers.
 *
 * The helper classifies a failure where it is raised (Rust, error.rs); the
 * manager carries it across the process boundary (nativeHelperManager.cjs);
 * the Gate turns it into a verdict (computerUseGate.cjs); the renderer spends
 * its recovery budget on it (recoveryBudget.ts). Each tier has its own unit
 * tests. This file replays the same wire payloads through all of them so the
 * vocabulary cannot drift in one place and silently change what "safe to
 * observe again" means somewhere else.
 *
 * Research note: research/computer-use-design-2026-09-11/11-m1-execution-receipt-contract.md
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createRecoveryBudget,
  runBudgetKey,
  type ExecutionOutcome,
  type RecoveryDecision,
} from '../src/core/computer-use/recoveryBudget';
import policy from '../src/core/tools/computerUsePolicy.json';

const require_ = createRequire(import.meta.url);
const { normalizeHelperError, HELPER_EXECUTIONS: managerExecutions } = require_('./nativeHelperManager.cjs') as {
  normalizeHelperError: (raw: unknown) => Error & { helper: { code: string; execution: string; retryable: boolean } };
  HELPER_EXECUTIONS: Set<string>;
};
const { classifyHelperFailure, HELPER_EXECUTIONS: gateExecutions } = require_('./computerUseGate.cjs') as {
  classifyHelperFailure: (kind: 'stateful' | 'observation', error: unknown) => { code: string; execution: ExecutionOutcome; retryable: boolean };
  HELPER_EXECUTIONS: Set<string>;
};

const RENDERER_EXECUTIONS = ['not-executed', 'dispatched', 'outcome-unknown'] satisfies ExecutionOutcome[];

/** Wire payloads exactly as the helper writes them (`{"id","error":…}`). */
const WIRE_CORPUS: Array<{ label: string; error: unknown; verdict: ExecutionOutcome }> = [
  { label: 'target changed before input', verdict: 'not-executed',
    error: { code: 'target-changed', execution: 'not-executed', retryable: true, message: 'frontmost target changed; observe again' } },
  { label: 'screenshot stale', verdict: 'not-executed',
    error: { code: 'screenshot-stale', execution: 'not-executed', retryable: true, message: 'screenshot_id is unknown or expired; observe again' } },
  { label: 'secure desktop (needs the user)', verdict: 'not-executed',
    error: { code: 'secure-desktop', execution: 'not-executed', retryable: false, message: "input is blocked on secure desktop 'Winlogon'" } },
  { label: 'nothing injected', verdict: 'not-executed',
    error: { code: 'send-input-failed', execution: 'not-executed', retryable: false, message: 'SendInput was blocked after 0/3 events' } },
  { label: 'partial injection', verdict: 'outcome-unknown',
    error: { code: 'send-input-failed', execution: 'outcome-unknown', retryable: false, message: 'SendInput was blocked after 1/3 events' } },
  { label: 'drag interrupted mid-way', verdict: 'outcome-unknown',
    error: { code: 'physical-input', execution: 'outcome-unknown', retryable: false, message: 'physical user input interrupted the drag' } },
  { label: 'delivered, post-check failed', verdict: 'dispatched',
    error: { code: 'uia-failure', execution: 'dispatched', retryable: false, message: 'value did not settle' } },
  { label: 'unclassified internal error', verdict: 'outcome-unknown',
    error: { code: 'internal', execution: 'outcome-unknown', retryable: false, message: 'serialize failed' } },
  { label: 'unclassified but provably pre-dispatch', verdict: 'not-executed',
    error: { code: 'internal', execution: 'not-executed', retryable: false, message: 'OpenProcess(42) failed' } },
  { label: 'legacy string from an old helper', verdict: 'outcome-unknown',
    error: 'Computer Use target changed before native input' },
  { label: 'malformed object', verdict: 'outcome-unknown',
    error: { code: 'target-changed', execution: 'maybe' } },
];

function decideFor(budget: ReturnType<typeof createRecoveryBudget>, key: string, error: unknown): RecoveryDecision {
  const failure = classifyHelperFailure('stateful', normalizeHelperError(error));
  return budget.decide(key, failure.execution, false);
}

describe('execution-receipt contract', () => {
  it('uses one execution vocabulary in every tier', () => {
    expect([...managerExecutions].sort()).toEqual([...RENDERER_EXECUTIONS].sort());
    expect([...gateExecutions].sort()).toEqual([...RENDERER_EXECUTIONS].sort());
    // The Rust side is the origin of the words; keep it in the same corpus.
    const rust = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'native-helper/src/error.rs'),
      'utf8',
    );
    expect(rust).toContain('#[serde(rename_all = "kebab-case")]');
    for (const variant of ['NotExecuted', 'Dispatched', 'OutcomeUnknown']) {
      expect(rust).toMatch(new RegExp(`^\\s+${variant},`, 'm'));
    }
  });

  it('carries the helper verdict unchanged from wire to Gate', () => {
    for (const { label, error, verdict } of WIRE_CORPUS) {
      const failure = classifyHelperFailure('stateful', normalizeHelperError(error));
      expect(failure.execution, label).toBe(verdict);
    }
  });

  it('only a not-executed verdict ever buys a fresh observation', () => {
    for (const { label, error, verdict } of WIRE_CORPUS) {
      const budget = createRecoveryBudget();
      const decision = decideFor(budget, runBudgetKey({ conversationId: 'c', loopId: label }), error);
      expect(decision, label).toBe(verdict === 'not-executed' ? 'observe-once' : 'handoff');
    }
  });

  it('bounds recovery per event and per run from computerUsePolicy.json', () => {
    const budget = createRecoveryBudget();
    const key = runBudgetKey({ conversationId: 'c', loopId: 'bounded' });
    const refusal = WIRE_CORPUS[0].error;
    const { eventRecoveryLimit, turnRecoveryLimit } = policy.progressPolicy;

    const decisions: RecoveryDecision[] = [];
    for (let i = 0; i < eventRecoveryLimit + 1; i += 1) decisions.push(decideFor(budget, key, refusal));
    expect(decisions).toEqual([...Array(eventRecoveryLimit).fill('observe-once'), 'handoff']);

    // Verified progress refunds the per-event budget but not the per-run one.
    budget.recordVerifiedProgress(key);
    const remainingTurn = turnRecoveryLimit - eventRecoveryLimit;
    for (let i = 0; i < remainingTurn; i += 1) {
      expect(decideFor(budget, key, refusal)).toBe('observe-once');
      budget.recordVerifiedProgress(key);
    }
    expect(decideFor(budget, key, refusal)).toBe('handoff');
  });

  it('never lets an observation failure look like a side effect, and never lets a stateful legacy failure look safe', () => {
    const legacy = normalizeHelperError('boom');
    expect(classifyHelperFailure('observation', legacy).execution).toBe('not-executed');
    expect(classifyHelperFailure('stateful', legacy).execution).toBe('outcome-unknown');
    expect(classifyHelperFailure('stateful', new Error('host-side throw with no helper field')).execution).toBe('outcome-unknown');
  });
});
