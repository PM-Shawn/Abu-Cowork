export const SIDECAR_RUNTIME_TRACE_PREFIX = '[abu-runtime] ';
const MAX_STRING_CHARS = 160;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{12,}/g,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi,
  /\b(?:token|api[_-]?key|password|secret|authorization)\s*[=:]\s*\S+/gi,
];

interface SidecarTraceAttributes {
  runId?: string;
  rpcId?: string;
  method?: string;
  stage?: string;
  outcome?: string;
  errorType?: string;
  durationMs?: number;
  frameCount?: number;
  reason?: string;
}

const SAFE_KEYS = new Set<keyof SidecarTraceAttributes>([
  'runId',
  'rpcId',
  'method',
  'stage',
  'outcome',
  'errorType',
  'durationMs',
  'frameCount',
  'reason',
]);

function sanitizeEventName(value: string): string | null {
  return /^[a-z][a-z0-9_.-]{0,79}$/.test(value) ? value : null;
}

function sanitizeString(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  return result.slice(0, MAX_STRING_CHARS);
}

function sanitizeAttributes(attributes: SidecarTraceAttributes): SidecarTraceAttributes {
  const output: SidecarTraceAttributes = {};
  for (const [key, raw] of Object.entries(attributes) as Array<[
    keyof SidecarTraceAttributes,
    SidecarTraceAttributes[keyof SidecarTraceAttributes],
  ]>) {
    if (!SAFE_KEYS.has(key) || raw === undefined) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      (output as Record<string, unknown>)[key] = Math.max(0, Math.round(raw));
    } else if (typeof raw === 'string') {
      (output as Record<string, unknown>)[key] = sanitizeString(raw);
    }
  }
  return output;
}

export function sidecarRuntimeErrorType(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  return raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80) || 'unknown';
}

export function traceSidecarRuntimeEvent(eventName: string, attributes: SidecarTraceAttributes = {}): void {
  const event = sanitizeEventName(eventName);
  if (!event || !event.startsWith('sidecar.')) return;
  const line = JSON.stringify({
    schemaVersion: 1,
    process: 'sidecar',
    event,
    ...sanitizeAttributes(attributes),
  });
  try {
    process.stderr.write(`${SIDECAR_RUNTIME_TRACE_PREFIX}${line}\n`);
  } catch {
    // Runtime tracing is best-effort and must never affect the agent loop.
  }
}
