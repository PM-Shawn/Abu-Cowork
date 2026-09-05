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
 * fires — set the instant `handleToolInvoke` sees a matching runId. Progress
 * is buffered until that commit point (or a valid successful response), so a
 * pre-commit transport failure cannot leave a ghost tool step behind.
 */
import type { ToolDefinition, ToolExecutionContext, UpstreamErrorDetails } from '../../types';
import {
  getSidecarStatus,
  request as sidecarRequest,
  notifySidecar,
  onSidecarNotification,
  SidecarRequestError,
} from '../sidecar/sidecarManager';
import {
  buildSubagentMcpPreflightFailure,
  runSubagentLoop,
  resolveSubagentInteractionMode,
  SubagentResult,
  type SubagentLoopOptions,
  type SubagentProgressEvent,
  type SubagentStopReason,
} from './subagentLoop';
import { resolveSubagentToolRoster } from './subagentToolRoster';
import { registerToolInvokeSource, ensureToolInvokeRouterRegistered } from './toolInvokeRouter';
import { ensureHookBridgeRegistered, registerHookSignalSource } from './hookBridge';
import { createLogger } from '../logging/logger';
import { isUpstreamErrorDetails, sanitizeUntrustedLlmErrorText } from '../llm/adapter';
import type { LoopContext } from './permissionBridge';
import { attachTrustedSkillCommandApproval } from './skillCommandApproval';
import { normalizeIMRunCapability } from '../permissions/runPermissionCeiling';
import {
  createRunResourceSettlement,
  registerRunResourceSettlement,
  unregisterRunResourceSettlement,
  type RunResourceSettlement,
} from './runResourceSettlement';

const logger = createLogger('subagent-transport');

/** Security boundary for tool-triggered nesting: inherit the parent run's
 * frozen provider/model snapshot and conversation identity as one unit. */
export function getSubagentRunInheritance(
  loopContext: Pick<LoopContext, 'loopId' | 'conversationId' | 'settingsReader' | 'authorizationScopeId' | 'runPermissionCeiling' | 'imReplyTarget' | 'triggerId' | 'scheduledTaskId'> | null | undefined,
  authorizationScopeId?: string,
  workspacePath?: string | null,
): Pick<SubagentLoopOptions, 'parentLoopId' | 'parentConversationId' | 'settingsReader' | 'authorizationScopeId' | 'runPermissionCeiling' | 'workspaceReader' | 'imContext' | 'triggerId' | 'scheduledTaskId'> {
  const imReplyTarget = loopContext?.imReplyTarget;
  const runPermissionCeiling = loopContext?.runPermissionCeiling;
  const imContext = imReplyTarget && runPermissionCeiling?.source === 'im'
    ? {
        platform: imReplyTarget.platform,
        replyChatId: imReplyTarget.chatId,
        workspacePath: workspacePath ?? null,
        capability: normalizeIMRunCapability(runPermissionCeiling.capability),
      }
    : undefined;
  return {
    parentLoopId: loopContext?.loopId,
    parentConversationId: loopContext?.conversationId,
    settingsReader: loopContext?.settingsReader,
    authorizationScopeId: authorizationScopeId ?? loopContext?.authorizationScopeId,
    runPermissionCeiling,
    ...(loopContext?.triggerId !== undefined ? { triggerId: loopContext.triggerId } : {}),
    ...(loopContext?.scheduledTaskId !== undefined
      ? { scheduledTaskId: loopContext.scheduledTaskId }
      : {}),
    ...(imContext ? { imContext } : {}),
    ...(workspacePath !== undefined
      ? { workspaceReader: { getCurrentPath: () => workspacePath } }
      : {}),
  };
}
import { getToolInvoker } from './ports/toolInvoker';
import { getSettingsReader } from './ports/settingsReader';
import { getWorkspaceReader } from './ports/workspaceReader';
import { getActiveApiKey, getActiveProvider } from '../../utils/settingsSelectors';
import { resolveEffectiveLlmCreds } from '../enterprise/llm-resolver';
import { getI18n, getLocale } from '../../i18n';
import { buildSubagentUiStrings } from './subagentUiStrings';
import { matchesToolName, matchesToolPattern } from '../skill/toolFilter';
import { SUBAGENT_RUN_WIRE_FIELDS as SHARED_SUBAGENT_RUN_WIRE_FIELDS } from './subagentWireContract';
import {
  createSubagentProgressScopeId,
  scopeSubagentLoopProgress,
  scopeSubagentProgressEvent,
} from './subagentProgressIdentity';
import { disposeRunBrowserViews } from '../browser/browserViewLifecycle';
import { releaseRunBrowserTabClaims } from '../browser/bridgeTabClaims';
import {
  materializeSidecarMediaRefsForShell,
  prepareToolResultForSidecarWire,
  redactSidecarValueForWireFailure,
  sidecarValueHasOpaqueMediaRefs,
} from '../subagent/delegatedUserTurnMaterializer';

/** Same defensive ceiling as SidecarLLMAdapter.chat() — see that file's module doc for the rationale (a wedged sidecar event loop must not hang the caller forever after we've asked it to abort). */
const ABORT_GRACE_MS = 5_000;
const PROGRESS_MEDIA_DISPLAY_ERROR = 'Error: Could not prepare sidecar progress media for display.';

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
  delegatedUserTurn?: SubagentLoopOptions['delegatedUserTurn'];
  delegatedMediaFallback?: SubagentLoopOptions['delegatedMediaFallback'];
  parentConversationId?: string;
  parentLoopId?: string;
  parentUserMessageId?: string;
  persistParentToolImages?: boolean;
  imContext?: SubagentLoopOptions['imContext'];
  allowedTools?: string[];
  /** Mirror of allowedTools — the run-scoped denylist MUST cross the wire
   *  too. Omitting it silently re-armed every blockedTools-only safety tier
   *  (scheduler / trigger full+safe_tools / IM) the moment the subagent ran
   *  in the sidecar: the sidecar rebuilt SubagentLoopOptions with
   *  blockedTools undefined, so both the roster filter and the execution
   *  check no-oped. */
  blockedTools?: string[];
  authorizationScopeId?: string;
  runPermissionCeiling?: import('../permissions/runPermissionCeiling').RunPermissionCeiling;
  triggerId?: string;
  scheduledTaskId?: string;
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

export const SUBAGENT_RUN_WIRE_FIELDS =
  SHARED_SUBAGENT_RUN_WIRE_FIELDS satisfies readonly (keyof SubagentRunParams)[];

type AssertNever<T extends never> = T;

/**
 * Production-module type gates (tests are excluded from tsconfig.app.json):
 * - every request param must appear in the canonical wire tuple;
 * - every loop option must be explicitly classified as wire-backed or local.
 *
 * Adding a field without updating this contract now fails `npm run typecheck`.
 */
export type SubagentRunParamsWireExhaustive = AssertNever<
  Exclude<keyof SubagentRunParams, typeof SUBAGENT_RUN_WIRE_FIELDS[number]>
>;

/** Loop options carried by the request are derived from the canonical tuple,
 * not a second hand-maintained classification that could drift from params. */
export type SubagentWireBackedLoopOptionField = Extract<
  typeof SUBAGENT_RUN_WIRE_FIELDS[number],
  keyof SubagentLoopOptions
>;

export const SUBAGENT_LOOP_OPTIONS_INTENTIONALLY_LOCAL_FIELDS = [
  'signal',
  'commandConfirmCallback',
  'filePermissionCallback',
  'onProgress',
  'settingsReader',
  'toolInvoker',
  'capsPort',
  'workspaceReader',
  'skillCommandApprovalFactory',
  // Deliberately NOT on the wire: run identity is what decides whose browser
  // tabs a tool call may see and reclaim, so the shell stamps it into the
  // trusted tool context from its OWN session (`RunSession.runId`) rather than
  // accepting the sidecar's copy. Sending it would create a second, forgeable
  // source of the same fact. The in-process engine reads it from these options
  // directly, which is why the field exists at all.
  'agentRunId',
] as const satisfies readonly (keyof SubagentLoopOptions)[];

export type SubagentLoopOptionsWireExhaustive = AssertNever<
  Exclude<
    keyof SubagentLoopOptions,
    SubagentWireBackedLoopOptionField | typeof SUBAGENT_LOOP_OPTIONS_INTENTIONALLY_LOCAL_FIELDS[number]
  >
>;

/** Wire-safe SubagentResult projection — plain data, matches `new SubagentResult(...)`'s constructor param shape exactly so the shell can reconstruct a real instance. */
interface SerializableSubagentResult {
  text: string;
  toolCallCount: number;
  turnCount: number;
  tokenUsage: { input: number; output: number };
  duration: number;
  stopReason?: SubagentStopReason;
  upstream?: UpstreamErrorDetails;
}

function isSubagentStopReason(v: unknown): v is SubagentStopReason {
  return v === 'completed' || v === 'aborted' || v === 'error' || v === 'max_turns';
}

const SERIALIZABLE_SUBAGENT_RESULT_KEYS = new Set([
  'text',
  'toolCallCount',
  'turnCount',
  'tokenUsage',
  'duration',
  'stopReason',
  'upstream',
]);
const SUBAGENT_TOKEN_USAGE_KEYS = new Set(['input', 'output']);

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSerializableSubagentResult(v: unknown): v is SerializableSubagentResult {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const record = v as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SERIALIZABLE_SUBAGENT_RESULT_KEYS.has(key))) return false;
  if (typeof record.tokenUsage !== 'object' || record.tokenUsage === null || Array.isArray(record.tokenUsage)) {
    return false;
  }
  const tokenUsage = record.tokenUsage as Record<string, unknown>;
  return Object.keys(tokenUsage).every((key) => SUBAGENT_TOKEN_USAGE_KEYS.has(key))
    && typeof record.text === 'string'
    && isFiniteNonNegativeInteger(record.toolCallCount)
    && isFiniteNonNegativeInteger(record.turnCount)
    && isFiniteNonNegativeInteger(tokenUsage.input)
    && isFiniteNonNegativeInteger(tokenUsage.output)
    && typeof record.duration === 'number'
    && Number.isFinite(record.duration)
    && record.duration >= 0
    && (record.stopReason === undefined || isSubagentStopReason(record.stopReason))
    && (record.upstream === undefined
      || (record.stopReason === 'error' && isUpstreamErrorDetails(record.upstream)));
}

// ── Run-session registry ────────────────────────────────────────────────
//
// Callbacks and the AbortSignal deliberately stay HERE (never serialized) —
// only the runId crosses the wire. See module doc's "Reverse channel".

interface RunSession {
  /**
   * The app-owned `sar-*` id this session is registered under. Held on the
   * session so `buildTrustedSubagentToolContext` can stamp it into every tool
   * context WITHOUT trusting the sidecar's copy — the sidecar sends a `context`
   * with each `tool.invoke`, and run identity is exactly the kind of field a
   * compromised or buggy sidecar must not be able to choose (it decides which
   * run's browser tabs the call may see and reclaim).
   */
  runId: string;
  options: SubagentLoopOptions;
  /** Shell-owned outbound identity for IM tools; never accepted from sidecar context. */
  imReplyTarget?: { platform: string; chatId: string };
  /** Frozen shell-side mirror of the roster sent to the sidecar loop. */
  offeredToolNames: ReadonlySet<string>;
  /** Set true the instant handleToolInvoke sees ≥1 call for this runId — see module doc's "Fallback discipline". */
  firstToolInvokeArrived: boolean;
  /** Progress received before the sidecar run reaches a no-rerun commit point. */
  bufferedProgress: SubagentProgressEvent[];
  /** Ordered async ref materialization before progress is exposed to shell UI. */
  progressApplyTail: Promise<void>;
  /** True while progressApplyTail is protecting order for a pending progress event. */
  progressApplyBusy: boolean;
  resourceSettlement: RunResourceSettlement;
}

const sessions = new Map<string, RunSession>();

function buildTrustedSubagentToolContext(
  session: RunSession,
  incoming?: ToolExecutionContext,
): ToolExecutionContext {
  const trustedContext: ToolExecutionContext = {
    ...incoming,
    workspacePath: session.options.workspaceReader?.getCurrentPath() ?? null,
    authorizationScopeId: session.options.authorizationScopeId,
    runPermissionCeiling: session.options.runPermissionCeiling,
    loopId: session.options.parentLoopId,
    conversationId: session.options.parentConversationId,
    agentRunId: session.runId,
    imReplyTarget: session.imReplyTarget ? { ...session.imReplyTarget } : undefined,
    interactionMode: resolveSubagentInteractionMode(session.options),
    abortSignal: session.options.signal,
  };
  return attachTrustedSkillCommandApproval(trustedContext, {
    commandConfirmCallback: session.options.commandConfirmCallback,
    filePermissionCallback: session.options.filePermissionCallback,
  });
}

function withTrustedSkillCommandApproval(
  options: SubagentLoopOptions,
): SubagentLoopOptions {
  return {
    ...options,
    skillCommandApprovalFactory: (context) =>
      attachTrustedSkillCommandApproval(context, {
        commandConfirmCallback: options.commandConfirmCallback,
        filePermissionCallback: options.filePermissionCallback,
      }).skillCommandApproval!,
  };
}

function publishSessionProgress(session: RunSession, event: SubagentProgressEvent): void {
  try {
    session.options.onProgress?.(event);
  } catch (err) {
    // Progress is observational and must never turn a committed tool request
    // or a valid sidecar result into a transport failure.
    logger.warn('subagent progress callback threw', {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function flushBufferedProgress(session: RunSession): void {
  const buffered = session.bufferedProgress.splice(0);
  for (const event of buffered) publishSessionProgress(session, event);
}

function failClosedProgressDisplayEvent(event: SubagentProgressEvent): SubagentProgressEvent {
  const safeEvent = redactSidecarValueForWireFailure(event) as SubagentProgressEvent;
  if (safeEvent.type !== 'tool-end') return safeEvent;
  return {
    ...safeEvent,
    result: PROGRESS_MEDIA_DISPLAY_ERROR,
    error: true,
    resultContent: undefined,
  };
}

function enqueueProgressApply(session: RunSession, task: () => void | Promise<void>): void {
  session.progressApplyBusy = true;
  const current = session.progressApplyTail.then(async () => {
    await task();
  });
  session.progressApplyTail = current.catch(() => undefined);
  const capturedTail = session.progressApplyTail;
  void capturedTail.finally(() => {
    if (session.progressApplyTail === capturedTail) {
      session.progressApplyBusy = false;
    }
  });
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

  const { runId, toolName } = params;
  const session = sessions.get(runId);
  if (!session) {
    throw new SidecarRequestError(-32000, `Unknown subagent runId: ${runId}`);
  }
  if (session.options.signal?.aborted) {
    throw new SidecarRequestError(-32000, `Subagent run is stopping: ${runId}`);
  }
  if (
    session.options.allowedTools?.length &&
    !session.options.allowedTools.some((pattern) =>
      matchesToolPattern(
        toolName,
        pattern,
        (params.input as Record<string, unknown>) ?? {},
      ),
    )
  ) {
    throw new SidecarRequestError(-32602, `Tool is not allowed for this subagent run: ${toolName}`);
  }

  // Denylist checked at the execution boundary too, mirroring both the
  // allowedTools check above and subagentLoop.ts's own execution-time
  // check: the model can name a tool that was never offered, and a
  // sidecar-side roster filter alone would leave this reverse channel as
  // the one door the restriction never covered.
  if (
    session.options.blockedTools?.some((pattern) =>
      matchesToolName(params.toolName as string, pattern),
    )
  ) {
    throw new SidecarRequestError(-32602, `Tool is blocked for this subagent run: ${params.toolName}`);
  }

  if (!session.offeredToolNames.has(params.toolName)) {
    throw new SidecarRequestError(
      -32602,
      `Tool is outside this agent's fixed tool boundary: ${params.toolName}`,
    );
  }
  if (
    session.options.agent.tools?.length
    && !session.options.agent.tools.some((pattern) =>
      matchesToolPattern(
        params.toolName as string,
        pattern,
        (params.input as Record<string, unknown>) ?? {},
      ),
    )
  ) {
    throw new SidecarRequestError(
      -32602,
      `Tool input is outside this agent's fixed tool boundary: ${params.toolName}`,
    );
  }

  // The run becomes non-rerunnable only after every inherited/fixed roster
  // and input constraint accepts the request. A rejected request has produced
  // no side effect, so publishing its buffered tool-start would create a ghost
  // step and incorrectly suppress the safe local fallback.
  if (!session.firstToolInvokeArrived) {
    session.firstToolInvokeArrived = true;
    flushBufferedProgress(session);
  }

  const invoker = getToolInvoker(); // shell-side in-process default — registry-backed, same as any in-process subagent run.
  const result = await session.resourceSettlement.run(() => invoker.executeAnyTool(
    toolName,
    (params.input as Record<string, unknown>) ?? {},
    session.options.commandConfirmCallback,
    session.options.filePermissionCallback,
    buildTrustedSubagentToolContext(
      session,
      params.context as ToolExecutionContext | undefined,
    ),
  ));
  return prepareToolResultForSidecarWire(
    session.options.parentConversationId,
    result,
    session.options.signal,
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
  if (!session.options.onProgress) return;
  const event = scopeSubagentProgressEvent(params.runId, params.event);
  let hasOpaqueMediaRefs: boolean;
  try {
    hasOpaqueMediaRefs = sidecarValueHasOpaqueMediaRefs(event);
  } catch (err) {
    logger.warn('subagent progress rejected unsafe media payload', {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!hasOpaqueMediaRefs) {
    const safeEvent = redactSidecarValueForWireFailure(event) as SubagentProgressEvent;
    const publishSafeEvent = () => {
      if (!session.firstToolInvokeArrived) {
        session.bufferedProgress.push(safeEvent);
        return;
      }
      publishSessionProgress(session, safeEvent);
    };
    if (session.progressApplyBusy) {
      enqueueProgressApply(session, publishSafeEvent);
      return;
    }
    publishSafeEvent();
    return;
  }
  enqueueProgressApply(session, async () => {
    try {
      const parentConversationId = session.options.parentConversationId;
      if (!parentConversationId) {
        throw new Error('Missing parent conversation id for sidecar progress media');
      }
      const shellEvent = await materializeSidecarMediaRefsForShell(event, parentConversationId, session.options.signal);
      if (!session.firstToolInvokeArrived) {
        session.bufferedProgress.push(shellEvent);
        return;
      }
      publishSessionProgress(session, shellEvent);
    } catch (err) {
      logger.warn('subagent progress media materialization failed', {
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
      const safeEvent = failClosedProgressDisplayEvent(event);
      if (!session.firstToolInvokeArrived) {
        session.bufferedProgress.push(safeEvent);
        return;
      }
      publishSessionProgress(session, safeEvent);
    }
  });
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
    has: (runId) => sessions.has(runId),
    getAbortSignal: (runId) => sessions.get(runId)?.options.signal,
    getToolContext: (runId) => {
      const session = sessions.get(runId);
      if (!session) return undefined;
      return buildTrustedSubagentToolContext(session);
    },
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
function buildSubagentRunParams(
  runId: string,
  options: SubagentLoopOptions,
  availableTools: ToolDefinition[],
): SubagentRunParams {
  const settingsReader = options.settingsReader ?? getSettingsReader();
  const settingsSnapshot = settingsReader.getSnapshot();
  const tools = availableTools.map(toSerializableTool);

  const resolvedCreds = resolveEffectiveLlmCreds(
    getActiveApiKey(settingsSnapshot),
    getActiveProvider(settingsSnapshot)?.baseUrl || undefined,
  );

  const workspacePathSnapshot = options.imContext?.workspacePath
    ?? (options.workspaceReader
      ? options.workspaceReader.getCurrentPath()
      : (options.authorizationScopeId !== undefined ? null : getWorkspaceReader().getCurrentPath()));

  return {
    runId,
    agent: options.agent,
    task: options.task,
    context: options.context,
    parentConversationSummary: options.parentConversationSummary,
    delegatedUserTurn: options.delegatedUserTurn,
    delegatedMediaFallback: options.delegatedMediaFallback,
    parentConversationId: options.parentConversationId,
    parentLoopId: options.parentLoopId,
    parentUserMessageId: options.parentUserMessageId,
    persistParentToolImages: options.persistParentToolImages,
    imContext: options.imContext,
    allowedTools: options.allowedTools,
    blockedTools: options.blockedTools,
    authorizationScopeId: options.authorizationScopeId,
    runPermissionCeiling: options.runPermissionCeiling,
    triggerId: options.triggerId,
    scheduledTaskId: options.scheduledTaskId,
    locale: getLocale(),
    uiStrings: buildSubagentUiStrings(getI18n()),
    settingsSnapshot,
    resolvedCreds,
    tools,
    workspacePathSnapshot,
  } satisfies SubagentRunParams & Record<typeof SUBAGENT_RUN_WIRE_FIELDS[number], unknown>;
}

function reconstructSubagentResult(raw: unknown): SubagentResult {
  if (!isSerializableSubagentResult(raw)) {
    throw new Error('subagent.run response did not match the expected SubagentResult shape');
  }
  const looksLikeLegacyError = raw.stopReason === undefined && /^\s*Error\s*:/i.test(raw.text);
  const stopReason = raw.stopReason ?? (looksLikeLegacyError ? 'error' : 'completed');
  const text = stopReason === 'error'
    ? sanitizeUntrustedLlmErrorText(raw.text, `Error: ${getI18n().chat.errorEmptyBody}`)
    : raw.text;
  return new SubagentResult({
    ...raw,
    text,
    stopReason,
  });
}

function cancelledSubagentResult(): SubagentResult {
  return new SubagentResult({
    text: getI18n().chat.subagent.taskCancelled,
    toolCallCount: 0,
    turnCount: 0,
    tokenUsage: { input: 0, output: 0 },
    duration: 0,
    stopReason: 'aborted',
  });
}

// ── Public entry point ──────────────────────────────────────────────────

/**
 * Run a subagent — routes to the sidecar when it's `'running'`, else runs
 * `runSubagentLoop` in-process unchanged. See module doc for the wire
 * protocol and fallback discipline.
 */
export async function runSubagent(options: SubagentLoopOptions): Promise<SubagentResult> {
  const trustedOptions = withTrustedSkillCommandApproval(options);
  if (options.authorizationScopeId === undefined) {
    return runSubagentForSignal(trustedOptions);
  }

  // A successful background run_command deliberately keeps its abort listener
  // after the tool call resolves. Give every scoped subagent its own run-owned
  // signal and abort it after every terminal path, so a direct/nested subagent
  // cannot leave a process alive after the unattended authorization scope ends.
  const scopedController = new AbortController();
  const parentSignal = options.signal;
  const abortFromParent = () => scopedController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  try {
    return await runSubagentForSignal({ ...trustedOptions, signal: scopedController.signal });
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent);
    if (!scopedController.signal.aborted) {
      scopedController.abort(new Error('Scoped subagent run finished'));
    }
  }
}

/**
 * The in-process engine plus the same per-run resource release the sidecar path
 * gets at its settlement seal (A2). There is no `RunResourceSettlement` on this
 * path — nothing crosses a transport, so there is nothing to wait to settle —
 * but the run still owns browser tabs that only it can see, and the moment it
 * returns is the moment nothing can reach them again.
 */
async function runLocalSubagentLoop(options: SubagentLoopOptions): Promise<SubagentResult> {
  try {
    return await runSubagentLoop(options);
  } finally {
    disposeRunBrowserViews(options.parentConversationId, options.agentRunId);
    // Same seal, the other browser channel: the extension drives the user's
    // own Chrome, so this run's claim on a real page has to end here too.
    releaseRunBrowserTabClaims(options.parentConversationId, options.agentRunId);
  }
}

async function runSubagentForSignal(options: SubagentLoopOptions): Promise<SubagentResult> {
  if (options.signal?.aborted) {
    return cancelledSubagentResult();
  }

  // Run this before selecting or dispatching to either runtime. The loop has
  // the same check as a defense for direct callers and the in-sidecar nested
  // path; doing it here additionally guarantees a missing MCP dependency does
  // not create a sidecar session/request at all.
  const availableTools = (options.toolInvoker ?? getToolInvoker()).getAllTools();
  const mcpPreflightFailure = buildSubagentMcpPreflightFailure(options.agent, availableTools);
  if (mcpPreflightFailure) return mcpPreflightFailure;

  // Generate an app-owned scope for EVERY runtime path. Provider tool-call ids
  // are only run-local; exposing them raw to the parent causes cross-agent
  // collisions in child-step replay and hidden image persistence.
  const runId = createSubagentProgressScopeId();
  const localOptions = scopeSubagentLoopProgress(options, runId);

  if (getSidecarStatus() !== 'running') {
    logger.debug('subagent path selected', { path: 'local', runId, sidecarStatus: getSidecarStatus() });
    return runLocalSubagentLoop(localOptions);
  }

  ensureHandlersRegistered();

  logger.debug('subagent path selected', { path: 'sidecar', runId, agent: options.agent?.name });

  let params: SubagentRunParams;
  try {
    params = buildSubagentRunParams(runId, options, availableTools);
  } catch (err) {
    // Failed before any dispatch — no tool has executed. Fall back to the
    // in-process engine, which hits the identical real error path (e.g.
    // EnterpriseLlmUnavailableError) itself. See buildSubagentRunParams's doc.
    logger.warn('subagent params build failed — running in-process', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return runLocalSubagentLoop(localOptions);
  }

  const sessionOptions: SubagentLoopOptions = {
    ...options,
    workspaceReader: { getCurrentPath: () => params.workspacePathSnapshot },
  };
  const session: RunSession = {
    runId,
    options: sessionOptions,
    imReplyTarget: options.imContext?.replyChatId
      ? { platform: options.imContext.platform, chatId: options.imContext.replyChatId }
      : undefined,
    offeredToolNames: new Set(
      resolveSubagentToolRoster(
        availableTools,
        options.agent,
        options.allowedTools,
        options.blockedTools,
      ).map((tool) => tool.name),
    ),
    firstToolInvokeArrived: false,
    bufferedProgress: [],
    progressApplyTail: Promise.resolve(),
    progressApplyBusy: false,
    resourceSettlement: createRunResourceSettlement(
      sessionOptions.signal,
      () => { session.firstToolInvokeArrived = true; },
    ),
  };
  sessions.set(runId, session);
  registerRunResourceSettlement(runId, session.resourceSettlement);

  const signal = options.signal;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectOnGrace: ((err: Error) => void) | undefined;
  const gracePromise = new Promise<never>((_, reject) => {
    rejectOnGrace = reject;
  });
  gracePromise.catch(() => {});

  const onAbort = (): void => {
    notifySidecar('subagent.abort', { runId });
    if (options.authorizationScopeId === undefined) {
      graceTimer = setTimeout(() => {
        rejectOnGrace?.(new Error('Subagent abort grace period exceeded'));
      }, ABORT_GRACE_MS);
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // timeoutMs: 0 — a subagent run is unbounded (same discipline as llm.chat
  // / SidecarLLMAdapter.chat()); hang protection is the abort-grace timer
  // above, armed only once an abort actually happens.
  const requestPromise = sidecarRequest('subagent.run', params, 0);
  requestPromise.catch(() => {}); // avoid an unhandled rejection if the grace timer wins the race below

  try {
    const raw = signal && options.authorizationScopeId === undefined
      ? await Promise.race([requestPromise, gracePromise])
      : await requestPromise;
    const result = reconstructSubagentResult(raw);
    await session.progressApplyTail;
    // A direct-answer run never sends tool.invoke. Its ordered progress frames
    // become durable only after the final response itself validates.
    flushBufferedProgress(session);
    return result;
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
      // A fresh scope id on purpose (the sidecar attempt may already have
      // emitted progress under `runId`); the rerun therefore owns — and
      // releases — its own browser tabs.
      return runLocalSubagentLoop(scopeSubagentLoopProgress(options));
    }
    logger.warn('subagent transport failed after tool execution — surfacing error, no rerun', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    // At least one tool already ran with (possibly real) side effects —
    // surface as a failed result, matching the shape runSubagentLoop's own
    // outer catch produces today. NO rerun.
    const message = sanitizeUntrustedLlmErrorText(
      err instanceof Error ? err.message : String(err),
      getI18n().chat.errorEmptyBody,
    );
    return new SubagentResult({
      text: `Error: ${message}`,
      toolCallCount: 0,
      turnCount: 0,
      tokenUsage: { input: 0, output: 0 },
      duration: 0,
      stopReason: 'error',
    });
  } finally {
    await session.progressApplyTail;
    session.resourceSettlement.seal();
    // A2 — the seal is the point after which this run can no longer start
    // another tool, so it is the point at which its per-run resources are
    // nobody's any more. Its browser tabs are invisible to every other run, so
    // nothing else could ever list or close them.
    disposeRunBrowserViews(options.parentConversationId, runId);
    releaseRunBrowserTabClaims(options.parentConversationId, runId);
    if (options.authorizationScopeId !== undefined) {
      await session.resourceSettlement.settlement;
    }
    sessions.delete(runId);
    unregisterRunResourceSettlement(runId, session.resourceSettlement);
    if (graceTimer) clearTimeout(graceTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}
