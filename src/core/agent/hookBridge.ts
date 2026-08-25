/**
 * Unified hook reverse-RPC bridge — P1-3b-4 fix.
 *
 * Registers the shell-side `hook.emit` (REQUEST) and `hook.notify`
 * (NOTIFICATION) handlers that a sidecar-run agent loop calls when its
 * `lifecycleHooks` shim forwards a hook back to the REAL webview-side hook
 * registry (notification / todo panel / skill hooks — none of which run
 * inside the sidecar).
 *
 * Why a shared module (mirrors `toolInvokeRouter.ts`'s rationale):
 * `sidecarManager.ts`'s `onSidecarRequest`/`onSidecarNotification` allow
 * exactly ONE handler per method. BOTH the main loop (`agentLoopRunner.ts`)
 * and standalone subagents (`subagentRunner.ts`) run in the sidecar and
 * forward hooks via `hook.emit`/`hook.notify`. Originally only
 * `subagentRunner.ts` registered them, and only lazily on the first
 * `runSubagent()` call — so a session that ran ONLY a main loop (no subagent)
 * left `hook.emit` unregistered entirely, and the first tool call's
 * `preToolCall` hook came back `-32601 Method not found: hook.emit`. Both
 * handlers share one registration, but every event is still authenticated by
 * its active runId before it can reach the global hook registry. The matching
 * runner supplies the shell-owned AbortSignal and tool context; wire context
 * is never authority-bearing.
 *
 * Hook direction/kind rationale (unchanged from the original subagent path):
 * only `preToolCall` has its RETURN VALUE consumed by the loop
 * (`blocked`/`modifiedInput`), so it is a REQUEST (`hook.emit`); every other
 * hook is fire-and-forget, so it is a NOTIFICATION (`hook.notify`).
 */
import { onSidecarRequest, onSidecarNotification, SidecarRequestError } from '../sidecar/sidecarManager';
import { emitHook } from './lifecycleHooks';
import type { HookEvent, PreToolCallEvent, PostToolCallEvent } from './lifecycleHooks';
import type { ToolExecutionContext } from '../../types';

type ToolHookEvent = PreToolCallEvent | PostToolCallEvent;

export interface HookSignalSource {
  has(runId: string): boolean;
  getAbortSignal(runId: string): AbortSignal | undefined;
  getToolContext?: (runId: string) => ToolExecutionContext | undefined;
}

const signalSources = new Map<string, HookSignalSource>();

export function registerHookSignalSource(name: string, source: HookSignalSource): void {
  signalSources.set(name, source);
}

function resolveRunSource(runId: string): HookSignalSource | undefined {
  for (const source of signalSources.values()) {
    if (source.has(runId)) return source;
  }
  return undefined;
}

function attachTrustedContext(
  event: HookEvent,
  runId: string,
  source: HookSignalSource,
): HookEvent | undefined {
  if (event.type !== 'preToolCall' && event.type !== 'postToolCall') return event;
  const abortSignal = source.getAbortSignal(runId);
  const toolContext = source.getToolContext?.(runId);
  // Tool hooks can execute skill commands, so an active run without a trusted
  // shell context is not safe to broadcast. Do not fall back to the hook's
  // activation context or to anything supplied over the wire.
  if (!toolContext) return undefined;
  const { toolContext: _wireToolContext, ...rest } = event;
  return {
    ...rest,
    ...(abortSignal ? { abortSignal } : {}),
    ...(toolContext ? { toolContext } : {}),
  } as ToolHookEvent;
}

function withoutAbortSignal(event: HookEvent): HookEvent {
  if (event.type !== 'preToolCall' && event.type !== 'postToolCall') return event;
  const {
    abortSignal: _abortSignal,
    toolContext: _toolContext,
    ...wireEvent
  } = event;
  return wireEvent as ToolHookEvent;
}

async function handleHookEmit(rawParams: unknown): Promise<unknown> {
  const params = rawParams as { runId?: unknown; event?: HookEvent } | null;
  if (!params?.event) {
    throw new SidecarRequestError(-32602, 'Invalid hook.emit params: event is required');
  }
  if (typeof params.runId !== 'string') {
    throw new SidecarRequestError(-32602, 'Invalid hook.emit params: runId is required');
  }
  const source = resolveRunSource(params.runId);
  if (!source) {
    throw new SidecarRequestError(-32000, `Unknown hook runId: ${params.runId}`);
  }
  const trustedEvent = attachTrustedContext(params.event, params.runId, source);
  if (!trustedEvent) {
    throw new SidecarRequestError(-32000, `Trusted hook context is unavailable: ${params.runId}`);
  }
  const result = await emitHook(trustedEvent);
  return withoutAbortSignal(result);
}

function handleHookNotify(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; event?: HookEvent } | null;
  if (!params?.event || typeof params.runId !== 'string') return;
  const source = resolveRunSource(params.runId);
  if (!source) return;
  const trustedEvent = attachTrustedContext(params.event, params.runId, source);
  if (!trustedEvent) return;
  void emitHook(trustedEvent);
}

let registered = false;

/** Idempotent — installs the single `hook.emit`/`hook.notify` handler pair
 *  exactly once, no matter how many times (or from which runner) it is
 *  called. Both `subagentRunner.ts` and `agentLoopRunner.ts` call this from
 *  their own idempotent `ensureHandlersRegistered()`. */
export function ensureHookBridgeRegistered(): void {
  if (registered) return;
  registered = true;
  onSidecarRequest('hook.emit', handleHookEmit);
  onSidecarNotification('hook.notify', (params: unknown) => handleHookNotify(params));
}

/** Test-only reset — clears the install flag so a fresh registration fires
 *  in the next test (mirrors `toolInvokeRouter.ts`'s reset discipline for
 *  module-level singleton state). */
export function __resetHookBridgeForTests(): void {
  registered = false;
  signalSources.clear();
}
