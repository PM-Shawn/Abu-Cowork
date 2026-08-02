/**
 * Unified `tool.invoke` reverse-RPC registration — P1-3B-3B.
 *
 * `sidecarManager.ts`'s `onSidecarRequest(method, handler)` allows exactly
 * ONE handler per method (a request needs exactly one response; registering
 * a second handler for the same method REPLACES the first — see that
 * module's own doc comment). Both `subagentRunner.ts` (P1-3a, subagent mini-
 * loop runs) and `agentLoopRunner.ts` (P1-3B-3B, main-loop runs) need to
 * answer `tool.invoke` requests for THEIR OWN runs — if each module called
 * `onSidecarRequest('tool.invoke', ...)` directly, whichever one dispatched
 * to the sidecar LAST would silently clobber the other's registration,
 * breaking that run's tool execution outright (not a hypothetical — a
 * `delegate_to_agent` subagent run dispatched after a main-loop run, or vice
 * versa, would trigger this on any real session).
 *
 * This module is the single, neutral registration point both sides route
 * through: each side registers a named `ToolInvokeSource` (a `has`/`handle`
 * pair over its OWN run-session registry) via `registerToolInvokeSource`,
 * and `ensureToolInvokeRouterRegistered()` installs exactly one real
 * `onSidecarRequest('tool.invoke', ...)` handler that dispatches to whichever
 * registered source owns the incoming `runId`. Neither `subagentRunner.ts`
 * nor `agentLoopRunner.ts` imports the other — both only depend on this
 * leaf module, so there is no import cycle.
 */
import { onSidecarRequest, SidecarRequestError } from '../sidecar/sidecarManager';

export interface ToolInvokeSource {
  /** True if this source owns an active run under the given runId. */
  has(runId: string): boolean;
  /** Handle a tool.invoke request already confirmed to belong to this source. */
  handle(rawParams: unknown): Promise<unknown>;
}

/** Keyed by a stable source name (e.g. 'subagent', 'agentLoop') — registering
 *  the same name twice replaces the entry, so callers can register from an
 *  idempotent "ensure handlers registered" path without accumulating
 *  duplicates. */
const sources = new Map<string, ToolInvokeSource>();

export function registerToolInvokeSource(name: string, source: ToolInvokeSource): void {
  sources.set(name, source);
}

/** Test-only — clears registered sources without touching the `registered`
 *  install flag (mirrors the reset-between-tests discipline used elsewhere
 *  in this codebase for module-level singleton state). */
export function __resetToolInvokeSourcesForTests(): void {
  sources.clear();
}

async function routeToolInvoke(rawParams: unknown): Promise<unknown> {
  const runId = (rawParams as { runId?: unknown } | null)?.runId;
  if (typeof runId === 'string') {
    for (const source of sources.values()) {
      if (source.has(runId)) return source.handle(rawParams);
    }
  }
  throw new SidecarRequestError(
    -32000,
    `tool.invoke: unknown runId "${String(runId)}" (not an active subagent or agent-loop run)`,
  );
}

let registered = false;

/** Idempotent — installs the single unified `tool.invoke` handler exactly
 *  once. Both `subagentRunner.ts` and `agentLoopRunner.ts` call this from
 *  their own (also idempotent) `ensureHandlersRegistered()`. */
export function ensureToolInvokeRouterRegistered(): void {
  if (registered) return;
  registered = true;
  onSidecarRequest('tool.invoke', routeToolInvoke);
}

/** Test-only reset. */
export function __resetToolInvokeRouterForTests(): void {
  registered = false;
  sources.clear();
}
