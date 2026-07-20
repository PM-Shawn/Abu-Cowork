/**
 * Shell-side channel handler module for the main agent loop's sidecar run —
 * the main-loop twin of `subagentRunner.ts` (P1-3a). Built up in two
 * batches: P1-3b-2 (design doc §5 "3b-2 信道件") landed the channel
 * plumbing — run-session registry, reverse-channel handlers, shell→sidecar
 * push emitters, and the shell-side LoopContext/EventRouter construction
 * seam, all dormant until wired to a dispatch path. P1-3B-3B (this batch,
 * design doc §5 "3b-3B") adds the LIVE dispatch entrypoint
 * (`runAgentLoopDispatched`, a drop-in `runAgentLoop` replacement — see its
 * own doc for the concurrency-guard/fallback discipline), `buildAgentRunParams`,
 * the main-loop `tool.invoke` handler (routed through `toolInvokeRouter.ts`
 * to avoid colliding with subagentRunner.ts's own `tool.invoke` handler),
 * the `state.execPatch`/`skillHooks.clearAll` emitters/handlers that close
 * two P1-3B-3A escalations, and the 9-call-site caller switch. Every export
 * here is now LIVE once the sidecar is `'running'`.
 *
 * See docs/2026-07-20-phase1-p3b-loop-entry-design.md §4 for the wire
 * protocol this implements (the sidecar→shell half — `agent.delta` /
 * `approval.drain` / `plan.clear` / `caps.record` / `shell.notifyTask` /
 * `cu.setState` / `native.invoke` / `tool.list` / `tool.invoke` /
 * `session.isMessageWrittenToDisk` / `skillHooks.clearAll`) and the
 * shell→sidecar push half (`agent.run` / `agent.abort` / `agent.enqueueInput`
 * / `state.settings` / `state.convPatch` / `state.execPatch` /
 * `state.planMode`).
 */
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import type { ImageAttachment, ToolExecutionContext, Conversation } from '../../types';
import {
  onSidecarNotification,
  onSidecarRequest,
  notifySidecar,
  getSidecarStatus,
  request as sidecarRequest,
  SidecarRequestError,
} from '../sidecar/sidecarManager';
import { applyDeltaFrames, type PortFrame } from './frameApplier';
import { getExecutionPort } from './ports/executionPort';
import { getChatDelta } from './ports/chatDelta';
import { getConversationReader } from './ports/conversationReader';
import { getScratchpadPort } from './ports/scratchpadPort';
import { getCapsPort } from './ports/capsPort';
import { getAbortRegistry } from './ports/abortRegistry';
import { getToolInvoker } from './ports/toolInvoker';
import { getSettingsReader } from './ports/settingsReader';
import { toSerializableTool } from './subagentRunner';
import { registerToolInvokeSource, ensureToolInvokeRouterRegistered } from './toolInvokeRouter';
import { ensureHookBridgeRegistered } from './hookBridge';
import { createEventRouter, type EventRouter } from './eventRouter';
import {
  requestCommandConfirmation,
  requestFilePermission,
  setLoopContext,
  clearLoopContext,
  drainConfirmationQueue,
  drainFilePermissionQueue,
  drainWorkspaceRequest,
  drainUserQuestions,
} from './permissionBridge';
import { clearPlanMode, onPlanModeChange, getPlanMode } from './planMode';
import {
  setComputerUseActive,
  setCurrentAction,
  incrementComputerUseStep,
  pauseComputerUseStatus,
  setSessionWindowHidden,
} from './computerUseStatus';
import { setComputerUseBatchMode, setSkipAutoScreenshot, clearAllSkillHooks } from '../tools/builtins';
import { notifyTaskCompleted, notifyTaskError } from '../../utils/notifications';
import { useSettingsStore, type SettingsState } from '../../stores/settingsStore';
import { useChatStore } from '../../stores/chatStore';
import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import type { PlannedStep } from '../../types/execution';
import { getLocale } from '../../i18n';
import { createLogger } from '../logging/logger';
import {
  runAgentLoop,
  isInteractiveDesktop,
  type AgentLoopOptions,
  type AgentLoopResult,
} from './agentLoop';
import { precomputeOrchestration } from './entryOrchestration';
import type { RouteResult, IMContext } from './orchestrator';
import type { PromptSection } from '../llm/promptSections';
import type { ConversationMeta } from '../session/conversationStorage';
import { resolveEntryModel } from './resolveEntryModel';
import { getActiveApiKey, getActiveProvider } from '../../utils/settingsSelectors';
import { resolveEffectiveLlmCreds } from '../enterprise/llm-resolver';
import { enqueueUserInput, getQueuedInputs, subscribeToInputQueue, removeQueuedInput } from './userInputQueue';
import { registerSidecarRunPredicate } from './sidecarRunPredicate';

const logger = createLogger('agent-loop-runner');

// ── Run-session registry ────────────────────────────────────────────────
//
// Callbacks and the AbortSignal stay HERE (never serialized) — same
// discipline as subagentRunner.ts's RunSession. `options` is a placeholder
// shape this batch (just the two approval callbacks the shell-side
// LoopContext needs) — 3b-3 will extend it with the full agent.run
// params/callback set once dispatch exists; this batch's channel plumbing
// only needs these two.

export interface AgentLoopRunOptions {
  requestCommandConfirmation?: (info: ConfirmationInfo, loopId?: string) => Promise<boolean>;
  requestFilePermission?: FilePermissionCallback;
}

export interface RunSession {
  conversationId: string;
  loopId: string;
  options: AgentLoopRunOptions;
  shellAbortController: AbortController;
  /** Live map the tool.invoke handler will append to in 3b-3 (stored on the session now, per the design doc's LoopContext-lite wiring). */
  toolCallToStepId: Map<string, string>;
  /** Lazily constructed by createShellEventRouterForRun/installShellLoopContext — cached so a run's EventRouter identity is stable across calls. */
  eventRouter?: EventRouter;
  /**
   * Populated by `registerRunSession` (the map key, mirrored onto the
   * session object itself) — P1-3B-3B's concurrency guard and dispatch
   * fallback discipline need to go from "a session for conversationId X" to
   * "its runId" without a second registry. Optional so pre-3B-3B test
   * fixtures that build a `RunSession` literal without this field keep
   * compiling — `registerRunSession` always sets it regardless of what the
   * caller passed.
   */
  runId?: string;
  /**
   * Flips `true` the instant EITHER the first `tool.invoke` for this run
   * arrives OR the first `agent.delta` frame is applied — P1-3B-3B's
   * fallback discipline (mirrors subagentRunner.ts's
   * `firstToolInvokeArrived`, widened to cover the delta-frame trigger too,
   * since a main-loop run can stream text/thinking frames well before its
   * first tool call — those are ALSO observable side effects already
   * committed to the shell's real stores, so a transport failure after
   * either must surface as an error, never re-run).
   */
  committed?: boolean;
  /** Populated once at run start by `installShellLoopContext` — the exact
   *  same `shellAbortController` also registered into the real
   *  `AbortRegistry` for this conversationId (§ concurrency-guard/abort
   *  wiring in `runAgentLoopDispatched`), so removing this listener on
   *  settle avoids leaking a dangling `abort` handler. */
  onShellAbort?: () => void;
  /**
   * P1-3B-4 — ids of shell `userInputQueue` entries already forwarded to
   * this run's sidecar-side queue (via `agent.enqueueInput`), so
   * `forwardQueuedInputsForActiveSessions` (below) forwards each entry
   * EXACTLY ONCE per run — otherwise every `subscribeToInputQueue` change
   * notification would re-scan the whole (unmutated, still-lingering-for-
   * the-chip) shell queue and re-send entries already in flight/consumed.
   * Pre-seeded by `runAgentLoopDispatched` with the ids from
   * `buildAgentRunParams`'s `queuedInputs` snapshot (those were already
   * seeded into the sidecar's OWN queue at dispatch time — see
   * `agentLoopHost.ts`'s `handleAgentRun` — so the live forwarder must not
   * re-send them). Lazily initialized (`??=`) by the forwarder/consumed
   * handler for sessions built via `makeSession`-style test fixtures that
   * don't set it upfront.
   */
  forwardedQueueIds?: Set<string>;
}

const sessions = new Map<string, RunSession>();

/** Register a run session — exported for 3b-3 (the `agent.run` dispatch path) and this batch's own tests. Idempotent overwrite (a second register for the same runId replaces the first). Installs the push emitters on the FIRST registration. */
export function registerRunSession(runId: string, session: RunSession): void {
  session.runId = runId;
  sessions.set(runId, session);
  installPushEmitters();
}

/** The live session for a conversationId, or undefined — P1-3B-3B's concurrency guard (`runAgentLoopDispatched`) and the `state.execPatch` emitter both need this conversationId→runId lookup. Linear scan — the sessions map is bounded by concurrently-running conversations (small in practice, same discipline as `pushConvPatchesForActiveSessions` below). */
export function findRunSessionForConversation(conversationId: string): RunSession | undefined {
  for (const session of sessions.values()) {
    if (session.conversationId === conversationId) return session;
  }
  return undefined;
}

/**
 * Cheap, synchronous predicate — true iff `conversationId` has an active
 * sidecar-hosted `RunSession` registered right now. P1-3c-1 (design doc §3):
 * `chatStore.ts`'s `cancelStreaming` uses this (via `sidecarRunPredicate.ts`'s
 * cycle-breaking indirection — chatStore.ts can't import THIS module
 * directly, see that file's doc) to decide whether it owns the "stopped"
 * decoration itself or defers to the sidecar's own `cancelStreaming` frame.
 * An in-process run never registers a `RunSession` here (see
 * `findRunSessionForConversation`'s doc), so this is always `false` while no
 * sidecar run is live for the conversation.
 */
export function isConversationRunningInSidecar(conversationId: string): boolean {
  return findRunSessionForConversation(conversationId) !== undefined;
}

// Self-register into the cycle-breaking slot at module load — see
// sidecarRunPredicate.ts's doc for why chatStore.ts reads through that file
// instead of importing this one.
registerSidecarRunPredicate(isConversationRunningInSidecar);

/** Unregister a run session. Uninstalls the push emitters once the LAST session is gone. */
export function unregisterRunSession(runId: string): void {
  sessions.delete(runId);
  if (sessions.size === 0) uninstallPushEmitters();
}

export function getRunSession(runId: string): RunSession | undefined {
  return sessions.get(runId);
}

/** Test-only accessor (mirrors subagentHost.ts's `__getActiveSubagentRunCount`). */
export function __getActiveRunSessionCount(): number {
  return sessions.size;
}

/** Test-only reset — clears the registry and uninstalls emitters without going through unregisterRunSession's one-at-a-time bookkeeping. */
export function __resetAgentLoopRunnerForTests(): void {
  sessions.clear();
  uninstallPushEmitters();
}

// ── Reverse-channel handlers (registered ONCE at module init) ──────────

/** `agent.delta` (NOTIFICATION) → {runId, frames} → applyDeltaFrames. Unknown runId → silent drop (3a discipline, matches handleSubagentAbort's unknown-runId no-op). */
function handleAgentDelta(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; frames?: unknown } | null;
  if (!params || typeof params.runId !== 'string' || !Array.isArray(params.frames)) return;
  const session = sessions.get(params.runId);
  if (!session) return; // unknown/already-finished runId — silent drop
  // P1-3B-3B fallback discipline: the first frame observed for this run is
  // an already-committed, observable side effect (text/thinking streamed to
  // the real chatStore) — see RunSession.committed's doc.
  if (params.frames.length > 0) session.committed = true;
  void applyDeltaFrames(params.frames as PortFrame[]).catch((err: unknown) => {
    logger.warn('applyDeltaFrames threw', { runId: params.runId, error: err instanceof Error ? err.message : String(err) });
  });
}

/** The four permissionBridge drain functions, addressable by `approval.drain`'s `kind`. The queues themselves are global (not per-run/per-loop — see permissionBridge.ts), so `runId` in the params is informational only; the drain always executes for the named kind(s) regardless of whether that runId is still a known session. */
const DRAIN_BY_KIND: Record<'command' | 'file-permission' | 'workspace' | 'user-question', () => void> = {
  command: drainConfirmationQueue,
  'file-permission': drainFilePermissionQueue,
  workspace: drainWorkspaceRequest,
  'user-question': drainUserQuestions,
};

/** `approval.drain` (NOTIFICATION) → {runId, kind} → the corresponding permissionBridge drain function(s). `kind: 'all'` drains every queue (used on abort, matching the shell's own today-discipline of clearing every pending dialog). Unknown kind → warn + drop. */
function handleApprovalDrain(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; kind?: unknown } | null;
  if (!params || typeof params.kind !== 'string') return;
  if (params.kind === 'all') {
    for (const drain of Object.values(DRAIN_BY_KIND)) drain();
    return;
  }
  const drain = DRAIN_BY_KIND[params.kind as keyof typeof DRAIN_BY_KIND];
  if (!drain) {
    logger.warn('approval.drain: unknown kind, dropping', { kind: params.kind });
    return;
  }
  drain();
}

/**
 * `plan.clear` (NOTIFICATION) → {runId, conversationId} → clearPlanMode(conversationId).
 *
 * `clearPlanMode` fires `onPlanModeChange` synchronously — in 3b-3, that
 * subscriber pushes `state.planMode` BACK to the sidecar (see
 * `installPushEmitters` below). That echo is harmless: the sidecar's own
 * plan-mode mirror application is idempotent (setting an already-cleared
 * conversation to cleared again is a no-op), so this handler does NOT
 * special-case the echo — documented here rather than added as bookkeeping
 * that would only exist to suppress a harmless round trip.
 */
function handlePlanClear(rawParams: unknown): void {
  const params = rawParams as { conversationId?: unknown } | null;
  if (!params || typeof params.conversationId !== 'string') return;
  clearPlanMode(params.conversationId);
}

/** The three CapsPort record* methods, addressable by `caps.record`'s `field`. */
const CAPS_RECORD_BY_FIELD: Record<string, (providerId: string, modelId: string, value: unknown) => void> = {
  maxOutputTokens: (providerId, modelId, value) => getCapsPort().recordMaxOutputTokens(providerId, modelId, value as number),
  contextWindow: (providerId, modelId, value) => getCapsPort().recordContextWindow(providerId, modelId, value as number),
  reasoningObserved: (providerId, modelId) => getCapsPort().recordReasoningObserved(providerId, modelId),
};

/** `caps.record` (NOTIFICATION) → {providerId, modelId, field, value} → getCapsPort().record*. Unknown field → warn + drop. */
function handleCapsRecord(rawParams: unknown): void {
  const params = rawParams as { providerId?: unknown; modelId?: unknown; field?: unknown; value?: unknown } | null;
  if (!params || typeof params.providerId !== 'string' || typeof params.modelId !== 'string' || typeof params.field !== 'string') return;
  const record = CAPS_RECORD_BY_FIELD[params.field];
  if (!record) {
    logger.warn('caps.record: unknown field, dropping', { field: params.field });
    return;
  }
  record(params.providerId, params.modelId, params.value);
}

/** `shell.notifyTask` (NOTIFICATION) → {kind, title, conversationId} → notifyTaskCompleted/notifyTaskError. Unknown kind → warn + drop. */
function handleShellNotifyTask(rawParams: unknown): void {
  const params = rawParams as { kind?: unknown; title?: unknown; conversationId?: unknown } | null;
  if (!params || typeof params.title !== 'string') return;
  const conversationId = typeof params.conversationId === 'string' ? params.conversationId : undefined;
  if (params.kind === 'completed') {
    void notifyTaskCompleted(params.title, conversationId);
  } else if (params.kind === 'error') {
    void notifyTaskError(params.title, conversationId);
  } else {
    logger.warn('shell.notifyTask: unknown kind, dropping', { kind: params.kind });
  }
}

/** The 7 computerUseStatus/builtins actions `cu.setState` may address — explicit allowlist so a malformed/hostile frame can't call arbitrary functions. `isSessionWindowHidden` (a READ) is deliberately NOT here — see P1-3B-2-REPORT.md's escalation on this. */
const CU_SET_STATE_ACTIONS: Record<string, (...args: unknown[]) => void> = {
  setComputerUseBatchMode: (...args) => setComputerUseBatchMode(args[0] as boolean),
  setSkipAutoScreenshot: (...args) => setSkipAutoScreenshot(args[0] as boolean),
  setComputerUseActive: (...args) => setComputerUseActive(args[0] as boolean, args[1] as string | undefined),
  setCurrentAction: (...args) => setCurrentAction(args[0] as string | null),
  incrementComputerUseStep: (...args) => incrementComputerUseStep(args[0] as string | undefined),
  pauseComputerUseStatus: () => pauseComputerUseStatus(),
  setSessionWindowHidden: (...args) => setSessionWindowHidden(args[0] as boolean),
};

/** `cu.setState` (NOTIFICATION) → {action, args} → the allowlisted computer-use status setter. Unknown action → warn + drop (fail-closed, matches native.invoke's discipline). */
function handleCuSetState(rawParams: unknown): void {
  const params = rawParams as { action?: unknown; args?: unknown } | null;
  if (!params || typeof params.action !== 'string') return;
  const fn = CU_SET_STATE_ACTIONS[params.action];
  if (!fn) {
    logger.warn('cu.setState: unknown action, dropping', { action: params.action });
    return;
  }
  fn(...((Array.isArray(params.args) ? params.args : []) as unknown[]));
}

/**
 * `native.invoke` (REQUEST) → {cmd, args} → the real Tauri `invoke(cmd, args)`, ALLOWLISTED.
 *
 * Allowlist = the 4 Computer Use window-orchestration commands
 * (`toolExecutor.ts:300/304/310/316`) + `run_shell_command`
 * (`src/core/skill/preprocessor.ts`'s inline-command execution — the ONE
 * `invoke` call that file makes, verified by reading it; see
 * P1-3B-2-REPORT.md's inventory) + `atomic_write_text` (P1-3d-2 — `utils/
 * atomicFs.ts`'s `atomicWrite()`, the write primitive `memdir/write.ts`
 * uses for every memory file/index write, reached once `memdirExtractorRun.ts`
 * stopped stubbing out `extractor.ts`; routes through this SAME
 * `@tauri-apps/api/core` `invoke` bare-specifier shim as the other 5 commands
 * — reusing the shell's real Rust `atomic_write_text` command, rather than
 * reimplementing tempfile+fsync+rename in Node, keeps atomicity semantics
 * identical regardless of which process performs the write). Not listed →
 * fail-closed `SidecarRequestError`, never silently forwarded.
 */
const NATIVE_INVOKE_ALLOWLIST: ReadonlySet<string> = new Set([
  'show_screen_border',
  'get_active_window',
  'window_hide',
  'activate_app',
  'run_shell_command',
  'atomic_write_text',
]);

async function handleNativeInvoke(rawParams: unknown): Promise<unknown> {
  const params = rawParams as { cmd?: unknown; args?: unknown } | null;
  if (!params || typeof params.cmd !== 'string') {
    throw new SidecarRequestError(-32602, 'Invalid native.invoke params: cmd must be a string');
  }
  if (!NATIVE_INVOKE_ALLOWLIST.has(params.cmd)) {
    throw new SidecarRequestError(-32601, `native.invoke: "${params.cmd}" is not allowlisted`);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(params.cmd, params.args as Record<string, unknown> | undefined);
}

/** `tool.list` (REQUEST) → the same wire-safe tool projection P1-3a's subagent.run params use, reused via subagentRunner.ts's exported `toSerializableTool`. Unlike 3a's static per-run snapshot, this is a LIVE request — the design doc's §1 finding 7 (mcpChanged mid-loop tool-table refresh) means the sidecar must re-request rather than cache. */
async function handleToolList(): Promise<unknown> {
  return getToolInvoker().getAllTools().map(toSerializableTool);
}

/** `session.isMessageWrittenToDisk` (REQUEST) → {conversationId, messageId} → conversationStorage.isMessageWrittenToDisk(messageId), dynamically imported (same discipline as agentLoop.ts's own call site — avoid a static Tauri-fs dependency on any path that never needs it). */
async function handleIsMessageWrittenToDisk(rawParams: unknown): Promise<unknown> {
  const params = rawParams as { conversationId?: unknown; messageId?: unknown } | null;
  if (!params || typeof params.messageId !== 'string') {
    throw new SidecarRequestError(-32602, 'Invalid session.isMessageWrittenToDisk params: messageId must be a string');
  }
  const { isMessageWrittenToDisk } = await import('../session/conversationStorage');
  return isMessageWrittenToDisk(params.messageId);
}

/**
 * `tool.invoke` (REQUEST) for a MAIN-LOOP run — the main-loop twin of
 * subagentRunner.ts's `handleToolInvoke`. Registered as a named source with
 * `toolInvokeRouter.ts`'s shared registrar (NEVER directly via
 * `onSidecarRequest` — `onSidecarRequest` allows exactly one handler per
 * method, and subagentRunner.ts also needs `tool.invoke` for SUBAGENT runs;
 * see toolInvokeRouter.ts's doc for the full "why" and the collision this
 * avoids). Executes via the REAL in-process `ToolInvoker` (registry.ts,
 * unmoved — pathSafety/permissions/approvals all run here exactly as they
 * do for an in-process main-loop run), threading the session's confirm/
 * file-permission callbacks (same default-fallback resolution
 * `installShellLoopContext` uses, kept in sync deliberately).
 *
 * `toolCallToStepId` is deliberately NOT populated from the wire here — the
 * sidecar's `tool.invoke` request carries no explicit toolCallId→stepId
 * mapping (traced: the `addStep` frame carries the step's own id but not
 * the originating toolCallId; `context.toolCallId` travels but has no
 * matching stepId to pair it with). The primary consumer
 * (`delegate_to_agent`, agentTools.ts) already has a fallback for exactly
 * this case — `eventRouter.getCurrentStepId(loopId)`, which reads the REAL
 * shell-side ExecutionPort. By the time this handler runs, the current
 * tool's `addStep` frame has ALREADY been applied (frames flush-before-
 * request — design doc §3's chatDelta/executionPort row), so the fallback
 * resolves correctly without an explicit wire field. See
 * P1-3B-3B-REPORT.md's "toolCallToStepId threading" section for the full
 * trace.
 *
 * P1-3c-2 (design doc §3 change 3 / P1-3C-SCOUT-REPORT.md §5 "secondary
 * finding"): also refuses to execute when the run's `conversationId` no
 * longer has a record in `useChatStore` — i.e. the user deleted the
 * conversation. `deleteConversation` (chatStore.ts) aborts the shared
 * controller BEFORE erasing the record, but that abort is a fire-and-forget
 * cross-process notification (`agent.abort`) — there's a real window where
 * the sidecar dispatches (or already dispatched) another `tool.invoke` for
 * a conversation the shell has since deleted, before the abort lands there.
 * This is the shell-side backstop for that window: even if a real-effect
 * tool call (e.g. `write_file`) arrives after deletion, it's refused here
 * rather than executed against a conversation nobody can see anymore.
 */
async function handleMainLoopToolInvoke(rawParams: unknown): Promise<unknown> {
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
    throw new SidecarRequestError(-32000, `Unknown agent-loop runId: ${params.runId}`);
  }
  if (!useChatStore.getState().conversations[session.conversationId]) {
    throw new SidecarRequestError(-32000, `Conversation no longer exists for agent-loop runId: ${params.runId}`);
  }
  // P1-3B-3B fallback discipline — see RunSession.committed's doc.
  session.committed = true;

  const invoker = getToolInvoker(); // shell-side in-process default — registry-backed, same as any in-process main-loop run.
  return await invoker.executeAnyTool(
    params.toolName,
    (params.input as Record<string, unknown>) ?? {},
    session.options.requestCommandConfirmation ?? requestCommandConfirmation,
    session.options.requestFilePermission ?? requestFilePermission,
    params.context as ToolExecutionContext | undefined,
  );
}

/**
 * `skillHooks.clearAll` (NOTIFICATION) → {runId} → the real
 * `clearAllSkillHooks()`. Closes a P1-3B-3A escalation
 * (`sidecar/src/shims/builtinsRun.ts`'s doc comment / P1-3B-3A-REPORT.md
 * escalation #4): `builtinsRun.ts` already sends this notification on every
 * sidecar-run loop end, but no shell-side handler existed to receive it —
 * skill-scoped PreToolUse/PostToolUse hooks activated during a sidecar-run
 * main loop (via `use_skill`, which — like every tool — always executes
 * shell-side) leaked across turns until this. `runId` is informational only
 * (`skillHookCleanups` is a single GLOBAL map, not per-run — same
 * discipline as `plan.clear`/`approval.drain`).
 */
function handleSkillHooksClearAll(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown } | null;
  if (!params || typeof params.runId !== 'string') return;
  clearAllSkillHooks();
}

/**
 * `input.consumed` (NOTIFICATION) → {runId, queueIds} — P1-3B-4: the
 * sidecar's `userInputQueue` shim sends this after `agentLoop.ts` drains or
 * clears queued inputs for a sidecar-run loop, naming exactly the ids it
 * consumed. Removes the SAME ids from the shell's `userInputQueue` — this
 * is what actually clears the `QueuedMessagesStrip` chip (which reads the
 * shell queue via `subscribeToInputQueue`/`getQueuedInputs`, unchanged) at
 * the moment of consumption, not before. Also drops each id from the
 * session's `forwardedQueueIds` (housekeeping — a finished/re-forwarded id
 * has nothing left to dedup against). Unknown runId → silent drop (3a
 * discipline, matches every other reverse-channel handler in this module).
 */
function handleInputConsumed(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; queueIds?: unknown } | null;
  if (!params || typeof params.runId !== 'string' || !Array.isArray(params.queueIds)) return;
  const session = sessions.get(params.runId);
  if (!session) return; // unknown/already-finished runId — silent drop
  for (const id of params.queueIds) {
    if (typeof id !== 'string') continue;
    removeQueuedInput(session.conversationId, id);
    session.forwardedQueueIds?.delete(id);
  }
}

let handlersRegistered = false;

/** Idempotent — registers every reverse-channel handler exactly once, no matter how many times it's called. Mirrors subagentRunner.ts's ensureHandlersRegistered() shape. */
export function ensureHandlersRegistered(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  registerToolInvokeSource('agentLoop', { has: (runId) => sessions.has(runId), handle: handleMainLoopToolInvoke });
  ensureToolInvokeRouterRegistered();
  // hook.emit / hook.notify — shared with the subagent path via the neutral
  // hookBridge (see hookBridge.ts's doc). Without this, a session that runs
  // ONLY a main loop (no subagent) had no hook.emit handler at all, so the
  // first tool call's preToolCall hook failed with "-32601 Method not found:
  // hook.emit" (the bug the real-machine smoke surfaced).
  ensureHookBridgeRegistered();

  onSidecarNotification('agent.delta', handleAgentDelta);
  onSidecarNotification('approval.drain', handleApprovalDrain);
  onSidecarNotification('plan.clear', handlePlanClear);
  onSidecarNotification('caps.record', handleCapsRecord);
  onSidecarNotification('shell.notifyTask', handleShellNotifyTask);
  onSidecarNotification('cu.setState', handleCuSetState);
  onSidecarNotification('skillHooks.clearAll', handleSkillHooksClearAll);
  onSidecarNotification('input.consumed', handleInputConsumed);

  onSidecarRequest('native.invoke', handleNativeInvoke);
  onSidecarRequest('tool.list', handleToolList);
  onSidecarRequest('session.isMessageWrittenToDisk', handleIsMessageWrittenToDisk);
}

/** Test-only — lets tests re-register handlers against fresh mocks. Not used by production code. */
export function __resetHandlersRegisteredForTests(): void {
  handlersRegistered = false;
}

// ── Shell→sidecar push emitters ─────────────────────────────────────────
//
// Installed when the FIRST session registers, removed when the LAST one
// unregisters (registerRunSession/unregisterRunSession above). Uses
// sidecarManager's existing `notifySidecar()` — the same fire-and-forget
// mechanism subagentRunner.ts uses to send `subagent.abort`.

const SETTINGS_DEBOUNCE_MS = 50;

let settingsUnsub: (() => void) | undefined;
let settingsDebounceTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSettingsPush(): void {
  if (settingsDebounceTimer) clearTimeout(settingsDebounceTimer);
  settingsDebounceTimer = setTimeout(() => {
    settingsDebounceTimer = undefined;
    notifySidecar('state.settings', { settings: getSettingsReader().getSnapshot() });
  }, SETTINGS_DEBOUNCE_MS);
}

/** The 4 scalar fields diffed per-conversation for `state.convPatch` — see design doc §5's emitter bullet. */
interface ConvPatchSnapshot {
  workspacePath?: string | null;
  title?: string;
  activeSkills?: string[];
  model?: { providerId: string; modelId: string };
}

let chatUnsub: (() => void) | undefined;
/** Last-pushed snapshot per conversationId, so only CHANGED fields are ever pushed. */
const lastPushedConvSnapshot = new Map<string, ConvPatchSnapshot>();

function snapshotConv(conversationId: string): ConvPatchSnapshot | undefined {
  const state = useChatStore.getState();
  const conv = state.conversations[conversationId];
  if (!conv) return undefined;
  return {
    workspacePath: conv.workspacePath,
    title: conv.title,
    activeSkills: conv.activeSkills,
    model: state.conversationIndex[conversationId]?.model,
  };
}

function shallowArrayEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function diffConvSnapshot(prev: ConvPatchSnapshot | undefined, next: ConvPatchSnapshot): Partial<ConvPatchSnapshot> | undefined {
  const patch: Partial<ConvPatchSnapshot> = {};
  let changed = false;
  if (!prev || prev.workspacePath !== next.workspacePath) {
    patch.workspacePath = next.workspacePath;
    changed = true;
  }
  if (!prev || prev.title !== next.title) {
    patch.title = next.title;
    changed = true;
  }
  if (!prev || !shallowArrayEqual(prev.activeSkills, next.activeSkills)) {
    patch.activeSkills = next.activeSkills;
    changed = true;
  }
  if (!prev || prev.model?.providerId !== next.model?.providerId || prev.model?.modelId !== next.model?.modelId) {
    patch.model = next.model;
    changed = true;
  }
  return changed ? patch : undefined;
}

function pushConvPatchesForActiveSessions(): void {
  const seenConversationIds = new Set<string>();
  for (const session of sessions.values()) {
    if (seenConversationIds.has(session.conversationId)) continue;
    seenConversationIds.add(session.conversationId);

    const next = snapshotConv(session.conversationId);
    if (!next) continue;
    const prev = lastPushedConvSnapshot.get(session.conversationId);
    const patch = diffConvSnapshot(prev, next);
    if (!patch) continue;

    lastPushedConvSnapshot.set(session.conversationId, next);
    // P1-3B-3B bug fix: agentLoopHost.ts's handleStateConvPatch (P1-3B-3A)
    // keys its lookup by `runId` (`activeRuns.get(rawParams.runId)`), NOT
    // `conversationId` — this emitter (built P1-3b-2, before any dispatch
    // path existed to catch the mismatch in a real run) was sending
    // `{conversationId, patch}`, which `handleStateConvPatch`'s own
    // `typeof rawParams.runId !== 'string'` guard would silently drop on
    // EVERY push. `session.runId` (populated by registerRunSession) is the
    // correct key.
    notifySidecar('state.convPatch', { runId: session.runId, patch });
  }
}

let planModeUnsub: (() => void) | undefined;

/**
 * `state.execPatch` emitter — P1-3B-3A §6 / P1-3B-2-REPORT.md §2b's
 * escalation #1 (the sidecar's local execution mirror can never observe
 * `report_plan`'s `plannedSteps` write, since `memoryTools.ts` calls
 * `useTaskExecutionStore.getState().setPlannedSteps(exec.id, ...)` DIRECTLY
 * on the real store — bypassing `ExecutionPort`, hence bypassing every
 * frame — entirely shell-side). Watches `taskExecutionStore` for
 * `plannedSteps` changes on any ACTIVE session's conversation, diffed by
 * reference (the store replaces the array on write, never mutates it in
 * place — verified against `taskExecutionStore.ts`'s `setPlannedSteps`
 * action) so this only fires on an actual change, not every unrelated store
 * update. Keyed by `runId` (not `conversationId` alone) since the sidecar's
 * `activeRuns` map — `handleStateExecPatch`'s lookup target — is keyed by
 * `runId`.
 */
let execUnsub: (() => void) | undefined;
const lastPushedPlannedSteps = new Map<string, PlannedStep[]>();

function pushExecPatchesForActiveSessions(): void {
  const seenConversationIds = new Set<string>();
  for (const session of sessions.values()) {
    if (seenConversationIds.has(session.conversationId)) continue;
    seenConversationIds.add(session.conversationId);
    if (!session.runId) continue;

    const exec = useTaskExecutionStore.getState().getExecutionByConversationId(session.conversationId);
    if (!exec) continue;
    const plannedSteps = exec.plannedSteps;
    if (lastPushedPlannedSteps.get(session.conversationId) === plannedSteps) continue; // unchanged (reference-equal)

    lastPushedPlannedSteps.set(session.conversationId, plannedSteps);
    notifySidecar('state.execPatch', { runId: session.runId, plannedSteps });
  }
}

/**
 * Queued-input forwarder — P1-3B-4, closes the mid-task-queue sidecar gap
 * (see this module's header comment / P1-3B-4-QUEUEINPUT-FIX-REPORT.md).
 * The shell's `userInputQueue` stays the single UI source of truth (the
 * `QueuedMessagesStrip` chip) — this forwarder relays each NEW entry to the
 * matching active sidecar `RunSession`'s `userInputQueue` instance (via
 * `agent.enqueueInput`, id-preserved) so the loop actually sees it. Fires on
 * EVERY `userInputQueue` mutation, for EVERY active session, so it must
 * dedup per-session via `RunSession.forwardedQueueIds` — otherwise a second,
 * unrelated queue mutation (e.g. a different conversation's chip) would
 * re-scan this conversation's still-lingering (not-yet-consumed) entries and
 * re-send them.
 *
 * Deliberately does NOT touch the shell queue itself (no `removeQueuedInput`
 * here) — the chip must linger until the sidecar loop actually CONSUMES the
 * entry (`input.consumed`, handled by `handleInputConsumed` above), not the
 * instant it's forwarded. This is what gives sidecar runs the same "chip
 * lingers until consumed" behavior the in-process path already has (same
 * queue, same drain call, no separate forward step).
 *
 * In-process runs are unaffected: `findRunSessionForConversation`-style
 * iteration here only ever matches conversations with a registered sidecar
 * `RunSession` — an in-process run never registers one.
 */
function forwardQueuedInputsForActiveSessions(): void {
  const seenConversationIds = new Set<string>();
  for (const session of sessions.values()) {
    if (!session.runId) continue;
    if (seenConversationIds.has(session.conversationId)) continue;
    seenConversationIds.add(session.conversationId);

    const queued = getQueuedInputs(session.conversationId);
    if (queued.length === 0) continue;

    session.forwardedQueueIds ??= new Set();
    for (const qi of queued) {
      if (session.forwardedQueueIds.has(qi.id)) continue;
      session.forwardedQueueIds.add(qi.id);
      notifySidecar('agent.enqueueInput', {
        runId: session.runId,
        message: qi.text,
        queueId: qi.id,
        ...(qi.isSystem ? { isSystem: qi.isSystem } : {}),
      });
    }
  }
}

let queueForwardUnsub: (() => void) | undefined;

let emittersInstalled = false;

/** Exported for tests — install() is normally driven by registerRunSession(). */
export function installPushEmitters(): void {
  if (emittersInstalled) return;
  emittersInstalled = true;

  settingsUnsub = useSettingsStore.subscribe(() => {
    scheduleSettingsPush();
  });
  chatUnsub = useChatStore.subscribe(() => {
    pushConvPatchesForActiveSessions();
  });
  execUnsub = useTaskExecutionStore.subscribe(() => {
    pushExecPatchesForActiveSessions();
  });
  planModeUnsub = onPlanModeChange((conversationId, mode) => {
    notifySidecar('state.planMode', { conversationId, mode });
  });
  queueForwardUnsub = subscribeToInputQueue(() => {
    forwardQueuedInputsForActiveSessions();
  });
}

/** Exported for tests — uninstall() is normally driven by unregisterRunSession() once the last session is gone. */
export function uninstallPushEmitters(): void {
  emittersInstalled = false;
  settingsUnsub?.();
  settingsUnsub = undefined;
  if (settingsDebounceTimer) {
    clearTimeout(settingsDebounceTimer);
    settingsDebounceTimer = undefined;
  }
  chatUnsub?.();
  chatUnsub = undefined;
  lastPushedConvSnapshot.clear();
  execUnsub?.();
  execUnsub = undefined;
  lastPushedPlannedSteps.clear();
  planModeUnsub?.();
  planModeUnsub = undefined;
  queueForwardUnsub?.();
  queueForwardUnsub = undefined;
}

// ── Shell EventRouter / LoopContext-lite construction ───────────────────

/**
 * Construct a REAL EventRouter over in-process deps for the LoopContext the
 * shell must expose to tools (design doc §2 雷3). All three deps
 * (`ExecutionPort`, the `appendToolCallContext` callback, the
 * `addScratchpadEntry` callback) are shell-resolvable — verified by reading
 * `createEventRouter`'s `EventRouterDeps` and `agentLoop.ts`'s own in-
 * process call site (`agentLoop.ts:717`), which this mirrors exactly. Locale
 * comes from `getLocale()` (i18n's live resolved locale), same as
 * `agentLoop.ts`'s own construction.
 */
export function createShellEventRouterForRun(runId: string): EventRouter {
  const session = sessions.get(runId);
  if (!session) {
    throw new Error(`createShellEventRouterForRun: unknown runId "${runId}" — register the session first`);
  }
  return createEventRouter(
    {
      executionStore: getExecutionPort(),
      appendToolCallContext: (loopId, context) => {
        getChatDelta().appendToolCallContext(session.conversationId, loopId, context);
      },
      addScratchpadEntry: (entry) => {
        getScratchpadPort().addEntry(entry);
      },
    },
    getLocale(),
  );
}

/**
 * Install the shell-side LoopContext-lite for a run (design doc §2 雷3):
 * shell callbacks (session.options's confirm/file-permission callbacks, or
 * the real permissionBridge defaults), signal =
 * session.shellAbortController.signal, eventRouter = the shell EventRouter
 * (constructed via createShellEventRouterForRun, cached on the session),
 * toolCallToStepId = the session's live map (3b-3's tool.invoke handler
 * appends to it). Call at run start, mirroring agentLoop.ts's own
 * setLoopContext discipline.
 */
export function installShellLoopContext(runId: string, session: RunSession): void {
  const eventRouter = session.eventRouter ?? createShellEventRouterForRun(runId);
  session.eventRouter = eventRouter;

  setLoopContext(session.loopId, {
    commandConfirmCallback: session.options.requestCommandConfirmation ?? requestCommandConfirmation,
    filePermissionCallback: session.options.requestFilePermission ?? requestFilePermission,
    signal: session.shellAbortController.signal,
    eventRouter,
    loopId: session.loopId,
    conversationId: session.conversationId,
    toolCallToStepId: session.toolCallToStepId,
  });
}

/** Clear the shell-side LoopContext-lite for a run, at run settle (mirrors agentLoop.ts's own clearLoopContext discipline). Unknown runId → silent no-op. */
export function removeShellLoopContext(runId: string): void {
  const session = sessions.get(runId);
  if (!session) return;
  clearLoopContext(session.loopId);
}

// ── Dispatch entrypoint (P1-3B-3B) ───────────────────────────────────────

/**
 * Wire params for `agent.run` — mirrors `sidecar/src/agentLoopHost.ts`'s
 * `AgentRunParams` field-for-field. NEVER imported from there — `src/` must
 * never import from `sidecar/` (same discipline `frameApplier.ts`'s
 * independently-declared `PortFrame` type documents, P1-3b-2). Kept in sync
 * by hand; `handleAgentRun`'s own `parseAgentRunParams` validates the wire
 * shape defensively regardless of what this side sends.
 */
interface AgentRunParams {
  runId: string;
  conversationId: string;
  userMessage: string;
  options: { images?: ImageAttachment[]; blockedTools?: string[]; imContext?: IMContext };
  orchestration: { route: RouteResult; systemPromptSections: PromptSection[] };
  conversationSnapshot: Conversation;
  indexEntrySnapshot?: ConversationMeta;
  settingsSnapshot: SettingsState;
  capsSnapshot?: { providerId: string; modelId: string; maxOutputTokens?: number; contextWindow?: number; isReasoningModel?: boolean };
  resolvedCreds: { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean };
  toolList: ReturnType<typeof toSerializableTool>[];
  planMode?: 'off' | 'planning' | 'approved';
  locale: string;
  /**
   * P1-3B-4 — a snapshot of the shell's `userInputQueue` for this
   * conversation, taken at dispatch time (see `buildAgentRunParams` below).
   * `agentLoopHost.ts`'s `handleAgentRun` seeds its own (real, but
   * previously-disconnected) `userInputQueue` instance from this,
   * id-preserved, so a message already staged in the shell queue BEFORE
   * this run was dispatched is picked up by `agentLoop.ts`'s turn-1
   * `drainQueuedInputs` — the "leftover flushes on the next run" parity the
   * in-process path already has.
   */
  queuedInputs?: { id: string; text: string; isSystem?: boolean }[];
}

/** Defensive validation of the `agent.run` response before trusting it as an `AgentLoopResult` — same discipline as subagentRunner.ts's `isSerializableSubagentResult`. A malformed response is treated identically to any other transport failure by the caller (same committed-flag fallback decision). */
function isAgentLoopResult(v: unknown): v is AgentLoopResult {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).reason === 'string';
}

let runIdCounter = 0;
function generateRunId(): string {
  runIdCounter += 1;
  return `agl-${Date.now().toString(36)}-${runIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Replicates `runAgentLoop`'s own entry-sequence `settings`/
 * `settingsForModel` derivation EXACTLY (agentLoop.ts: `settings =
 * settingsReader.getSnapshot()`; `settingsForModel` = the per-conversation
 * model-pin overlay: `pinnedConv?.model ?? indexEntry?.model ??
 * settings.activeModel`) — read side by side with agentLoop.ts, not
 * guessed. Needed shell-side because `resolveEntryModel`/`resolveEffective
 * LlmCreds`/`precomputeOrchestration` all take this pinned-model-aware
 * snapshot, not the raw global settings.
 */
function resolveEntrySettings(conversationId: string): { settings: SettingsState; settingsForModel: SettingsState } {
  const settings = getSettingsReader().getSnapshot();
  const pinnedConv = getConversationReader().getConversation(conversationId);
  const baseModel =
    pinnedConv?.model ??
    getConversationReader().getIndexEntry(conversationId)?.model ??
    settings.activeModel;
  const settingsForModel: SettingsState =
    baseModel === settings.activeModel ? settings : { ...settings, activeModel: baseModel };
  return { settings, settingsForModel };
}

/**
 * Build the `agent.run` wire params — the shell-side "frozen snapshot"
 * projection of everything `runAgentLoop` would otherwise resolve
 * in-process (design doc §4's `AgentRunParams` contract,
 * P1-3B-3A-REPORT.md §4). Every field is resolved ONCE here, at dispatch
 * time (anti-bleed discipline — same principle as subagentRunner.ts's
 * `buildSubagentRunParams`) — frozen for the whole run.
 *
 * Throws if `resolveEffectiveLlmCreds` throws (enterprise gateway
 * unavailable — `EnterpriseLlmUnavailableError`) or if the conversation
 * record is missing — the caller (`runAgentLoopDispatched`) treats either
 * as a pre-dispatch failure and falls back to `runAgentLoop` in-process,
 * which hits the identical real error path itself rather than this
 * function duplicating its error-shaping logic (same discipline as
 * subagentRunner.ts's `buildSubagentRunParams`).
 *
 * Deliberately does NOT replicate the loop's OWN "no API key configured"
 * early-return gate (`providerRequiresApiKey(settingsForModel) &&
 * !getActiveApiKey(settingsForModel)`, agentLoop.ts's entry) — that gate
 * has no THROWING failure mode (`resolveEffectiveLlmCreds` returns an
 * empty-string `apiKey` unchanged in personal mode; it only throws for the
 * enterprise-gateway-unavailable case). Dispatching normally and letting
 * the SIDECAR's own unchanged `runAgentLoop` hit that exact gate (writing
 * the identical "configure an API key" conversation turn, via the SAME
 * settings mirror this function's `settingsSnapshot` seeds) is correct and
 * avoids a third hand-copy of that specific check.
 */
async function buildAgentRunParams(
  runId: string,
  conversationId: string,
  userMessage: string,
  options: AgentLoopOptions | undefined,
): Promise<AgentRunParams> {
  const conversationSnapshot = getConversationReader().getConversation(conversationId);
  if (!conversationSnapshot) {
    throw new Error(`buildAgentRunParams: no conversation record for "${conversationId}"`);
  }
  const indexEntrySnapshot = getConversationReader().getIndexEntry(conversationId);

  const { settings, settingsForModel } = resolveEntrySettings(conversationId);

  // Single source with runAgentLoop's own entry derivation AND
  // entryOrchestration.ts's precomputeOrchestration — see
  // resolveEntryModel.ts's doc for why this is the third (not a fourth,
  // hand-copied) caller of the same pure formula.
  const orchestration = await precomputeOrchestration(conversationId, userMessage, options?.imContext, { settings, settingsForModel });
  const { effectiveModelId, provider } = resolveEntryModel(orchestration.route, settings, settingsForModel);

  // May throw (EnterpriseLlmUnavailableError) — propagates to the caller,
  // see this function's doc.
  const resolvedCreds = resolveEffectiveLlmCreds(
    getActiveApiKey(settingsForModel),
    getActiveProvider(settingsForModel)?.baseUrl || undefined,
  );

  let capsSnapshot: AgentRunParams['capsSnapshot'];
  if (provider) {
    const discovered = getCapsPort().get(provider.id, effectiveModelId);
    if (discovered) {
      capsSnapshot = {
        providerId: provider.id,
        modelId: effectiveModelId,
        maxOutputTokens: discovered.maxOutputTokens,
        contextWindow: discovered.contextWindow,
        isReasoningModel: discovered.isReasoningModel,
      };
    }
  }

  const toolList = getToolInvoker().getAllTools().map(toSerializableTool);

  // P1-3B-4 — snapshot the shell's userInputQueue for this conversation at
  // dispatch time (projected to the wire-safe shape — id/text/isSystem,
  // dropping the shell-local `timestamp`). See AgentRunParams.queuedInputs's
  // doc above for why this exists.
  const queuedInputs = getQueuedInputs(conversationId).map((qi) => ({
    id: qi.id,
    text: qi.text,
    ...(qi.isSystem ? { isSystem: qi.isSystem } : {}),
  }));

  return {
    runId,
    conversationId,
    userMessage,
    options: { images: options?.images, blockedTools: options?.blockedTools, imContext: options?.imContext },
    orchestration,
    conversationSnapshot: conversationSnapshot as Conversation,
    indexEntrySnapshot: indexEntrySnapshot as ConversationMeta | undefined,
    settingsSnapshot: settings,
    capsSnapshot,
    resolvedCreds,
    toolList,
    planMode: getPlanMode(conversationId),
    locale: getLocale(),
    queuedInputs,
  };
}

/**
 * `runAgentLoopDispatched` — the drop-in dispatch entrypoint. IDENTICAL
 * signature to `runAgentLoop` (design doc §4: "selectAgentLoopRunner only
 * `'running'` walks sidecar... 8 caller-side call sites all switch line" —
 * the 4th reuse of the `selectChatAdapter`/`runSubagent` zero-risk-switch
 * shape). Every existing caller of `runAgentLoop` switches to this.
 *
 * - sidecar NOT `'running'` → `runAgentLoop` in-process, unchanged.
 * - sidecar `'running'` → concurrency guard (see below), then dispatch
 *   `agent.run`, then the fallback/re-run discipline (see below).
 *
 * ## Concurrency guard
 *
 * `runAgentLoop`'s own in-process guard (`hasAbortController(conversationId)`
 * + `enqueueUserInput`) lives INSIDE `agentLoop.ts`, which for a
 * sidecar-dispatched run executes sidecar-side — but the sidecar's
 * `agentLoopHost.ts` gives each `agent.run` REQUEST its OWN fresh
 * `abortRegistry` (a `Map` scoped to that ONE `handleAgentRun` call, not the
 * conversation), so a SECOND `agent.run` dispatch for the same
 * conversationId would never trip that guard — it would just start a
 * second, fully independent sidecar-side loop racing the first. This
 * function replicates the guard SHELL-SIDE across BOTH venues a "loop is
 * already live for this conversation" can mean:
 *   1. An existing sidecar RunSession (this module's own `sessions`
 *      registry) → stage the message into that run via the NEW
 *      `agent.enqueueInput` notification (sidecar applies it to its own
 *      `userInputQueue.ts`, unchanged/sidecar-resident — see
 *      `agentLoopHost.ts`'s `handleAgentEnqueueInput`).
 *   2. An existing IN-PROCESS run for this conversationId (the real
 *      `AbortRegistry`, e.g. the sidecar came up mid-run, or a narrow race
 *      between the two paths) → stage directly via the real
 *      `enqueueUserInput` (same call the in-process guard itself makes).
 * Same staging preconditions as the in-process guard: interactive-desktop
 * only, non-empty trimmed text, no images (an image/empty send falls
 * through to a normal dispatch — "silently losing an image is worse than
 * the rare double-loop race", same acceptance the in-process guard's own
 * comment documents).
 *
 * ## Fallback / re-run discipline
 *
 * A `agent.run` dispatch can fail two structurally different ways (mirrors
 * subagentRunner.ts's `runSubagent` exactly):
 *   1. Before the run is "committed" (`RunSession.committed` — flipped on
 *      the first `tool.invoke` OR the first `agent.delta` frame applied) →
 *      nothing observable has happened yet → safe to retry the WHOLE run
 *      in-process via `runAgentLoop`.
 *   2. After the run is committed → real side effects (a tool ran, or text
 *      already streamed into the visible transcript) may have occurred →
 *      surfaces as `{reason:'error', error:...}` instead. NO rerun (would
 *      double-execute tool side effects / duplicate streamed text).
 * `buildAgentRunParams` itself failing (thrown before ANY dispatch — e.g.
 * `EnterpriseLlmUnavailableError`, or a missing conversation record) is
 * ALSO pre-commit by construction — same in-process fallback.
 */
export async function runAgentLoopDispatched(
  conversationId: string,
  userMessage: string,
  options?: AgentLoopOptions,
): Promise<AgentLoopResult> {
  if (getSidecarStatus() !== 'running') {
    return runAgentLoop(conversationId, userMessage, options);
  }

  ensureHandlersRegistered();

  // ── Concurrency guard — see doc above for the two-venue rationale.
  {
    const runningConv = getConversationReader().getConversation(conversationId);
    const interactive = isInteractiveDesktop(options, runningConv);
    const stageable = userMessage.trim().length > 0 && !(options?.images?.length);
    if (interactive && stageable) {
      const runningSession = findRunSessionForConversation(conversationId);
      if (runningSession?.runId) {
        notifySidecar('agent.enqueueInput', { runId: runningSession.runId, userMessage });
        return { reason: 'enqueued' };
      }
      if (runningConv?.status === 'running' && getAbortRegistry().hasAbortController(conversationId)) {
        // A live IN-PROCESS run for this conversation — stage into ITS
        // queue via the same real function the in-process guard itself
        // calls (userInputQueue.ts, unchanged).
        enqueueUserInput(conversationId, userMessage);
        return { reason: 'enqueued' };
      }
    }
  }

  const runId = generateRunId();
  logger.debug('agent-loop path selected', { path: 'sidecar', runId, conversationId });

  let params: AgentRunParams;
  try {
    params = await buildAgentRunParams(runId, conversationId, userMessage, options);
  } catch (err) {
    // Failed before any dispatch — pre-commit by construction (see doc).
    logger.warn('agent-loop dispatch params build failed — running in-process', {
      runId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return runAgentLoop(conversationId, userMessage, options);
  }

  // ── Shell-side session + abort wiring ────────────────────────────────
  // clearAbortController first (mirrors agentLoop.ts's own entry: "Force-
  // clear any stale controller first to avoid inheriting aborted state from
  // a previous run"), then get-or-create — this is the SAME controller the
  // UI's existing Stop button already targets via the real AbortRegistry
  // (chatStore.ts's `abortControllers` map), so the Stop button needs ZERO
  // changes (design doc §3's abortRegistry row) — its `.abort()` call fires
  // the listener below, which forwards to the sidecar.
  const abortRegistry = getAbortRegistry();
  abortRegistry.clearAbortController(conversationId);
  const shellAbortController = abortRegistry.getAbortController(conversationId);

  const session: RunSession = {
    conversationId,
    loopId: runId, // same id as runId by convention — see agentLoop.ts's AgentLoopOptions.loopId doc.
    options: {
      requestCommandConfirmation: options?.commandConfirmCallback,
      requestFilePermission: options?.filePermissionCallback,
    },
    shellAbortController,
    toolCallToStepId: new Map(),
    committed: false,
    // P1-3B-4 — the entries in `params.queuedInputs` were already seeded
    // into the sidecar's OWN queue at dispatch time (agentLoopHost.ts's
    // handleAgentRun), so pre-mark them forwarded BEFORE registerRunSession
    // installs the live forwarder — otherwise the forwarder would re-send
    // these same still-lingering (not-yet-consumed) shell-queue entries the
    // next time ANY queue mutation fires.
    forwardedQueueIds: new Set(params.queuedInputs?.map((qi) => qi.id)),
  };

  const onShellAbort = (): void => {
    notifySidecar('agent.abort', { runId });
  };
  session.onShellAbort = onShellAbort;
  shellAbortController.signal.addEventListener('abort', onShellAbort, { once: true });

  registerRunSession(runId, session);
  installShellLoopContext(runId, session);

  try {
    const raw = await sidecarRequest('agent.run', params, 0);
    if (!isAgentLoopResult(raw)) {
      throw new Error('agent.run response did not match the expected AgentLoopResult shape');
    }
    return raw;
  } catch (err) {
    if (!session.committed) {
      logger.warn('agent-loop transport failed before commit — retrying in-process', {
        runId,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return runAgentLoop(conversationId, userMessage, options);
    }
    // Surface the REAL sidecar-side cause: a thrown handler comes back as a
    // generic `-32603 Internal error`, but `errorFromCaught` (sidecar
    // protocol.ts) carries the real message/stack in the error's `data`.
    // Logging only `err.message` (the generic wrapper) threw that away — pull
    // `data` out so the on-disk log names the actual failure.
    const errData = (err as { data?: unknown } | null)?.data;
    const realMessage =
      errData && typeof errData === 'object' && 'message' in errData
        ? String((errData as { message: unknown }).message)
        : err instanceof Error ? err.message : String(err);
    logger.warn('agent-loop transport failed after commit — surfacing error, no rerun', {
      runId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
      sidecarCause: realMessage,
      sidecarStack:
        errData && typeof errData === 'object' && 'stack' in errData
          ? String((errData as { stack: unknown }).stack)
          : undefined,
    });
    // The sidecar loop threw uncaught, so its OWN terminal UI-finalization
    // frames (finishStreaming / setConversationStatus) never arrived — the
    // conversation is left mid-stream and hangs on "thinking". Finalize it
    // here, mirroring the in-process error path (agentLoop.ts:2238/2258), so
    // the UI always leaves the thinking state. Best-effort; all in-flight
    // delta frames were already flushed (sidecar handleAgentRun's finally
    // runs coalescer.flush() before the error propagates), so this runs after
    // them, not racing.
    try {
      const chatDelta = getChatDelta();
      chatDelta.appendText(conversationId, `\n\n**Error:** ${realMessage}`);
      chatDelta.finishStreaming(conversationId);
      chatDelta.setAgentStatus('idle');
      chatDelta.setConversationStatus(conversationId, 'error');
    } catch (cleanupErr) {
      logger.warn('post-commit UI finalization failed', {
        conversationId,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    return { reason: 'error', error: realMessage };
  } finally {
    removeShellLoopContext(runId);
    unregisterRunSession(runId);
    shellAbortController.signal.removeEventListener('abort', onShellAbort);
    abortRegistry.clearAbortController(conversationId);
  }
}
