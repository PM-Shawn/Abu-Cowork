import {
  deriveVerificationEvidence,
  type VerificationExpectation,
  type VerificationObservation,
} from '@/core/computer-use/verificationEvidence';
import computerUsePolicy from '@/core/tools/computerUsePolicy.json';

const progressPolicy = computerUsePolicy.progressPolicy;

export const COMPUTER_STATE_TTL_MS = 30_000;

export interface ComputerUseRunKey {
  conversationId: string;
  loopId: string;
}

export interface ComputerTargetIdentity {
  windowRef: string | null;
  appName: string;
  bundleId: string;
  processId: number | null;
}

export interface ComputerAxElement {
  id: number;
  role: string;
  label: string | null;
  value: string | null;
  bounds: [number, number, number, number];
  actions: string[];
  depth: number;
  /** Native observation hints used only to rank what the model sees. */
  focused?: boolean;
  enabled?: boolean;
  offscreen?: boolean;
}

export interface ComputerAxDiff {
  added: number[];
  removed: number[];
  changed: number[];
}

export interface ComputerState {
  stateId: string;
  target: ComputerTargetIdentity;
  capturedAt: number;
  axSessionId: string | null;
  axTreeHash: string | null;
  axDiff: ComputerAxDiff | null;
  elements: ComputerAxElement[];
  capabilityTier: 'full' | 'structured';
}

export type ExpectedEffect =
  | { type: 'element-value'; elementId: number; equals: string }
  | { type: 'element-state'; elementId: number; attribute: string; equals: string | boolean }
  | { type: 'element-appears'; role?: string; label?: string }
  | { type: 'element-disappears'; elementId: number }
  | { type: 'frontmost-app'; bundleId: string }
  | { type: 'any-state-change' };

export type ComputerVerificationStatus =
  | 'verified-change'
  | 'no-change'
  | 'ambiguous';

export interface ComputerVerification {
  status: ComputerVerificationStatus;
  /** Optional only for compatibility with verification records created before evidence layering. */
  observation?: VerificationObservation;
  /** Optional only for compatibility with verification records created before evidence layering. */
  expectation?: VerificationExpectation;
  beforeStateId: string;
  afterStateId: string | null;
  reason:
    | 'expected-effect-observed'
    | 'state-changed'
    | 'state-unchanged'
    | 'expected-effect-not-observed'
    | 'observation-failed'
    | 'target-changed'
    | 'effect-not-observable';
}

export type ComputerProgressDecision =
  | 'continue'
  | 'recover'
  | 'stop-no-progress'
  | 'stop-expectation-not-satisfied'
  | 'stop-ambiguous-side-effect';

export interface ComputerProgressAssessment {
  decision: ComputerProgressDecision;
  consecutiveNoChange: number;
  recoveryUsed: boolean;
}

export type ComputerUseStateErrorCode =
  | 'run-context-required'
  | 'state-required'
  | 'state-mismatch'
  | 'state-expired'
  | 'state-consumed'
  | 'target-mismatch'
  | 'action-in-flight'
  | 'run-stopped'
  | 'weak-verification-for-consequence';

export class ComputerUseStateError extends Error {
  readonly code: ComputerUseStateErrorCode;

  constructor(code: ComputerUseStateErrorCode, message: string) {
    super(message);
    this.name = 'ComputerUseStateError';
    this.code = code;
  }
}

export interface ComputerObservationInput {
  stateId?: string;
  target: ComputerTargetIdentity;
  axSessionId: string | null;
  elements: ComputerAxElement[];
  modalWindowId?: string | null;
  capabilityTier: 'full' | 'structured';
}

export interface ComputerActionRequest {
  expectedStateId: string;
  target?: ComputerTargetIdentity;
  expectedEffect?: ExpectedEffect;
  consequence: string;
}

interface RunRecord {
  state: ComputerState | null;
  consumed: boolean;
  actionInFlight: boolean;
  consecutiveNoChange: number;
  recoveryUsed: boolean;
  stoppedReason: Extract<ComputerProgressDecision, `stop-${string}`> | null;
}

interface ComputerUseControllerDependencies {
  now?: () => number;
  createStateId?: (input: {
    key: ComputerUseRunKey;
    capturedAt: number;
    sequence: number;
  }) => string;
  stateTtlMs?: number;
}

function runKey(input: ComputerUseRunKey): string {
  return `${input.conversationId}\u0000${input.loopId}`;
}

function sameTarget(a: ComputerTargetIdentity, b: ComputerTargetIdentity): boolean {
  if (a.windowRef !== null && b.windowRef !== null && a.windowRef !== b.windowRef) return false;
  if (a.bundleId.toLowerCase() !== b.bundleId.toLowerCase()) return false;
  return a.processId === null || b.processId === null || a.processId === b.processId;
}

function elementFingerprint(element: ComputerAxElement): string {
  return JSON.stringify([
    element.role,
    element.label,
    element.value,
    element.bounds,
    element.actions,
    element.depth,
  ]);
}

function hashText(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

export function hashComputerElements(
  elements: ComputerAxElement[],
  modalWindowId: string | null = null,
): string | null {
  if (elements.length === 0 && modalWindowId === null) return null;
  return hashText(JSON.stringify([
    modalWindowId,
    elements.map(elementFingerprint),
  ]));
}

function diffElements(
  previous: ComputerAxElement[],
  next: ComputerAxElement[],
): ComputerAxDiff | null {
  if (previous.length === 0) return null;
  const before = new Map(previous.map((element) => [element.id, elementFingerprint(element)]));
  const after = new Map(next.map((element) => [element.id, elementFingerprint(element)]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.entries()]
    .filter(([id, fingerprint]) => before.has(id) && before.get(id) !== fingerprint)
    .map(([id]) => id);
  return { added, removed, changed };
}

function elementMatches(
  element: ComputerAxElement,
  matcher: { role?: string; label?: string },
): boolean {
  return (matcher.role === undefined || element.role === matcher.role)
    && (matcher.label === undefined || element.label === matcher.label);
}

function hasMeaningfulElementMatcher(matcher: { role?: string; label?: string }): boolean {
  return Boolean(matcher.role?.trim() || matcher.label?.trim());
}

/**
 * Re-finds an element across two snapshots, or `null` if it cannot be shown to
 * be the same element.
 *
 * An element `id` is a per-snapshot index, NOT a durable identity: a redraw can
 * hand the same number to a different control. Treating the index alone as
 * identity reports a neighbouring element's value as the one we asked about, so
 * require role and label to survive the action as corroboration.
 */
function stableElement(
  before: ComputerState,
  after: ComputerState,
  elementId: number,
): ComputerAxElement | null {
  const previous = before.elements.find((element) => element.id === elementId);
  const current = after.elements.find((element) => element.id === elementId);
  if (!previous || !current) return null;
  if (previous.role !== current.role || previous.label !== current.label) return null;
  return current;
}

/**
 * Evaluates one machine-checkable postcondition against the post-action state.
 *
 * `null` means "cannot be decided from what we observed" and maps to the
 * `unverifiable` expectation — never to a pass. Every arm of the union must be
 * handled: routing expectation evidence through `deriveVerificationEvidence`
 * once reduced this to `element-appears` only, which left the other four types
 * permanently unverifiable and degraded every verified write to ambiguous, which
 * in turn stops the run. Keep the switch exhaustive.
 */
function evaluateExpectation(
  before: ComputerState,
  after: ComputerState,
  expectedEffect: ExpectedEffect,
): boolean | null {
  switch (expectedEffect.type) {
    case 'element-value': {
      const element = stableElement(before, after, expectedEffect.elementId);
      return element === null ? null : element.value === expectedEffect.equals;
    }
    case 'element-state': {
      // Only `value` is decidable: `role`/`label` are the very attributes
      // stableElement uses as identity, so a changed one is indistinguishable
      // from a reassigned index.
      if (expectedEffect.attribute !== 'value') return null;
      // The schema still accepts a boolean `equals` (boolean state checks are
      // "reserved for AX attributes exposed by a later helper protocol"), but no
      // observed attribute is a boolean yet. Comparing a string value against
      // one can only ever be false, which would report a check we never made as
      // a check that failed — and that latches a terminal stop.
      if (typeof expectedEffect.equals !== 'string') return null;
      const element = stableElement(before, after, expectedEffect.elementId);
      return element === null ? null : element.value === expectedEffect.equals;
    }
    case 'element-appears':
      // A matcher with neither role nor label matches anything, so it proves
      // nothing — stay unverifiable rather than reporting a wildcard pass.
      return hasMeaningfulElementMatcher(expectedEffect)
        ? after.elements.some((element) => elementMatches(element, expectedEffect))
        : null;
    case 'element-disappears': {
      // Match on what the element WAS, not on its index: after a redraw the
      // index may simply have been handed to a different control.
      //
      // Asking merely whether SOME element of that kind survives is wrong when
      // the app has more than one: a modal's OK button and the OK button in the
      // window behind it are indistinguishable by role and label, so a closed
      // modal would be reported as "did not disappear". Count the kind instead.
      const previous = before.elements.find((element) => element.id === expectedEffect.elementId);
      if (!previous) return null;
      const sameKind = (element: ComputerAxElement) => element.role === previous.role
        && element.label === previous.label;
      if (after.elements.filter(sameKind).length < before.elements.filter(sameKind).length) {
        return true;
      }
      // The population held steady. Only claim it did NOT disappear while the
      // id still resolves to an element of the same kind; otherwise one may have
      // been swapped for another and nothing here can tell the two apart.
      return stableElement(before, after, expectedEffect.elementId) === null ? null : false;
    }
    case 'frontmost-app':
      // `after.target` is the window we chose to observe, so comparing it to the
      // expected bundle is circular — it says nothing about what the OS actually
      // has in front. Needs real frontmost evidence from the helper.
      return null;
    case 'any-state-change':
      // Not an expectation: handled by the state-change branch below.
      return null;
  }
}

export function verifyComputerEffect(
  before: ComputerState,
  after: ComputerState | null,
  expectedEffect?: ExpectedEffect,
): ComputerVerification {
  const observationAvailable = after !== null;
  const targetMatches = after !== null && sameTarget(before.target, after.target);
  const stateChanged = targetMatches && before.axTreeHash !== after.axTreeHash;
  const expectationRequested = expectedEffect !== undefined
    && expectedEffect.type !== 'any-state-change';
  let expectationMatched: boolean | null = null;
  if (targetMatches && expectedEffect !== undefined) {
    expectationMatched = evaluateExpectation(before, after, expectedEffect);
  }
  const evidence = deriveVerificationEvidence({
    observationAvailable,
    targetMatches,
    changed: stateChanged,
    expectationRequested,
    expectationMatched,
  });

  if (!after) {
    return {
      ...evidence,
      status: 'ambiguous',
      beforeStateId: before.stateId,
      afterStateId: null,
      reason: 'observation-failed',
    };
  }

  if (!sameTarget(before.target, after.target)) {
    return {
      ...evidence,
      status: 'ambiguous',
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      reason: 'target-changed',
    };
  }
  if (!expectedEffect || expectedEffect.type === 'any-state-change') {
    return {
      ...evidence,
      status: stateChanged ? 'verified-change' : 'no-change',
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      reason: stateChanged ? 'state-changed' : 'state-unchanged',
    };
  }

  if (evidence.expectation === 'unverifiable') {
    return {
      ...evidence,
      status: 'ambiguous',
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      reason: 'effect-not-observable',
    };
  }
  return {
    ...evidence,
    status: evidence.expectation === 'satisfied' ? 'verified-change' : 'no-change',
    beforeStateId: before.stateId,
    afterStateId: after.stateId,
    reason: evidence.expectation === 'satisfied'
      ? 'expected-effect-observed'
      : 'expected-effect-not-observed',
  };
}

export function createComputerUseController(
  dependencies: ComputerUseControllerDependencies = {},
) {
  const now = dependencies.now ?? (() => Date.now());
  const stateTtlMs = dependencies.stateTtlMs ?? COMPUTER_STATE_TTL_MS;
  let sequence = 0;
  const createStateId = dependencies.createStateId ?? ((input: {
    key: ComputerUseRunKey;
    capturedAt: number;
    sequence: number;
  }) => `cu-${input.capturedAt.toString(36)}-${input.sequence.toString(36)}`);
  const runs = new Map<string, RunRecord>();

  function getOrCreate(key: ComputerUseRunKey): RunRecord {
    const id = runKey(key);
    const existing = runs.get(id);
    if (existing) return existing;
    const created: RunRecord = {
      state: null,
      consumed: false,
      actionInFlight: false,
      consecutiveNoChange: 0,
      recoveryUsed: false,
      stoppedReason: null,
    };
    runs.set(id, created);
    return created;
  }

  function recordObservation(
    key: ComputerUseRunKey,
    input: ComputerObservationInput,
  ): ComputerState {
    const record = getOrCreate(key);
    const capturedAt = now();
    sequence += 1;
    const state: ComputerState = {
      stateId: input.stateId ?? createStateId({ key, capturedAt, sequence }),
      target: input.target,
      capturedAt,
      axSessionId: input.axSessionId,
      axTreeHash: hashComputerElements(input.elements, input.modalWindowId ?? null),
      axDiff: record.state ? diffElements(record.state.elements, input.elements) : null,
      elements: input.elements,
      capabilityTier: input.capabilityTier,
    };
    record.state = state;
    record.consumed = false;
    return state;
  }

  function prepareAction(
    key: ComputerUseRunKey,
    request: ComputerActionRequest,
  ): ComputerState {
    const record = getOrCreate(key);
    if (record.actionInFlight) {
      throw new ComputerUseStateError('action-in-flight', 'Another computer action is already in flight');
    }
    if (record.stoppedReason) {
      throw new ComputerUseStateError(
        'run-stopped',
        `Computer Use run is stopped: ${record.stoppedReason}`,
      );
    }
    const state = record.state;
    if (!state) {
      throw new ComputerUseStateError('state-required', 'Call get_app_state before a computer action');
    }
    if (request.expectedStateId !== state.stateId) {
      throw new ComputerUseStateError('state-mismatch', 'The supplied state_id is not the latest observation');
    }
    if (now() - state.capturedAt > stateTtlMs) {
      throw new ComputerUseStateError('state-expired', 'The observed computer state has expired');
    }
    if (record.consumed) {
      throw new ComputerUseStateError('state-consumed', 'The observed computer state was already used');
    }
    if (request.target && !sameTarget(state.target, request.target)) {
      throw new ComputerUseStateError('target-mismatch', 'The computer action target does not match the observation');
    }
    if (request.consequence !== 'none' && request.expectedEffect?.type === 'any-state-change') {
      throw new ComputerUseStateError(
        'weak-verification-for-consequence',
        'Consequential actions require a specific expected effect',
      );
    }
    // Consume before native dispatch. Even an ambiguous native error must not
    // make this state reusable for a potentially duplicated side effect.
    record.consumed = true;
    record.actionInFlight = true;
    return state;
  }

  function completeAction(
    key: ComputerUseRunKey,
    before: ComputerState,
    observation: ComputerObservationInput | null,
    expectedEffect?: ExpectedEffect,
  ): { state: ComputerState | null; verification: ComputerVerification } {
    const record = getOrCreate(key);
    record.actionInFlight = false;
    if (!observation) {
      record.state = null;
      record.consumed = false;
      return { state: null, verification: verifyComputerEffect(before, null, expectedEffect) };
    }
    const state = recordObservation(key, observation);
    return { state, verification: verifyComputerEffect(before, state, expectedEffect) };
  }

  function assessProgress(
    key: ComputerUseRunKey,
    verification: ComputerVerification,
    consequence: string,
  ): ComputerProgressAssessment {
    const record = getOrCreate(key);
    if (verification.expectation === 'not-satisfied') {
      record.stoppedReason = 'stop-expectation-not-satisfied';
      return {
        decision: record.stoppedReason,
        consecutiveNoChange: record.consecutiveNoChange,
        recoveryUsed: record.recoveryUsed,
      };
    }
    if (verification.status === 'verified-change') {
      record.consecutiveNoChange = 0;
      return {
        decision: 'continue',
        consecutiveNoChange: 0,
        recoveryUsed: record.recoveryUsed,
      };
    }
    if (verification.status === 'ambiguous' && consequence !== 'none') {
      record.stoppedReason = 'stop-ambiguous-side-effect';
      return {
        decision: record.stoppedReason,
        consecutiveNoChange: record.consecutiveNoChange,
        recoveryUsed: record.recoveryUsed,
      };
    }

    record.consecutiveNoChange += 1;
    // Shared with the Host Gate's completeTaskAttempt — see progressPolicy in
    // computerUsePolicy.json. Both tiers judge no-progress independently, so the
    // thresholds must come from one file, not from two matching literals.
    const threshold = record.recoveryUsed
      ? progressPolicy.noProgressAfterRecovery
      : progressPolicy.noProgressBeforeRecovery;
    if (record.consecutiveNoChange < threshold) {
      return {
        decision: 'continue',
        consecutiveNoChange: record.consecutiveNoChange,
        recoveryUsed: record.recoveryUsed,
      };
    }
    if (!record.recoveryUsed) {
      record.recoveryUsed = true;
      record.consecutiveNoChange = 0;
      return {
        decision: 'recover',
        consecutiveNoChange: 0,
        recoveryUsed: true,
      };
    }
    record.stoppedReason = 'stop-no-progress';
    return {
      decision: record.stoppedReason,
      consecutiveNoChange: record.consecutiveNoChange,
      recoveryUsed: true,
    };
  }

  function failAction(key: ComputerUseRunKey): void {
    const record = getOrCreate(key);
    record.actionInFlight = false;
  }

  /** Drop only the observation/AX reference while preserving run-level progress guards. */
  function clearObservation(key: ComputerUseRunKey): string | null {
    const record = runs.get(runKey(key));
    if (!record) return null;
    const axSessionId = record.state?.axSessionId ?? null;
    record.state = null;
    record.consumed = false;
    record.actionInFlight = false;
    return axSessionId;
  }

  function invalidate(key: ComputerUseRunKey): string | null {
    const id = runKey(key);
    const record = runs.get(id);
    if (!record) return null;
    const axSessionId = record.state?.axSessionId ?? null;
    runs.delete(id);
    return axSessionId;
  }

  function invalidateAll(): string[] {
    const sessions = [...runs.values()]
      .map((record) => record.state?.axSessionId)
      .filter((id): id is string => typeof id === 'string');
    runs.clear();
    return sessions;
  }

  function getLatestState(key: ComputerUseRunKey): ComputerState | null {
    return runs.get(runKey(key))?.state ?? null;
  }

  return {
    recordObservation,
    prepareAction,
    completeAction,
    assessProgress,
    failAction,
    clearObservation,
    invalidate,
    invalidateAll,
    getLatestState,
  };
}

export const computerUseController = createComputerUseController();
