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
 * handlers are STATELESS — they call the global shell `emitHook`, and the
 * event carries its own `conversationId`, so there is no per-run routing to
 * do (unlike `tool.invoke`, which needs its `runId`-keyed source router). A
 * single neutral, idempotent registration therefore serves every run, and
 * both runners call it from their own `ensureHandlersRegistered()`.
 *
 * Hook direction/kind rationale (unchanged from the original subagent path):
 * only `preToolCall` has its RETURN VALUE consumed by the loop
 * (`blocked`/`modifiedInput`), so it is a REQUEST (`hook.emit`); every other
 * hook is fire-and-forget, so it is a NOTIFICATION (`hook.notify`).
 */
import { onSidecarRequest, onSidecarNotification, SidecarRequestError } from '../sidecar/sidecarManager';
import { emitHook } from './lifecycleHooks';
import type { HookEvent, PreToolCallEvent, PostToolCallEvent } from './lifecycleHooks';

type ToolHookEvent = PreToolCallEvent | PostToolCallEvent;

export interface HookSignalSource {
  getAbortSignal(runId: string): AbortSignal | undefined;
}

const signalSources = new Map<string, HookSignalSource>();

export function registerHookSignalSource(name: string, source: HookSignalSource): void {
  signalSources.set(name, source);
}

function resolveAbortSignal(runId: unknown): AbortSignal | undefined {
  if (typeof runId !== 'string') return undefined;
  for (const source of signalSources.values()) {
    const signal = source.getAbortSignal(runId);
    if (signal) return signal;
  }
  return undefined;
}

function attachAbortSignal(event: HookEvent, runId: unknown): HookEvent {
  if (event.type !== 'preToolCall' && event.type !== 'postToolCall') return event;
  const abortSignal = resolveAbortSignal(runId);
  return abortSignal ? { ...event, abortSignal } : event;
}

function withoutAbortSignal(event: HookEvent): HookEvent {
  if (event.type !== 'preToolCall' && event.type !== 'postToolCall') return event;
  const { abortSignal: _abortSignal, ...wireEvent } = event;
  return wireEvent as ToolHookEvent;
}

async function handleHookEmit(rawParams: unknown): Promise<unknown> {
  const params = rawParams as { runId?: unknown; event?: HookEvent } | null;
  if (!params?.event) {
    throw new SidecarRequestError(-32602, 'Invalid hook.emit params: event is required');
  }
  const result = await emitHook(attachAbortSignal(params.event, params.runId));
  return withoutAbortSignal(result);
}

function handleHookNotify(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; event?: HookEvent } | null;
  if (!params?.event) return;
  void emitHook(attachAbortSignal(params.event, params.runId));
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
