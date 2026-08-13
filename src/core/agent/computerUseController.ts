export const COMPUTER_STATE_TTL_MS = 30_000;

export interface ComputerUseRunKey {
  conversationId: string;
  loopId: string;
}

export interface ComputerTargetIdentity {
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
  beforeStateId: string;
  afterStateId: string | null;
  reason:
    | 'expected-effect-observed'
    | 'state-changed'
    | 'state-unchanged'
    | 'observation-failed'
    | 'target-changed'
    | 'effect-not-observable';
}

export type ComputerProgressDecision =
  | 'continue'
  | 'recover'
  | 'stop-no-progress'
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
  stoppedReason: Extract<ComputerProgressDecision, 'stop-no-progress' | 'stop-ambiguous-side-effect'> | null;
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

export function hashComputerElements(elements: ComputerAxElement[]): string | null {
  if (elements.length === 0) return null;
  return hashText(elements.map(elementFingerprint).join('\n'));
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

export function verifyComputerEffect(
  before: ComputerState,
  after: ComputerState | null,
  expectedEffect?: ExpectedEffect,
): ComputerVerification {
  if (!after) {
    return {
      status: 'ambiguous',
      beforeStateId: before.stateId,
      afterStateId: null,
      reason: 'observation-failed',
    };
  }

  if (!sameTarget(before.target, after.target)) {
    return {
      status: 'ambiguous',
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      reason: 'target-changed',
    };
  }
  const stateChanged = before.axTreeHash !== after.axTreeHash;
  if (!expectedEffect || expectedEffect.type === 'any-state-change') {
    return {
      status: stateChanged ? 'verified-change' : 'no-change',
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      reason: stateChanged ? 'state-changed' : 'state-unchanged',
    };
  }

  let observed: boolean | null;
  switch (expectedEffect.type) {
    case 'element-value':
      observed = after.elements.find((element) => element.id === expectedEffect.elementId)?.value
        === expectedEffect.equals;
      break;
    case 'element-state': {
      const element = after.elements.find((candidate) => candidate.id === expectedEffect.elementId);
      if (!element || !['role', 'label', 'value'].includes(expectedEffect.attribute)) {
        observed = null;
      } else {
        observed = element[expectedEffect.attribute as 'role' | 'label' | 'value']
          === expectedEffect.equals;
      }
      break;
    }
    case 'element-appears':
      observed = after.elements.some((element) => elementMatches(element, expectedEffect));
      break;
    case 'element-disappears':
      observed = !after.elements.some((element) => element.id === expectedEffect.elementId);
      break;
    case 'frontmost-app':
      observed = after.target.bundleId.toLowerCase() === expectedEffect.bundleId.toLowerCase();
      break;
  }

  if (observed === null) {
    return {
      status: 'ambiguous',
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      reason: 'effect-not-observable',
    };
  }
  return {
    status: observed ? 'verified-change' : 'no-change',
    beforeStateId: before.stateId,
    afterStateId: after.stateId,
    reason: observed ? 'expected-effect-observed' : 'state-unchanged',
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
      axTreeHash: hashComputerElements(input.elements),
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
    const threshold = record.recoveryUsed ? 2 : 3;
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
