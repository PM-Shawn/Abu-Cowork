/**
 * Subagent run-session registry + selector — the ONLY entry point callers
 * should use to run a subagent going forward (P1-3a "正式步 3a", see
 * docs/2026-07-19-phase1-p3-loop-migration-staging.md §2). Routes to the
 * cross-process sidecar path when the sidecar is confirmed `'running'`,
 * else runs `runSubagentLoop` in-process unchanged — same zero-risk
 * open/closed selector shape as `selectChatAdapter()` (P1-1), reused here
 * for the third time.
 *
 * ## Wire protocol (shell → sidecar)
 *
 * `subagent.run` (REQUEST, timeoutMs: 0 — mirrors `llm.chat`'s unbounded-
 * stream discipline): params = a serializable projection of
 * `SubagentLoopOptions`, built once at dispatch time by
 * `buildSubagentRunParams()` below. See that function for the full field
 * list; P1-3a-REPORT.md has the field-by-field "how it crosses" table.
 *
 * `subagent.abort` (NOTIFICATION): `{ runId }` — same fire-and-forget +
 * 5s abort-grace-timer discipline as `SidecarLLMAdapter.chat()`
 * (src/core/llm/sidecarAdapter.ts) — studied and replicated below.
 *
 * ## Reverse channel (sidecar → shell)
 *
 * `tool.invoke` (REQUEST): `{ runId, toolName, input, context }` → this
 * module's `handleToolInvoke()` executes via the REAL in-process
 * `ToolInvoker` (registry + pathSafety + permissions + approvals, today's
 * code, unmoved), threading the ORIGINAL session's
 * `commandConfirmCallback`/`filePermissionCallback` — see
 * `subagentLoop.ts:~648` (`toolInvoker.executeAnyTool(...)`) for the
 * call shape being mirrored.
 *
 * `hook.emit` (REQUEST) / `hook.notify` (NOTIFICATION): see the "hooks
 * verdict" doc comment on `handleHookEmit`/`handleHookNotify` below —
 * `preToolCall` is the only lifecycle event whose return value is
 * consumed (block/modify), so it alone goes through the request/response
 * channel; the rest are fire-and-forget.
 *
 * `subagent.progress` (NOTIFICATION): `{ runId, event: SubagentProgressEvent }`
 * — tool-start/tool-end/turn-complete progress, fire-and-forget (progress
 * must never block the loop on an ack — same discipline as `hook.notify`).
 * Feeds the SAME `onProgress` callback the original session's caller
 * passed to `runSubagent()` (e.g. `agentTools.ts`/`orchestrationTools.ts`'s
 * child-step visualization wiring) — without this, a sidecar-run subagent
 * would produce no incremental UI updates at all, only the final result.
 * Dispatched to `session.options.onProgress`; unknown `runId` → silent
 * drop (the run may have already finished — see `handleSubagentProgress`).
 * See `sidecar/src/subagentHost.ts`'s `onProgress` wiring for the
 * serializability verification and the pipe-ordering note (progress always
 * arrives before that run's final `subagent.run` response, since both
 * travel the same single ordered NDJSON stream).
 *
 * ## Fallback discipline
 *
 * A `subagent.run` request can fail two structurally different ways:
 *   1. Before any `tool.invoke` arrived for this runId → nothing has
 *      executed yet (no side effects) → safe to retry the WHOLE run
 *      in-process via `runSubagentLoop`.
 *   2. After ≥1 `tool.invoke` arrived → the subagent may have already
 *      run a tool with real side effects (wrote a file, ran a command) →
 *      re-running from scratch could double-execute those effects, so
 *      this surfaces as a failed `SubagentResult` instead — the exact
 *      shape a failed subagent already produces today (see
 *      `subagentLoop.ts`'s outer catch block).
 * `RunSession.firstToolInvokeArrived` is the bit that decides which path
 * fires — set the instant `handleToolInvoke` sees a matching runId.
 */
import type { ToolDefinition, ToolExecutionContext } from '../../types';
import {
  getSidecarStatus,
  request as sidecarRequest,
  notifySidecar,
  onSidecarNotification,
  SidecarRequestError,
} from '../sidecar/sidecarManager';
import { runSubagentLoop, SubagentResult, type SubagentLoopOptions, type SubagentProgressEvent } from './subagentLoop';
import { registerToolInvokeSource, ensureToolInvokeRouterRegistered } from './toolInvokeRouter';
import { ensureHookBridgeRegistered, registerHookSignalSource } from './hookBridge';
import { createLogger } from '../logging/logger';

const logger = createLogger('subagent-transport');
import { getToolInvoker } from './ports/toolInvoker';
import { getSettingsReader } from './ports/settingsReader';
import { getWorkspaceReader } from './ports/workspaceReader';
import { getActiveApiKey, getActiveProvider } from '../../utils/settingsSelectors';
import { resolveEffectiveLlmCreds } from '../enterprise/llm-resolver';
import { getI18n, getLocale } from '../../i18n';
import { buildSubagentUiStrings } from './subagentUiStrings';

/** Same defensive ceiling as SidecarLLMAdapter.chat() — see that file's module doc for the rationale (a wedged sidecar event loop must not hang the caller forever after we've asked it to abort). */
const ABORT_GRACE_MS = 5_000;

/** Wire-safe tool projection sent to the sidecar — `execute` (a function) is dropped; the sidecar never calls it directly (tool execution always reverses to `tool.invoke`). */
export interface SerializableToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
}

/** Exported for reuse by agentLoopRunner.ts's `tool.list` REQUEST handler (P1-3b-2 item 5) — same wire-safe tool projection, no need for a second copy. */
export function toSerializableTool(t: ToolDefinition): SerializableToolDefinition {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

/** The `subagent.run` request params — see this file's module doc for the wire protocol. */
export interface SubagentRunParams {
  runId: string;
  agent: SubagentLoopOptions['agent'];
  task: string;
  context?: string;
  parentConversationSummary?: string;
  parentConversationId?: string;
  imContext?: SubagentLoopOptions['imContext'];
  locale: string;
  uiStrings: ReturnType<typeof buildSubagentUiStrings>;
  settingsSnapshot: ReturnType<ReturnType<typeof getSettingsReader>['getSnapshot']>;
  resolvedCreds: { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean };
  tools: SerializableToolDefinition[];
  /**
   * Pre-resolved shell-side WorkspaceReader value (see subagentLoop.ts's
   * `options.imContext?.workspacePath ?? workspaceReaderInst.getCurrentPath()`
   * fallback) — frozen for the whole run, same discipline as
   * `resolvedCreds`. subagentHost.ts wraps this in a trivial per-run
   * WorkspaceReader on the sidecar side.
   */
  workspacePathSnapshot: string | null;
}

/** Wire-safe SubagentResult projection — plain data, matches `new SubagentResult(...)`'s constructor param shape exactly so the shell can reconstruct a real instance. */
interface SerializableSubagentResult {
  text: string;
  toolCallCount: number;
  turnCount: number;
  tokenUsage: { input: number; output: number };
  duration: number;
}

function isSerializableSubagentResult(v: unknown): v is SerializableSubagentResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).text === 'string' &&
    typeof (v as Record<string, unknown>).toolCallCount === 'number' &&
    typeof (v as Record<string, unknown>).turnCount === 'number' &&
    typeof (v as Record<string, unknown>).duration === 'number'
  );
}

// ── Run-session registry ────────────────────────────────────────────────
//
// Callbacks and the AbortSignal deliberately stay HERE (never serialized) —
// only the runId crosses the wire. See module doc's "Reverse channel".

interface RunSession {
  options: SubagentLoopOptions;
  /** Set true the instant handleToolInvoke sees ≥1 call for this runId — see module doc's "Fallback discipline". */
  firstToolInvokeArrived: boolean;
}

const sessions = new Map<string, RunSession>();

let runIdCounter = 0;
function generateRunId(): string {
  runIdCounter += 1;
  return `sar-${Date.now().toString(36)}-${runIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Reverse-channel handlers (registered ONCE at module init) ──────────

/**
 * `tool.invoke` shell handler — executes via the REAL in-process
 * `ToolInvoker` (registry.ts, unmoved: pathSafety + permissions + approvals
 * all still run here exactly as they do for an in-process subagent run),
 * threading the ORIGINAL session's callbacks. Mirrors
 * `subagentLoop.ts`'s own `toolInvoker.executeAnyTool(...)` call shape
 * (studied at `subagentLoop.ts:~648`).
 */
async function handleToolInvoke(rawParams: unknown): Promise<unknown> {
  const params = rawParams as {
    runId?: unknown;
    toolName?: unknown;
    input?: unknown;
    context?: unknown;
  } | null;

  if (!params || typeof params.runId !== 'string' || typeof params.toolName !== 'string') {
    throw new SidecarRequestError(-32602, 'Invalid tool.invoke params: runId and toolName must be strings');
  }

  const session = sessions.get(params.runId);
  if (!session) {
    throw new SidecarRequestError(-32000, `Unknown subagent runId: ${params.runId}`);
  }
  session.firstToolInvokeArrived = true;

  const invoker = getToolInvoker(); // shell-side in-process default — registry-backed, same as any in-process subagent run.
  return await invoker.executeAnyTool(
    params.toolName,
    (params.input as Record<string, unknown>) ?? {},
    session.options.commandConfirmCallback,
    session.options.filePermissionCallback,
    {
      ...((params.context as ToolExecutionContext | undefined) ?? {}),
      abortSignal: session.options.signal,
    },
  );
}

/**
 * `subagent.progress` shell handler — forwards a tool-start/tool-end/
 * turn-complete event to the ORIGINAL session's `onProgress` callback (the
 * one the caller passed into `runSubagent()`, e.g. `agentTools.ts`'s
 * `delegate_to_agent` wiring the execution panel's child-step
 * visualization). Fire-and-forget, matching `handleHookNotify` — an
 * unknown `runId` (the run already finished, or a stray/duplicate message)
 * is a silent drop, same discipline as `handleSubagentAbort`'s unknown-
 * runId no-op on the sidecar side.
 */
function handleSubagentProgress(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; event?: SubagentProgressEvent } | null;
  if (!params || typeof params.runId !== 'string' || !params.event) return;
  const session = sessions.get(params.runId);
  if (!session) return; // unknown/already-finished runId — silent drop
  session.options.onProgress?.(params.event);
}

let handlersRegistered = false;

/** Idempotent — registers the tool.invoke/hook.emit/hook.notify/subagent.progress handlers exactly once, no matter how many times runSubagent() is called.
 *
 * `tool.invoke` itself is NOT registered directly via `onSidecarRequest`
 * here — `onSidecarRequest` allows exactly one handler per method, and
 * `agentLoopRunner.ts` (P1-3B-3B) also needs to answer `tool.invoke` for
 * MAIN-loop runs. Both sides register a named source with the shared
 * `toolInvokeRouter.ts` instead — see that module's doc for why. */
function ensureHandlersRegistered(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  registerToolInvokeSource('subagent', { has: (runId) => sessions.has(runId), handle: handleToolInvoke });
  ensureToolInvokeRouterRegistered();
  registerHookSignalSource('subagent', {
    getAbortSignal: (runId) => sessions.get(runId)?.options.signal,
  });
  // hook.emit / hook.notify are shared with the main-loop path (both run in
  // the sidecar and forward hooks to the real webview registry) — registered
  // via the neutral hookBridge so neither path clobbers the other and a
  // main-loop-only session still has them (see hookBridge.ts's doc).
  ensureHookBridgeRegistered();
  // subagent.progress is fire-and-forget AND session-bound (routes to the
  // originating runSubagent() caller's onProgress by runId), so it stays here.
  onSidecarNotification('subagent.progress', (params: unknown) => handleSubagentProgress(params));
}

// ── Dispatch-time serializable projection ───────────────────────────────

/**
 * Build the `subagent.run` wire params — the "serializable projection" of
 * `SubagentLoopOptions` per the design doc's anti-bleed entry-snapshot
 * principle: LLM creds are PRE-RESOLVED here (shell-side, using the LIVE
 * settings/enterprise state at dispatch time) rather than re-derived
 * mid-loop inside the sidecar — see `sidecar/src/shims/enterpriseCredsRun.ts`
 * for the sidecar-side half of this contract and its documented "frozen for
 * the whole run" simplification.
 *
 * Throws if `resolveEffectiveLlmCreds` throws (e.g.
 * `EnterpriseLlmUnavailableError`) — the caller (`runSubagent`) treats that
 * as a pre-dispatch failure and falls back to `runSubagentLoop` in-process,
 * which hits the identical real error path itself rather than this
 * function duplicating its error-shaping logic.
 */
function buildSubagentRunParams(runId: string, options: SubagentLoopOptions): SubagentRunParams {
  const settingsReader = options.settingsReader ?? getSettingsReader();
  const settingsSnapshot = settingsReader.getSnapshot();
  const toolInvoker = options.toolInvoker ?? getToolInvoker();
  const tools = toolInvoker.getAllTools().map(toSerializableTool);

  const resolvedCreds = resolveEffectiveLlmCreds(
    getActiveApiKey(settingsSnapshot),
    getActiveProvider(settingsSnapshot)?.baseUrl || undefined,
  );

  const workspaceReader = options.workspaceReader ?? getWorkspaceReader();

  return {
    runId,
    agent: options.agent,
    task: options.task,
    context: options.context,
    parentConversationSummary: options.parentConversationSummary,
    parentConversationId: options.parentConversationId,
    imContext: options.imContext,
    locale: getLocale(),
    uiStrings: buildSubagentUiStrings(getI18n()),
    settingsSnapshot,
    resolvedCreds,
    tools,
    workspacePathSnapshot: workspaceReader.getCurrentPath(),
  };
}

function reconstructSubagentResult(raw: unknown): SubagentResult {
  if (!isSerializableSubagentResult(raw)) {
    throw new Error('subagent.run response did not match the expected SubagentResult shape');
  }
  return new SubagentResult(raw);
}

function cancelledSubagentResult(): SubagentResult {
  return new SubagentResult({
    text: getI18n().chat.subagent.taskCancelled,
    toolCallCount: 0,
    turnCount: 0,
    tokenUsage: { input: 0, output: 0 },
    duration: 0,
  });
}

// ── Public entry point ──────────────────────────────────────────────────

/**
 * Run a subagent — routes to the sidecar when it's `'running'`, else runs
 * `runSubagentLoop` in-process unchanged. See module doc for the wire
 * protocol and fallback discipline.
 */
export async function runSubagent(options: SubagentLoopOptions): Promise<SubagentResult> {
  if (options.signal?.aborted) {
    return cancelledSubagentResult();
  }

  if (getSidecarStatus() !== 'running') {
    logger.debug('subagent path selected', { path: 'local', sidecarStatus: getSidecarStatus() });
    return runSubagentLoop(options);
  }

  ensureHandlersRegistered();

  const runId = generateRunId();
  logger.debug('subagent path selected', { path: 'sidecar', runId, agent: options.agent?.name });

  let params: SubagentRunParams;
  try {
    params = buildSubagentRunParams(runId, options);
  } catch (err) {
    // Failed before any dispatch — no tool has executed. Fall back to the
    // in-process engine, which hits the identical real error path (e.g.
    // EnterpriseLlmUnavailableError) itself. See buildSubagentRunParams's doc.
    logger.warn('subagent params build failed — running in-process', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return runSubagentLoop(options);
  }

  const session: RunSession = { options, firstToolInvokeArrived: false };
  sessions.set(runId, session);

  const signal = options.signal;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectOnGrace: ((err: Error) => void) | undefined;
  const gracePromise = new Promise<never>((_, reject) => {
    rejectOnGrace = reject;
  });
  gracePromise.catch(() => {});

  const onAbort = (): void => {
    notifySidecar('subagent.abort', { runId });
    graceTimer = setTimeout(() => {
      rejectOnGrace?.(new Error('Subagent abort grace period exceeded'));
    }, ABORT_GRACE_MS);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // timeoutMs: 0 — a subagent run is unbounded (same discipline as llm.chat
  // / SidecarLLMAdapter.chat()); hang protection is the abort-grace timer
  // above, armed only once an abort actually happens.
  const requestPromise = sidecarRequest('subagent.run', params, 0);
  requestPromise.catch(() => {}); // avoid an unhandled rejection if the grace timer wins the race below

  try {
    const raw = signal ? await Promise.race([requestPromise, gracePromise]) : await requestPromise;
    return reconstructSubagentResult(raw);
  } catch (err) {
    // User cancellation and transport failure are different outcomes. Even
    // before the first tool call, a cancelled run must never be resurrected in
    // the in-process engine after the sidecar abort grace period expires.
    if (signal?.aborted) {
      return cancelledSubagentResult();
    }
    if (!session.firstToolInvokeArrived) {
      // Nothing executed yet — safe to retry the whole run in-process.
      logger.warn('subagent transport failed before first tool — retrying in-process', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return runSubagentLoop(options);
    }
    logger.warn('subagent transport failed after tool execution — surfacing error, no rerun', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    // At least one tool already ran with (possibly real) side effects —
    // surface as a failed result, matching the shape runSubagentLoop's own
    // outer catch produces today. NO rerun.
    const message = err instanceof Error ? err.message : String(err);
    return new SubagentResult({
      text: `Error: ${message}`,
      toolCallCount: 0,
      turnCount: 0,
      tokenUsage: { input: 0, output: 0 },
      duration: 0,
    });
  } finally {
    sessions.delete(runId);
    if (graceTimer) clearTimeout(graceTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}
