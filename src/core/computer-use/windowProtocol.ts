import { invoke } from '@tauri-apps/api/core';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { isWindows } from '@/utils/platform';

export type ComputerWindowRelation = 'root' | 'owned' | 'modal' | 'replacement';

export interface ComputerWindowTarget {
  window_ref: string;
  app_name: string;
  title?: string;
  relation: ComputerWindowRelation;
}

export type ComputerProtocolErrorCode =
  | 'target-required'
  | 'target-not-found'
  | 'target-ambiguous'
  | 'window-ref-invalid'
  | 'window-ref-expired'
  | 'state-stale'
  | 'screenshot-stale'
  | 'modal-transition'
  | 'approval-denied'
  | 'manual-handoff-required'
  | 'user-takeover'
  | 'outcome-unknown'
  | 'turn-stopped';

export type ComputerProtocolNextAction =
  | 'select-target'
  | 'observe'
  | 'wait-for-user'
  | 'start-new-turn';

export interface ComputerProtocolError {
  code: ComputerProtocolErrorCode;
  recoverable: boolean;
  next_action?: ComputerProtocolNextAction;
  candidates?: ComputerWindowTarget[];
}

export class ComputerProtocolFailure extends Error {
  readonly protocolError: ComputerProtocolError;

  constructor(protocolError: ComputerProtocolError) {
    super(`Computer Use protocol failure: ${JSON.stringify(protocolError)}`);
    this.name = 'ComputerProtocolFailure';
    this.protocolError = protocolError;
  }
}

export interface ComputerAuthorizedWindowTarget {
  window_ref: string | null;
  app_name: string;
  bundle_id: string;
  process_id: number | null;
  relation: ComputerWindowRelation;
  title?: string;
}

/**
 * L3 driver capability declaration (contract §2.8): what the running driver
 * promises, as declared by the helper and normalized by the Host. `declared`
 * is false when the helper predates the declaration and the Host filled in
 * the conservative legacy table.
 */
export interface ComputerDriverCapabilities {
  id: string;
  declared: boolean;
  input: {
    foreground_required: boolean;
    background_element_actions: boolean;
    unicode_text: boolean;
    chords: boolean;
    ime_aware: boolean;
    physical_input_monitoring: boolean;
  };
  capture: {
    display: string;
    occluded_window: boolean;
    excludes_own_window: boolean;
    /** Whether physical-pixel coordinates can be trusted on mixed-DPI desktops (§2.8). */
    dpi_awareness: 'per-monitor-v2' | 'per-monitor' | 'system' | 'unaware' | 'unknown';
  };
  elements: {
    identity: 'runtime-id' | 'session-index' | 'none';
    empty_value: 'string' | 'null' | 'unknown';
    actions: string[];
  };
  boundaries: string[];
  activation: { can_activate_window: boolean };
}

const DRIVER_IDENTITIES = new Set(['runtime-id', 'session-index', 'none']);
const DRIVER_EMPTY_VALUES = new Set(['string', 'null', 'unknown']);
const DRIVER_DPI_AWARENESS = new Set(['per-monitor-v2', 'per-monitor', 'system', 'unaware', 'unknown']);

/** Tolerant: a missing or malformed declaration is simply absent (null). */
export function parseDriverCapabilities(value: unknown): ComputerDriverCapabilities | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  const input = isRecord(value.input) ? value.input : {};
  const capture = isRecord(value.capture) ? value.capture : {};
  const elements = isRecord(value.elements) ? value.elements : {};
  const activation = isRecord(value.activation) ? value.activation : {};
  const strings = (list: unknown): string[] => (Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string')
    : []);
  const identity = typeof elements.identity === 'string' && DRIVER_IDENTITIES.has(elements.identity)
    ? elements.identity as ComputerDriverCapabilities['elements']['identity']
    : 'session-index';
  const emptyValue = typeof elements.empty_value === 'string' && DRIVER_EMPTY_VALUES.has(elements.empty_value)
    ? elements.empty_value as ComputerDriverCapabilities['elements']['empty_value']
    : 'unknown';
  const dpiAwareness = typeof capture.dpi_awareness === 'string' && DRIVER_DPI_AWARENESS.has(capture.dpi_awareness)
    ? capture.dpi_awareness as ComputerDriverCapabilities['capture']['dpi_awareness']
    : 'unknown';
  return {
    id: value.id,
    declared: value.declared === true,
    input: {
      foreground_required: input.foreground_required !== false,
      background_element_actions: input.background_element_actions === true,
      unicode_text: input.unicode_text === true,
      chords: input.chords === true,
      ime_aware: input.ime_aware === true,
      physical_input_monitoring: input.physical_input_monitoring === true,
    },
    capture: {
      display: typeof capture.display === 'string' && capture.display ? capture.display : 'unknown',
      occluded_window: capture.occluded_window === true,
      excludes_own_window: capture.excludes_own_window === true,
      dpi_awareness: dpiAwareness,
    },
    elements: { identity, empty_value: emptyValue, actions: strings(elements.actions) },
    boundaries: strings(value.boundaries),
    activation: { can_activate_window: activation.can_activate_window !== false },
  };
}

export type ComputerUseSessionResponse =
  | {
      status: 'authorized';
      token: string;
      target: ComputerAuthorizedWindowTarget;
      classification: 'ordinary' | 'approval-required';
      expires_at: number;
      driver?: ComputerDriverCapabilities | null;
    }
  | { status: 'target-error'; error: ComputerProtocolError };

export type ComputerWindowCandidatesResponse =
  | { status: 'candidates'; candidates: ComputerWindowTarget[] }
  | { status: 'target-error'; error: ComputerProtocolError };

const WINDOW_RELATIONS = new Set<ComputerWindowRelation>([
  'root', 'owned', 'modal', 'replacement',
]);
const PROTOCOL_ERROR_CODES = new Set<ComputerProtocolErrorCode>([
  'target-required', 'target-not-found', 'target-ambiguous',
  'window-ref-invalid', 'window-ref-expired', 'state-stale',
  'screenshot-stale', 'modal-transition', 'approval-denied',
  'manual-handoff-required', 'user-takeover', 'outcome-unknown', 'turn-stopped',
]);
const NEXT_ACTIONS = new Set<ComputerProtocolNextAction>([
  'select-target', 'observe', 'wait-for-user', 'start-new-turn',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpaqueWindowRef(value: unknown): value is string {
  return typeof value === 'string' && /^wr-[A-Za-z0-9_-]+$/.test(value);
}

function parseWindowTarget(value: unknown): ComputerWindowTarget {
  if (!isRecord(value)) throw new Error('Computer Use window candidate is invalid');
  const relation = value.relation;
  if (
    !isOpaqueWindowRef(value.window_ref)
    || typeof value.app_name !== 'string'
    || value.app_name.length === 0
    || typeof relation !== 'string'
    || !WINDOW_RELATIONS.has(relation as ComputerWindowRelation)
    || (value.title !== undefined && typeof value.title !== 'string')
  ) {
    throw new Error('Computer Use window candidate is invalid');
  }
  return {
    window_ref: value.window_ref,
    app_name: value.app_name,
    relation: relation as ComputerWindowRelation,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
  };
}

function parseProtocolError(value: unknown): ComputerProtocolError {
  if (!isRecord(value)) throw new Error('Computer Use protocol error is invalid');
  const code = value.code;
  const nextAction = value.next_action;
  if (
    typeof code !== 'string'
    || !PROTOCOL_ERROR_CODES.has(code as ComputerProtocolErrorCode)
    || typeof value.recoverable !== 'boolean'
    || (
      nextAction !== undefined
      && (typeof nextAction !== 'string' || !NEXT_ACTIONS.has(nextAction as ComputerProtocolNextAction))
    )
    || (value.candidates !== undefined && !Array.isArray(value.candidates))
  ) {
    throw new Error('Computer Use protocol error is invalid');
  }
  return {
    code: code as ComputerProtocolErrorCode,
    recoverable: value.recoverable,
    ...(typeof nextAction === 'string'
      ? { next_action: nextAction as ComputerProtocolNextAction }
      : {}),
    ...(Array.isArray(value.candidates)
      ? { candidates: value.candidates.map(parseWindowTarget) }
      : {}),
  };
}

export function parseComputerUseSessionResponse(value: unknown): ComputerUseSessionResponse {
  if (!isRecord(value)) throw new Error('Computer Use session response is invalid');
  if (value.status === 'target-error') {
    return { status: 'target-error', error: parseProtocolError(value.error) };
  }
  if (value.status !== 'authorized' || !isRecord(value.target)) {
    throw new Error('Computer Use session response is invalid');
  }
  const target = value.target;
  const relation = target.relation;
  const windowRef = target.window_ref;
  if (
    typeof value.token !== 'string'
    || value.token.length === 0
    || (value.classification !== 'ordinary' && value.classification !== 'approval-required')
    || typeof value.expires_at !== 'number'
    || !Number.isFinite(value.expires_at)
    || typeof target.app_name !== 'string'
    || target.app_name.length === 0
    || typeof target.bundle_id !== 'string'
    || target.bundle_id.length === 0
    || (target.process_id !== null && !Number.isSafeInteger(target.process_id))
    || typeof relation !== 'string'
    || !WINDOW_RELATIONS.has(relation as ComputerWindowRelation)
    || (windowRef !== null && !isOpaqueWindowRef(windowRef))
    || (target.title !== undefined && typeof target.title !== 'string')
  ) {
    throw new Error('Computer Use session response is invalid');
  }
  if (
    hasElectronCommandHost()
    && isWindows()
    && windowRef === null
    && target.bundle_id !== 'abu.screen'
  ) {
    throw new Error('Authorized Windows Computer Use session is missing window_ref');
  }
  return {
    status: 'authorized',
    token: value.token,
    target: {
      window_ref: windowRef,
      app_name: target.app_name,
      bundle_id: target.bundle_id,
      process_id: target.process_id as number | null,
      relation: relation as ComputerWindowRelation,
      ...(typeof target.title === 'string' ? { title: target.title } : {}),
    },
    classification: value.classification,
    expires_at: value.expires_at,
    driver: parseDriverCapabilities(value.driver),
  };
}

export async function captureComputerUseTurnTarget(
  conversationId: string,
  loopId: string,
): Promise<{ captured: boolean }> {
  if (!hasElectronCommandHost() || !isWindows()) return { captured: false };
  try {
    const response = await invoke<unknown>('computer_use_capture_turn_target', {
      conversationId,
      loopId,
      interactionMode: 'foreground',
    });
    return {
      captured: isRecord(response) && response.captured === true,
    };
  } catch {
    return { captured: false };
  }
}

export async function listComputerUseWindows(
  conversationId: string,
  loopId: string,
  app: string,
): Promise<ComputerWindowCandidatesResponse> {
  const response = await invoke<unknown>('computer_use_list_windows', {
    conversationId,
    loopId,
    interactionMode: 'foreground',
    app,
  });
  if (!isRecord(response)) throw new Error('Computer Use window candidates response is invalid');
  if (response.status === 'target-error') {
    return { status: 'target-error', error: parseProtocolError(response.error) };
  }
  if (response.status !== 'candidates' || !Array.isArray(response.candidates)) {
    throw new Error('Computer Use window candidates response is invalid');
  }
  return {
    status: 'candidates',
    candidates: response.candidates.map(parseWindowTarget),
  };
}
