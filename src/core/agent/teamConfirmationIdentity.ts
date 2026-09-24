import type { ToolExecutionContext } from '@/types';
import { commandScope, fileScope } from './teamApprovalScope';

/** Display strings never confer authority. Only the trusted executor builds this. */
export interface TeamConfirmationIdentity {
  toolName: string;
  parametersDigest: string;
  cwd: string | null;
  loopId: string;
  callId: string;
  dispatchId: string;
  dispatchFingerprint: string;
  /** Occurrence among identical requests in this dispatch (not across the run). */
  requestOrdinal: number;
  /**
   * What a "this task" rule for this request would cover (see
   * teamApprovalScope.ts). Built here from the same trusted input as the
   * digest; never from a display string or sidecar metadata. Missing on
   * pending records persisted before task rules existed: those can only be
   * allowed once.
   */
  scope?: string | null;
}

const requestOrdinals = new Map<string, Map<string, Map<string, number>>>();

export function clearTeamConfirmationIdentities(conversationId: string, loopId?: string): void {
  for (const key of requestOrdinals.keys()) {
    const [conversation, loop] = JSON.parse(key) as [string, string];
    if (conversation === conversationId && (loopId === undefined || loop === loopId)) requestOrdinals.delete(key);
  }
}

export function isRetryableTeamIdentity(identity: TeamConfirmationIdentity | undefined): boolean {
  return !!identity?.callId && !!identity.parametersDigest && !!identity.dispatchFingerprint
    && Number.isSafeInteger(identity.requestOrdinal) && identity.requestOrdinal > 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function digestApprovalParameters(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildTeamConfirmationIdentity(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  target?: unknown,
): Promise<TeamConfirmationIdentity | undefined> {
  if (!context?.loopId || !context.toolCallId) return undefined;
  // Exactly the same truthy fallback as run_command's executor. Do not trim
  // shell text or script bodies: changing either can change its meaning.
  const cwd = toolName === 'run_command'
    ? (typeof input.cwd === 'string' && input.cwd) || context.workspacePath || null
    : context.workspacePath || null;
  const parameters = toolName === 'run_command' ? { ...input, cwd } : input;
  const parametersDigest = await digestApprovalParameters({ parameters, cwd, target });
  const dispatchId = context.teamApprovalDispatch?.id ?? 'leader';
  const runKey = JSON.stringify([context.conversationId ?? null, context.loopId]);
  let requests = requestOrdinals.get(runKey);
  if (!requests) { requests = new Map(); requestOrdinals.set(runKey, requests); }
  const signature = JSON.stringify([dispatchId, context.agentName ?? null, toolName, parametersDigest]);
  let calls = requests.get(signature);
  if (!calls) { calls = new Map(); requests.set(signature, calls); }
  // Rechecking a call must not advance the sequence or spend a sibling's grant.
  let requestOrdinal = calls.get(context.toolCallId);
  if (requestOrdinal === undefined) {
    requestOrdinal = calls.size + 1;
    calls.set(context.toolCallId, requestOrdinal);
  }
  return {
    toolName,
    parametersDigest,
    cwd,
    loopId: context.loopId,
    callId: context.toolCallId,
    dispatchId,
    dispatchFingerprint: context.teamApprovalDispatch?.fingerprint ?? 'leader',
    requestOrdinal,
    scope: scopeFor(toolName, input, target),
  };
}

function scopeFor(toolName: string, input: Record<string, unknown>, target: unknown): string | null {
  if (toolName === 'run_command') {
    return typeof input.command === 'string' && input.command.trim() ? commandScope(input.command) : null;
  }
  if (!target || typeof target !== 'object') return null;
  const t = target as { origin?: unknown; pageOrigin?: unknown; path?: unknown; capabilities?: unknown; isFolder?: unknown };
  if (typeof t.path === 'string' && Array.isArray(t.capabilities)) {
    const caps = t.capabilities.filter((c): c is 'read' | 'write' => c === 'read' || c === 'write');
    return caps.length > 0 ? fileScope(t.path, caps, t.isFolder === true) : null;
  }
  if (typeof t.origin !== 'string' || !t.origin) return null;
  // An embedded frame is scoped to the page embedding it, the same way a
  // standing site grant for an embedded origin is (browserPermissionConfig's
  // embeddedSites): allowing a frame inside one host never reaches another.
  return typeof t.pageOrigin === 'string' && t.pageOrigin && t.pageOrigin !== t.origin
    ? `${t.origin} in ${t.pageOrigin}`
    : t.origin;
}
