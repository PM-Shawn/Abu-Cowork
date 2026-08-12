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
    if (typeof raw === 'number' && Number.isFinite(raw)) {
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

export function traceRuntimeEvent(eventName: string, attributes: RuntimeTraceAttributes = {}): void {
  const event = sanitizeEventName(eventName);
  if (!event || !event.startsWith('renderer.')) return;
  const entry: RuntimeTraceEvent = {
    schemaVersion: 1,
    timestamp: Date.now(),
    process: 'renderer',
    event,
    ...sanitizeAttributes(attributes),
  };
  recentEvents.push(entry);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
  recordElectronRuntimeEvent({ event, ...sanitizeAttributes(attributes) });
}

export function startRuntimeRun(runId: string, executionPath: string, stage: string): void {
  const now = Date.now();
  activeRuns.set(runId, { runId, executionPath, stage, startedAt: now, updatedAt: now });
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
