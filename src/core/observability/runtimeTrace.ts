import { recordElectronRuntimeEvent } from '@/utils/electronHost';

const MAX_EVENTS = 500;
const MAX_STRING_CHARS = 160;

export interface RuntimeTraceAttributes {
  runId?: string;
  clientMessageId?: string;
  rpcId?: string;
  method?: string;
  stage?: string;
  outcome?: string;
  errorType?: string;
  sidecarId?: string;
  sidecarGeneration?: number;
  durationMs?: number;
  payloadBytes?: number;
  frameCount?: number;
  pendingRpcCount?: number;
  reason?: string;
  executionPath?: string;
  firstFrameMs?: number;
  bridgeLatencyMs?: number;
  acceptedAt?: number;
  replayCount?: number;
  conversationId?: string;
  loopId?: string;
  computerRunId?: string;
  traceId?: string;
  toolCallId?: string;
  stateId?: string;
  modelId?: string;
  modelTier?: string;
  capabilitySource?: string;
  targetBundleId?: string;
  targetProcessId?: number;
  verificationStatus?: string;
  axTreeHash?: string;
  elementCount?: number;
  permissionPath?: string;
  routeType?: string;
  turnIndex?: number;
  activeToolCount?: number;
  deferredToolCount?: number;
  computerUseExposed?: boolean;
  helperGeneration?: number;
  helperProtocolVersion?: number;
  helperBinaryVersion?: string;
  helperPlatform?: string;
  command?: string;
  attemptCount?: number;
  consecutiveNoChange?: number;
  recoveryUsed?: boolean;
}

export interface RuntimeTraceEvent extends RuntimeTraceAttributes {
  schemaVersion: 1;
  timestamp: number;
  process: 'renderer';
  event: string;
}

interface ActiveRuntimeRun {
  runId: string;
  executionPath: string;
  stage: string;
  startedAt: number;
  updatedAt: number;
  /** Set at run start so every later event carrying this runId can be joined to its conversation. */
  conversationId?: string;
}

export interface RendererRuntimeTraceSnapshot {
  schemaVersion: 1;
  takenAt: number;
  recentEvents: RuntimeTraceEvent[];
  activeRuns: Array<{
    runId: string;
    executionPath: string;
    stage: string;
    durationMs: number;
  }>;
}

const recentEvents: RuntimeTraceEvent[] = [];
const activeRuns = new Map<string, ActiveRuntimeRun>();

const SAFE_ATTRIBUTE_KEYS = new Set<keyof RuntimeTraceAttributes>([
  'runId',
  'clientMessageId',
  'rpcId',
  'method',
  'stage',
  'outcome',
  'errorType',
  'sidecarId',
  'sidecarGeneration',
  'durationMs',
  'payloadBytes',
  'frameCount',
  'pendingRpcCount',
  'reason',
  'executionPath',
  'firstFrameMs',
  'bridgeLatencyMs',
  'acceptedAt',
  'replayCount',
  'conversationId',
  'loopId',
  'computerRunId',
  'traceId',
  'toolCallId',
  'stateId',
  'modelId',
  'modelTier',
  'capabilitySource',
  'targetBundleId',
  'targetProcessId',
  'verificationStatus',
  'axTreeHash',
  'elementCount',
  'permissionPath',
  'routeType',
  'turnIndex',
  'activeToolCount',
  'deferredToolCount',
  'computerUseExposed',
  'helperGeneration',
  'helperProtocolVersion',
  'helperBinaryVersion',
  'helperPlatform',
  'command',
  'attemptCount',
  'consecutiveNoChange',
  'recoveryUsed',
]);

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{12,}/g,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi,
  /\b(?:token|api[_-]?key|password|secret|authorization)\s*[=:]\s*\S+/gi,
];

function sanitizeString(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  return result.slice(0, MAX_STRING_CHARS);
}

function sanitizeEventName(value: string): string | null {
  return /^[a-z][a-z0-9_.-]{0,79}$/.test(value) ? value : null;
}

function sanitizeAttributes(attributes: RuntimeTraceAttributes): RuntimeTraceAttributes {
  const output: RuntimeTraceAttributes = {};
  for (const [key, raw] of Object.entries(attributes) as Array<[
    keyof RuntimeTraceAttributes,
    RuntimeTraceAttributes[keyof RuntimeTraceAttributes],
  ]>) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key) || raw === undefined) continue;
    if (typeof raw === 'boolean') {
      (output as Record<string, unknown>)[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      (output as Record<string, unknown>)[key] = Math.max(0, Math.round(raw));
    } else if (typeof raw === 'string') {
      (output as Record<string, unknown>)[key] = sanitizeString(raw);
    }
  }
  return output;
}

export function runtimeErrorType(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  return raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80) || 'unknown';
}

/**
 * Attach the run's conversationId to events that carry a runId but no explicit
 * conversationId. Without this the run timeline cannot be joined to the session
 * ledger during diagnosis — most emit sites know their runId but not the
 * conversation, so the join is resolved centrally from the run registry rather
 * than threaded through every call site. An explicit conversationId always wins.
 */
function withRunConversation(attributes: RuntimeTraceAttributes): RuntimeTraceAttributes {
  if (attributes.conversationId !== undefined || attributes.runId === undefined) return attributes;
  const conversationId = activeRuns.get(attributes.runId)?.conversationId;
  return conversationId === undefined ? attributes : { ...attributes, conversationId };
}

export function traceRuntimeEvent(eventName: string, attributes: RuntimeTraceAttributes = {}): void {
  const event = sanitizeEventName(eventName);
  if (!event || !event.startsWith('renderer.')) return;
  const safeAttributes = sanitizeAttributes(withRunConversation(attributes));
  const entry: RuntimeTraceEvent = {
    schemaVersion: 1,
    timestamp: Date.now(),
    process: 'renderer',
    event,
    ...safeAttributes,
  };
  recentEvents.push(entry);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
  recordElectronRuntimeEvent({ event, ...safeAttributes });
}

/**
 * Record a React render crash caught by an error boundary. Local-only by
 * design: this writes to the same on-device runtime log as every other trace
 * event and never leaves the machine, so it carries no telemetry opt-out.
 * Only the error's CLASS is kept — a render error's message can quote the
 * conversation content that produced it.
 */
export function traceErrorBoundaryCatch(boundary: string, error: unknown): void {
  traceRuntimeEvent('renderer.error_boundary_caught', {
    reason: boundary,
    outcome: 'error',
    errorType: runtimeErrorType(error),
  });
}

export function startRuntimeRun(
  runId: string,
  executionPath: string,
  stage: string,
  conversationId?: string,
): void {
  const now = Date.now();
  activeRuns.set(runId, { runId, executionPath, stage, startedAt: now, updatedAt: now, conversationId });
}

export function markRuntimeRunStage(runId: string, stage: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.stage = stage;
  run.updatedAt = Date.now();
}

export function finishRuntimeRun(runId: string): void {
  activeRuns.delete(runId);
}

export function getRendererRuntimeTraceSnapshot(): RendererRuntimeTraceSnapshot {
  const takenAt = Date.now();
  return {
    schemaVersion: 1,
    takenAt,
    recentEvents: recentEvents.map((event) => ({ ...event })),
    activeRuns: Array.from(activeRuns.values(), (run) => ({
      runId: run.runId,
      executionPath: run.executionPath,
      stage: run.stage,
      durationMs: Math.max(0, takenAt - run.startedAt),
    })),
  };
}

export function __resetRuntimeTraceForTests(): void {
  recentEvents.length = 0;
  activeRuns.clear();
}
