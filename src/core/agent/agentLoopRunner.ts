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
 * `session.isMessageWrittenToDisk` / `skillHooks.clearAll` /
 * `approval.check` — P1-3d-3 — / `workspace.bindFromWrite` /
 * `snapshot.beforeAiEdit` — both P1-3d A-write, see those handlers' own docs /
 * `workspace.authorizedWritablePaths` / `shell.sandboxBlocked` — both P1-3d-5
 * slice 2a, `commandTools.ts` plumbing landed ahead of `run_command` itself
 * running locally — see those handlers' own docs)
 * and the shell→sidecar push half (`agent.run` / `agent.abort` /
 * `agent.enqueueInput` / `state.settings` / `state.convPatch` /
 * `state.execPatch` / `state.planMode`).
 */
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { checkToolApproval, type ToolApprovalDecision } from '../tools/registry';
import type { ImageAttachment, ToolExecutionContext, Conversation } from '../../types';
import {
  onSidecarNotification,
  onSidecarRequest,
  onSidecarConnectionState,
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
import { ensureHookBridgeRegistered, registerHookSignalSource } from './hookBridge';
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
import { useChatStore, waitForConversationPersistence } from '../../stores/chatStore';
import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import type { PlannedStep } from '../../types/execution';
import { getI18n, getLocale } from '../../i18n';
import { createLogger } from '../logging/logger';
import {
  runAgentLoop,
  buildUserMessageContent,
  isInteractiveDesktop,
  type AgentLoopOptions,
  type AgentLoopResult,
} from './agentLoop';
import {
  areAgentRunTerminalsEqual,
  isAgentRunTerminal,
  type AgentRunTerminal,
} from './agentRunTerminal';
import { precomputeOrchestration } from './entryOrchestration';
import type { RouteResult, IMContext } from './orchestrator';
import type { PromptSection } from '../llm/promptSections';
import type { ConversationMeta } from '../session/conversationStorage';
import { resolveEntryModel } from './resolveEntryModel';
import { getActiveApiKey, getActiveProvider } from '../../utils/settingsSelectors';
import { resolveEffectiveLlmCreds } from '../enterprise/llm-resolver';
import { enqueueUserInput, getQueuedInputs, subscribeToInputQueue, removeQueuedInput, drainQueuedInputs } from './userInputQueue';
import { registerSidecarRunPredicate } from './sidecarRunPredicate';
import { bindWorkspaceFromWrite } from './defaultWorkspace';
import { snapshotBeforeAiEdit } from '../../utils/aiEditSnapshots';
import { getAuthorizedWritablePaths } from '../tools/pathSafety';
import { showSandboxBlockedToast } from '../sandbox/recovery';
import { ensureBuiltinBrowserRuntime } from '../browser/builtinBrowserRuntime';
import { matchesToolPattern } from '../skill/toolFilter';
import {
  finishRuntimeRun,
  markRuntimeRunStage,
  runtimeErrorType,
  startRuntimeRun,
  traceRuntimeEvent,
} from '../observability/runtimeTrace';
import { getElectronSidecarRunFact } from '../../utils/electronHost';

const logger = createLogger('agent-loop-runner');
const AGENT_ABORT_ACK_TIMEOUT_MS = 1_000;
const AGENT_ABORT_FORCE_FINALIZE_MS = 5_000;
const AGENT_FIRST_FRAME_STALL_MS = 30_000;
const AGENT_START_ACK_TIMEOUT_MS = 3_000;
const AGENT_STATE_QUERY_TIMEOUT_MS = 2_000;

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
  blockedTools?: string[];
  allowedTools?: string[];
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
  clientMessageId?: string;
  userMessageId?: string;
  payloadDigest?: string;
  accepted?: boolean;
  transportReplayCount?: number;
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
  /**
   * Per-run FIFO for asynchronous `agent.delta` application. JSON-RPC
   * notifications arrive in order, but their handlers are synchronous and
   * cannot await `applyDeltaFrames`; without this chain, separate batches
   * race each other and the final response can resolve before disk frames.
   */
  frameApplyTail?: Promise<void>;
  /** Dedicated cancellation for the long-lived `agent.run` transport. The
   * UI AbortController must not cancel it immediately: we first wait for the
   * sidecar's ordered abort ACK, then fence frames and end the transport. */
  transportAbortController?: AbortController;
  abortRequested?: boolean;
  dropFrames?: boolean;
  abortWatchdog?: ReturnType<typeof setTimeout>;
  abortRequestPromise?: Promise<void>;
  abortFinalizationPromise?: Promise<void>;
  /** First valid terminal fact wins. Later duplicates are idempotent and a
   * conflicting terminal is ignored, so transport retries cannot rewrite an
   * already-observed outcome. */
  terminal?: AgentRunTerminal;
  terminalPromise?: Promise<AgentRunTerminal>;
  resolveTerminal?: (terminal: AgentRunTerminal) => void;
  failureFinalizationPromise?: Promise<void>;
  runtimeStartedAt?: number;
  firstDeltaAt?: number;
  firstFrameApplied?: boolean;
  firstFrameStallTimer?: ReturnType<typeof setTimeout>;
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
  const session = sessions.get(runId);
  if (session?.abortWatchdog) clearTimeout(session.abortWatchdog);
  if (session?.firstFrameStallTimer) clearTimeout(session.firstFrameStallTimer);
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
  for (const session of sessions.values()) {
    if (session.abortWatchdog) clearTimeout(session.abortWatchdog);
    if (session.firstFrameStallTimer) clearTimeout(session.firstFrameStallTimer);
  }
  sessions.clear();
  uninstallPushEmitters();
}

// ── Reverse-channel handlers (registered ONCE at module init) ──────────

/** `agent.delta` (NOTIFICATION) → {runId, frames} → applyDeltaFrames. Unknown runId → silent drop (3a discipline, matches handleSubagentAbort's unknown-runId no-op). */
function handleAgentDelta(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; frames?: unknown } | null;
  if (!params || typeof params.runId !== 'string' || !Array.isArray(params.frames)) return;
  const frames = params.frames as PortFrame[];
  const session = sessions.get(params.runId);
  if (!session) return; // unknown/already-finished runId — silent drop
  if (session.dropFrames) return; // terminal fence — late frames from an aborted run are stale
  // P1-3B-3B fallback discipline: the first frame observed for this run is
  // an already-committed, observable side effect (text/thinking streamed to
  // the real chatStore) — see RunSession.committed's doc.
  const isFirstDelta = frames.length > 0 && session.firstDeltaAt === undefined;
  if (frames.length > 0) {
    session.committed = true;
    if (isFirstDelta) {
      updateSessionMessageState(session, 'running');
      session.firstDeltaAt = Date.now();
      if (session.firstFrameStallTimer) {
        clearTimeout(session.firstFrameStallTimer);
        session.firstFrameStallTimer = undefined;
      }
      markRuntimeRunStage(params.runId, 'first_delta_received');
      traceRuntimeEvent('renderer.agent_delta_received', {
        runId: params.runId,
        frameCount: frames.length,
        stage: 'first_delta_received',
        durationMs: session.runtimeStartedAt === undefined
          ? undefined
          : session.firstDeltaAt - session.runtimeStartedAt,
      });
    }
  }
  const previous = session.frameApplyTail ?? Promise.resolve();
  session.frameApplyTail = previous.then(() =>
    applyDeltaFrames(frames)
  ).then(() => {
    if (!isFirstDelta || session.firstFrameApplied) return;
    session.firstFrameApplied = true;
    markRuntimeRunStage(params.runId as string, 'first_frame_applied');
    traceRuntimeEvent('renderer.first_frame_applied', {
      runId: params.runId as string,
      frameCount: frames.length,
      stage: 'first_frame_applied',
      firstFrameMs: session.runtimeStartedAt === undefined
        ? undefined
        : Date.now() - session.runtimeStartedAt,
    });
  }).catch((err: unknown) => {
    logger.warn('applyDeltaFrames threw', { runId: params.runId, error: err instanceof Error ? err.message : String(err) });
  });
}

/** `agent.terminal` (NOTIFICATION) — first valid terminal wins per run. */
function handleAgentTerminal(rawParams: unknown): void {
  if (!isAgentRunTerminal(rawParams)) return;
  const session = sessions.get(rawParams.runId);
  if (!session) return;

  if (session.terminal) {
    if (!areAgentRunTerminalsEqual(session.terminal, rawParams)) {
      logger.warn('conflicting agent terminal ignored', {
        runId: rawParams.runId,
        firstState: session.terminal.state,
        conflictingState: rawParams.state,
      });
    }
    return;
  }

  session.terminal = rawParams;
  session.dropFrames = true;
  if (session.firstFrameStallTimer) {
    clearTimeout(session.firstFrameStallTimer);
    session.firstFrameStallTimer = undefined;
  }
  markRuntimeRunStage(rawParams.runId, 'terminal_received');
  traceRuntimeEvent('renderer.agent_terminal_received', {
    runId: rawParams.runId,
    executionPath: 'sidecar',
    stage: 'terminal_received',
    outcome: rawParams.result.reason,
    durationMs: session.runtimeStartedAt === undefined
      ? undefined
      : Date.now() - session.runtimeStartedAt,
  });
  session.resolveTerminal?.(rawParams);
}

function updateSessionMessageState(
  session: RunSession,
  state: NonNullable<Conversation['messages'][number]['runState']>,
  error?: string,
): void {
  if (!session.userMessageId) return;
  useChatStore.getState().updateUserMessageRun(
    session.conversationId,
    session.userMessageId,
    { state, ...(error ? { error } : {}) },
  );
}

async function runInProcessWithPersistedMessage(
  conversationId: string,
  userMessage: string,
  runId: string,
  clientMessageId: string,
  options?: AgentLoopOptions,
): Promise<AgentLoopResult> {
  // Params preparation can fail before it upgrades the durable raw message
  // to multimodal content. Do that here before the in-process handoff so a
  // pre-dispatch failure never drops an attached image merely because the
  // local loop is told not to append a duplicate user row.
  const persistedMessage = getConversationReader()
    .getConversation(conversationId)
    ?.messages.find((message) => message.id === clientMessageId);
  if (options?.images?.length && typeof persistedMessage?.content === 'string') {
    const content = await buildUserMessageContent(conversationId, userMessage, options.images);
    useChatStore.getState().updateUserMessageRun(conversationId, clientMessageId, {
      state: 'pending',
      content,
    });
    await waitForConversationPersistence(conversationId);
  }
  useChatStore.getState().updateUserMessageRun(conversationId, clientMessageId, { state: 'running' });
  try {
    const result = await runAgentLoop(conversationId, userMessage, {
      ...options,
      loopId: runId,
      prePersistedUserMessageId: clientMessageId,
    });
    const state = result.reason === 'aborted'
      ? 'interrupted'
      : result.reason === 'error'
        ? 'failed'
        : 'completed';
    useChatStore.getState().updateUserMessageRun(conversationId, clientMessageId, {
      state,
      ...(result.error ? { error: result.error } : {}),
    });
    await waitForConversationPersistence(conversationId);
    return result;
  } catch (error) {
    useChatStore.getState().updateUserMessageRun(conversationId, clientMessageId, {
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    await waitForConversationPersistence(conversationId);
    throw error;
  }
}

async function finalizePreDispatchInterruptedRun(
  conversationId: string,
  clientMessageId: string,
  runId: string,
  stage: 'params_build_aborted' | 'before_dispatch',
  runtimeStartedAt: number,
): Promise<AgentLoopResult> {
  useChatStore.getState().updateUserMessageRun(conversationId, clientMessageId, {
    state: 'interrupted',
  });
  getAbortRegistry().clearAbortController(conversationId);
  getChatDelta().setConversationStatus(conversationId, 'idle');
  traceRuntimeEvent('renderer.agent_run_aborted', {
    runId,
    executionPath: 'sidecar',
    stage,
    outcome: 'aborted',
    durationMs: Date.now() - runtimeStartedAt,
  });
  try {
    await waitForConversationPersistence(conversationId);
  } finally {
    finishRuntimeRun(runId);
  }
  return { reason: 'aborted' };
}

async function settleRunPersistence(session: RunSession): Promise<void> {
  await (session.frameApplyTail ?? Promise.resolve());
  await waitForConversationPersistence(session.conversationId);
}

async function finalizeFailedRun(
  session: RunSession,
  displayMessage: string,
  state: 'failed' | 'connection-failed' = 'failed',
): Promise<void> {
  if (session.failureFinalizationPromise) return session.failureFinalizationPromise;

  session.failureFinalizationPromise = (async () => {
    session.dropFrames = true;
    updateSessionMessageState(session, state, displayMessage);
    await (session.frameApplyTail ?? Promise.resolve());
    try {
      const chatDelta = getChatDelta();
      chatDelta.appendText(session.conversationId, `\n\n**Error:** ${displayMessage}`);
      chatDelta.finishStreaming(session.conversationId);
      chatDelta.setAgentStatus('idle');
      chatDelta.setConversationStatus(session.conversationId, 'error');
    } catch (cleanupErr) {
      logger.warn('terminal UI finalization failed', {
        conversationId: session.conversationId,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    // Both the user lifecycle row and the finalized assistant/error state are
    // part of the terminal contract. Never report a failed run as settled
    // while either write is still pending or has failed.
    await waitForConversationPersistence(session.conversationId);
  })();

  return session.failureFinalizationPromise;
}

/**
 * Shell-owned, idempotent abort terminal. It is intentionally ordered after
 * all frames accepted before the sidecar ACK (or before the watchdog fires),
 * then closes the frame gate before mutating the real stores. This restores
 * the Tauri-era guarantee that Stop always reaches a visible terminal state
 * even when the model reader or sidecar cleanup never settles.
 */
async function finalizeAbortedRun(session: RunSession, source: 'ack' | 'watchdog' | 'run-terminal'): Promise<void> {
  if (session.abortFinalizationPromise) return session.abortFinalizationPromise;

  session.abortFinalizationPromise = (async () => {
    try {
      session.dropFrames = true;
      updateSessionMessageState(session, 'interrupted');
      if (session.abortWatchdog) {
        clearTimeout(session.abortWatchdog);
        session.abortWatchdog = undefined;
      }

      await (session.frameApplyTail ?? Promise.resolve());

      // Permission dialogs live in the shell and must not survive a force-stop.
      drainConfirmationQueue();
      drainFilePermissionQueue();
      drainWorkspaceRequest();
      drainUserQuestions();

      if (getConversationReader().getConversation(session.conversationId)) {
        const chatDelta = getChatDelta();

      // Drop an untouched streaming placeholder before cancelStreaming, so
      // Stop-before-first-token cannot leave a blank assistant bubble.
      const conversation = getConversationReader().getConversation(session.conversationId);
      const streamingAssistant = conversation
        ? [...conversation.messages].reverse().find((message) => message.role === 'assistant' && message.isStreaming)
        : undefined;
      try {
        if (streamingAssistant) {
          const text = typeof streamingAssistant.content === 'string'
            ? streamingAssistant.content
            : streamingAssistant.content
                .filter((part) => part.type === 'text')
                .map((part) => (part as { type: 'text'; text: string }).text)
                .join('');
          const isGhost = text.trim().length === 0
            && !(streamingAssistant.toolCalls?.length)
            && !(streamingAssistant.toolCallsForContext?.length)
            && !streamingAssistant.thinking;
          if (isGhost) {
            const { isMessageWrittenToDisk } = await import('../session/conversationStorage');
            chatDelta.deleteMessage(session.conversationId, streamingAssistant.id, {
              skipCatalogBump: !isMessageWrittenToDisk(streamingAssistant.id),
            });
          }
        }
      } catch (err) {
        logger.warn('abort ghost cleanup failed; continuing terminal finalization', {
          runId: session.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Preserve user-visible queued follow-ups before clearing the queue,
      // matching agentLoop.ts's normal abort catch. System entries remain
      // hidden because they are internal wake-up/control messages.
      try {
        for (const queued of drainQueuedInputs(session.conversationId)) {
          if (queued.isSystem) continue;
          chatDelta.addMessage(session.conversationId, {
            id: `abort-queued-${queued.id}`,
            role: 'user',
            content: queued.text,
            timestamp: queued.timestamp,
            loopId: session.loopId,
          });
        }
      } catch (err) {
        logger.warn('abort queued-input cleanup failed; continuing terminal finalization', {
          runId: session.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      chatDelta.cancelStreaming(session.conversationId, { fromSidecarFrame: true });
      chatDelta.deactivateSkills(session.conversationId);
      chatDelta.setAgentStatus('idle');
      chatDelta.setConversationStatus(session.conversationId, 'idle');
      getExecutionPort().cancelExecution(session.loopId);
        await waitForConversationPersistence(session.conversationId);
      }
    } finally {
      // These are best-effort shell resources; a force-finalized sidecar run
      // can no longer be trusted to send its normal cleanup notifications.
      void import('../capabilityPlugins/setupBridge')
        .then(({ drainCapabilitySetupRequests }) => drainCapabilitySetupRequests(session.loopId))
        .catch(() => {});
      void import('../session/checkpoint')
        .then(({ clearCheckpoint }) => clearCheckpoint(session.conversationId))
        .catch(() => {});
      void import('../tools/definitions/computerTools')
        .then(({ closeAxSession }) => closeAxSession())
        .catch(() => {});

      // Reject only this run's never-ending RPC. This must happen even when
      // the durability barrier fails, while that persistence error still
      // propagates to the caller instead of being disguised as a settled run.
      if (!session.transportAbortController?.signal.aborted) {
        const error = new Error(`agent.run transport closed after abort ${source}`);
        error.name = 'AbortError';
        session.transportAbortController?.abort(error);
      }
    }
  })().catch((err: unknown) => {
    logger.warn('abort finalization failed', {
      runId: session.runId,
      conversationId: session.conversationId,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  });

  return session.abortFinalizationPromise;
}

function requestSidecarRunAbort(session: RunSession): Promise<void> {
  if (session.abortRequestPromise) return session.abortRequestPromise;
  session.abortRequested = true;
  markRuntimeRunStage(session.runId ?? session.loopId, 'abort_requested');
  traceRuntimeEvent('renderer.agent_abort_requested', {
    runId: session.runId ?? session.loopId,
    method: 'agent.abort',
    stage: 'abort_requested',
  });
  session.abortWatchdog = setTimeout(() => {
    traceRuntimeEvent('renderer.agent_abort_watchdog_fired', {
      runId: session.runId ?? session.loopId,
      method: 'agent.abort',
      stage: 'force_finalize',
      outcome: 'stalled',
    });
    void finalizeAbortedRun(session, 'watchdog').catch(() => undefined);
  }, AGENT_ABORT_FORCE_FINALIZE_MS);

  session.abortRequestPromise = sidecarRequest(
    'agent.abort',
    { runId: session.runId },
    AGENT_ABORT_ACK_TIMEOUT_MS,
  ).then(async () => {
    traceRuntimeEvent('renderer.agent_abort_ack_received', {
      runId: session.runId ?? session.loopId,
      method: 'agent.abort',
      stage: 'ack_received',
      outcome: 'success',
    });
    await finalizeAbortedRun(session, 'ack');
  }).catch((err: unknown) => {
    // A pre-ACK timeout is not terminal: the sidecar may have received and
    // acted on the request. The watchdog owns deterministic local cleanup.
    logger.warn('agent.abort ACK unavailable; waiting for force-finalize watchdog', {
      runId: session.runId,
      conversationId: session.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    traceRuntimeEvent('renderer.agent_abort_ack_timeout', {
      runId: session.runId ?? session.loopId,
      method: 'agent.abort',
      stage: 'waiting_for_watchdog',
      outcome: 'stalled',
      errorType: runtimeErrorType(err),
    });
  });
  return session.abortRequestPromise;
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

/**
 * `shell.sandboxBlocked` (NOTIFICATION) — P1-3d-5 slice 2a. Sidecar-side
 * twin: `sidecar/src/shims/sandboxRecoveryRun.ts`'s `showSandboxBlockedToast`,
 * called by a locally-executed `run_command` (LIVE since slice 2b registered
 * it in `localTools/index.ts`) when its stderr contains `[sandbox-blocked]`,
 * mirroring the real `commandTools.ts`'s own guard exactly.
 *
 * Calls the REAL `showSandboxBlockedToast` (`core/sandbox/recovery.ts`,
 * unmoved) — the exact same function a shell-executed `run_command` calls
 * directly — so a locally-executed sandboxed command shows the identical
 * "authorize this directory" recovery toast regardless of which path ran it.
 * Fire-and-forget, matching `handleShellNotifyTask` above: no response is
 * awaited on either side.
 */
function handleShellSandboxBlocked(rawParams: unknown): void {
  const params = rawParams as { command?: unknown } | null;
  if (!params || typeof params.command !== 'string') return;
  showSandboxBlockedToast(params.command);
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
 * Allowlist = the Computer Use window-orchestration commands
 * (`toolExecutor.ts:300/304/310/316`) + `run_shell_command`
 * (`src/core/skill/preprocessor.ts`'s inline-command execution — the ONE
 * `invoke` call that file makes, verified by reading it; `abort_command`
 * (task-scoped cancellation for sidecar-local commands); see
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
  'abort_command',
  'atomic_write_text',
  // P1-3d-5 slice 3: delete_file runs locally in the sidecar and reverses its
  // OS-Trash move here. Safe to allowlist — move_to_trash is recoverable (lands
  // in Finder Trash, never a permanent delete), delete_file's write-path approval
  // still runs shell-side via approval.check, and its catastrophic-target
  // hard-block (root/home) runs in the tool's own execute() before this call.
  'move_to_trash',
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

/**
 * `workspace.authorizedWritablePaths` (REQUEST) — P1-3d-5 slice 2a. Sidecar-
 * side twin: `sidecar/src/shims/authorizedPathsReaderRun.ts`. Answers "what
 * paths has the user authorized for write access?" for a locally-executed
 * `run_command` (once slice 2b registers it in `localTools/index.ts`) —
 * `pathSafety.ts`'s `authorizedWorkspaces` map is shell-only state (populated
 * by `authorizeWorkspace()`, `registry.ts`/`triggerPermission.ts`), so this
 * is the same real `getAuthorizedWritablePaths()` the in-process
 * `AuthorizedPathsReader` default wraps — single source of truth, no
 * duplicated logic. Stateless (no runId/session lookup, mirroring
 * `handleToolList` above) since the authorized-paths set is global, not
 * per-run.
 */
async function handleWorkspaceAuthorizedPaths(): Promise<unknown> {
  return getAuthorizedWritablePaths();
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
  if (session.abortRequested || session.shellAbortController.signal.aborted) {
    throw new SidecarRequestError(-32000, `Agent-loop run is stopping: ${params.runId}`);
  }
  if (!useChatStore.getState().conversations[session.conversationId]) {
    throw new SidecarRequestError(-32000, `Conversation no longer exists for agent-loop runId: ${params.runId}`);
  }
  assertRunToolAllowed(session, params.toolName, (params.input as Record<string, unknown>) ?? {});
  // P1-3B-3B fallback discipline — see RunSession.committed's doc.
  session.committed = true;

  const invoker = getToolInvoker(); // shell-side in-process default — registry-backed, same as any in-process main-loop run.
  return await invoker.executeAnyTool(
    params.toolName,
    (params.input as Record<string, unknown>) ?? {},
    session.options.requestCommandConfirmation ?? requestCommandConfirmation,
    session.options.requestFilePermission ?? requestFilePermission,
    {
      ...((params.context as ToolExecutionContext | undefined) ?? {}),
      abortSignal: session.shellAbortController.signal,
    },
  );
}

/**
 * `approval.check` (REQUEST) — P1-3d-3
 * (docs/2026-07-21-phase1-p3d-tool-migration-design.md §3). Symmetric twin of
 * `handleMainLoopToolInvoke` above, but for a tool the SIDECAR intends to run
 * LOCALLY (see `sidecar/src/localTools/index.ts`) — asks the shell "would
 * this call be allowed?" WITHOUT executing it. Calls the exact same
 * `checkToolApproval` (registry.ts, P1-3d-3) that `handleMainLoopToolInvoke`
 * reaches transitively via `invoker.executeAnyTool` — same session
 * confirm/file-permission callback resolution, same conversation-existence
 * refusal (see that handler's doc for the deleted-conversation race this
 * guards), so approval decisions are IDENTICAL regardless of which path a
 * given tool call takes. Single source of truth: this handler must never
 * reimplement or duplicate the approval chain — see checkToolApproval's own
 * doc for why that matters (policy-gap regression risk).
 *
 * 🔴 Fail-closed contract with the caller (sidecar's `createReverseToolInvoker`,
 * `agentLoopHost.ts`): the RESULT of this RPC is advisory-only from the
 * transport's point of view — the sidecar treats anything other than a
 * clean `{decision:'allow'}` response (including a thrown/rejected RPC) as
 * "do not run this tool locally", falling back to the always-safe reverse
 * `tool.invoke` path instead of ever defaulting to allow. This handler's job
 * is only to answer honestly; it does not itself need retry/timeout logic —
 * an unhandled throw here becomes an RPC error response, which the sidecar's
 * fail-closed catch already treats as "not approved". For an allowed tool
 * that is not explicitly read-only, this handler also marks the run committed
 * before returning the ACK: after that boundary the shell cannot prove a
 * sidecar-local side effect did not happen, so automatic whole-run replay is
 * forbidden.
 */
async function handleApprovalCheck(rawParams: unknown): Promise<ToolApprovalDecision> {
  const params = rawParams as {
    runId?: unknown;
    toolName?: unknown;
    input?: unknown;
    context?: unknown;
  } | null;

  if (!params || typeof params.runId !== 'string' || typeof params.toolName !== 'string') {
    throw new SidecarRequestError(-32602, 'Invalid approval.check params: runId and toolName must be strings');
  }

  const session = sessions.get(params.runId);
  if (!session) {
    throw new SidecarRequestError(-32000, `Unknown agent-loop runId: ${params.runId}`);
  }
  if (!useChatStore.getState().conversations[session.conversationId]) {
    throw new SidecarRequestError(-32000, `Conversation no longer exists for agent-loop runId: ${params.runId}`);
  }
  assertRunToolAllowed(session, params.toolName, (params.input as Record<string, unknown>) ?? {});

  const decision = await checkToolApproval(
    params.toolName,
    (params.input as Record<string, unknown>) ?? {},
    params.context as ToolExecutionContext | undefined,
    session.options.requestCommandConfirmation ?? requestCommandConfirmation,
    session.options.requestFilePermission ?? requestFilePermission,
  );
  if (decision.decision === 'allow' && !isToolCallReplaySafe(params.toolName, params.input)) {
    // The sidecar executes this tool locally immediately after this ACK. From
    // this point onward a transport failure cannot prove whether the local
    // side effect happened, so the whole run must never be auto-replayed.
    // Mark before returning the allow ACK: a crash between ACK receipt and the
    // first delta is deliberately treated as "possibly committed".
    session.committed = true;
  }
  return decision;
}

function isToolCallReplaySafe(toolName: string, input: unknown): boolean {
  const tool = getToolInvoker().getAllTools().find((candidate) => candidate.name === toolName);
  if (!tool) return false;
  try {
    return typeof tool.isConcurrencySafe === 'function'
      ? tool.isConcurrencySafe((input as Record<string, unknown>) ?? {}) === true
      : tool.isConcurrencySafe === true;
  } catch {
    return false;
  }
}

/** Enforce run-scoped restrictions at the shell boundary as well as in the
 * sidecar loop. This protects both reverse tool.invoke and locally executed
 * sidecar tools that first call approval.check. */
function assertRunToolAllowed(
  session: RunSession,
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (session.options.blockedTools?.includes(toolName)) {
    throw new SidecarRequestError(-32602, `Tool is blocked for this agent run: ${toolName}`);
  }
  if (
    session.options.allowedTools?.length &&
    !session.options.allowedTools.some((pattern) => matchesToolPattern(toolName, pattern, input))
  ) {
    throw new SidecarRequestError(-32602, `Tool is not allowed for this agent run: ${toolName}`);
  }
}

/**
 * `workspace.bindFromWrite` (NOTIFICATION) — P1-3d A-write
 * (docs/2026-07-21-phase1-p3d-tool-migration-design.md "A-write" task).
 * Sidecar-side twin: `sidecar/src/shims/defaultWorkspaceRun.ts`'s
 * `bindWorkspaceFromWrite`, reached when `write_file` executes LOCALLY
 * (`sidecar/src/localTools/index.ts`) and calls the real tool's
 * `fileTools.ts:264` call site (`void bindWorkspaceFromWrite(...)` —
 * fire-and-forget, matching this being a NOTIFICATION rather than a
 * REQUEST: no response is awaited on either side).
 *
 * Calls the REAL `bindWorkspaceFromWrite` (`defaultWorkspace.ts`, unmoved —
 * the exact same function a shell-executed `write_file`, via the reverse
 * `tool.invoke` path, would call directly) — so a locally-executed write
 * under `~/Abu/` binds/authorizes the default workspace identically
 * regardless of which path ran the write.
 *
 * Session lookup mirrors `handleAgentDelta`'s "unknown/already-finished
 * runId → silent drop" discipline (3a), NOT `handleMainLoopToolInvoke`'s
 * hard-refuse-with-throw (there is no RPC response to fail here — silent
 * drop is the only sensible behavior for a fire-and-forget notification).
 * The real function is itself idempotent/self-guarding on a missing or
 * already-bound conversation (`defaultWorkspace.ts:119-122`), so this
 * lookup is a defense-in-depth consistency check, not the only thing
 * preventing a stale/deleted-conversation write from taking effect.
 */
function handleWorkspaceBindFromWrite(rawParams: unknown): void {
  const params = rawParams as { runId?: unknown; conversationId?: unknown; path?: unknown } | null;
  if (!params || typeof params.runId !== 'string' || typeof params.path !== 'string') return;
  const session = sessions.get(params.runId);
  if (!session) return; // unknown/already-finished runId — silent drop
  const conversationId = typeof params.conversationId === 'string' ? params.conversationId : undefined;
  void bindWorkspaceFromWrite(conversationId, params.path).catch((err: unknown) => {
    logger.warn('bindWorkspaceFromWrite threw', { error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * `snapshot.beforeAiEdit` (REQUEST) — P1-3d A-write. Sidecar-side twin:
 * `sidecar/src/shims/aiEditSnapshotsRun.ts`'s `snapshotBeforeAiEdit`,
 * reached when `write_file`/`edit_file` execute LOCALLY and `await` the
 * real tool's `snapshotBeforeAiEdit(...)` call (`fileTools.ts:257`/`:340`)
 * BEFORE writing to disk — a REQUEST (not a notification, unlike
 * `workspace.bindFromWrite` above) because the caller needs the round trip
 * to settle first, matching the real function's own "capture the 'before'
 * state before the write lands" contract.
 *
 * Calls the REAL `snapshotBeforeAiEdit` (`utils/aiEditSnapshots.ts`,
 * unmoved) — the exact same function a shell-executed write/edit would call
 * directly — so a locally-executed write/edit leaves the identical
 * revertable "before" state in `canvasVersions` version history.
 *
 * Session lookup mirrors `handleApprovalCheck`'s discipline (unknown runId
 * or a since-deleted conversation → throw, refusing to answer) — but unlike
 * that handler, a throw HERE is not user-visible as a denial: the sidecar
 * shim's fail-open catch (see `aiEditSnapshotsRun.ts`'s doc) swallows any
 * rejection and simply skips the snapshot for this turn, exactly mirroring
 * the real function's own "never blocks the edit" contract for a
 * legitimate shell-side call.
 */
async function handleSnapshotBeforeAiEdit(rawParams: unknown): Promise<null> {
  const params = rawParams as { runId?: unknown; path?: unknown; opts?: unknown } | null;
  if (!params || typeof params.runId !== 'string' || typeof params.path !== 'string') {
    throw new SidecarRequestError(-32602, 'Invalid snapshot.beforeAiEdit params: runId and path must be strings');
  }

  const session = sessions.get(params.runId);
  if (!session) {
    throw new SidecarRequestError(-32000, `Unknown agent-loop runId: ${params.runId}`);
  }
  if (!useChatStore.getState().conversations[session.conversationId]) {
    throw new SidecarRequestError(-32000, `Conversation no longer exists for agent-loop runId: ${params.runId}`);
  }

  const rawOpts = (params.opts && typeof params.opts === 'object' ? params.opts : {}) as Record<string, unknown>;
  await snapshotBeforeAiEdit(params.path, {
    loopId: typeof rawOpts.loopId === 'string' ? rawOpts.loopId : undefined,
    conversationId: typeof rawOpts.conversationId === 'string' ? rawOpts.conversationId : undefined,
    knownContent: typeof rawOpts.knownContent === 'string' ? rawOpts.knownContent : undefined,
  });
  return null;
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
  registerHookSignalSource('agentLoop', {
    getAbortSignal: (runId) => sessions.get(runId)?.shellAbortController.signal,
  });
  // hook.emit / hook.notify — shared with the subagent path via the neutral
  // hookBridge (see hookBridge.ts's doc). Without this, a session that runs
  // ONLY a main loop (no subagent) had no hook.emit handler at all, so the
  // first tool call's preToolCall hook failed with "-32601 Method not found:
  // hook.emit" (the bug the real-machine smoke surfaced).
  ensureHookBridgeRegistered();

  onSidecarConnectionState((event) => {
    for (const session of sessions.values()) {
      if (!session.accepted || session.terminal || session.dropFrames) continue;
      if (event.state === 'recovering') {
        updateSessionMessageState(session, 'recovering');
      } else if (event.state === 'connected') {
        updateSessionMessageState(session, 'running');
      } else {
        updateSessionMessageState(session, 'connection-failed', getI18n().chat.sidecarInterrupted);
      }
    }
  });

  onSidecarNotification('agent.delta', handleAgentDelta);
  onSidecarNotification('agent.terminal', handleAgentTerminal);
  onSidecarNotification('approval.drain', handleApprovalDrain);
  onSidecarNotification('plan.clear', handlePlanClear);
  onSidecarNotification('caps.record', handleCapsRecord);
  onSidecarNotification('shell.notifyTask', handleShellNotifyTask);
  onSidecarNotification('cu.setState', handleCuSetState);
  onSidecarNotification('skillHooks.clearAll', handleSkillHooksClearAll);
  onSidecarNotification('input.consumed', handleInputConsumed);
  onSidecarNotification('workspace.bindFromWrite', handleWorkspaceBindFromWrite);
  onSidecarNotification('shell.sandboxBlocked', handleShellSandboxBlocked);

  onSidecarRequest('native.invoke', handleNativeInvoke);
  onSidecarRequest('tool.list', handleToolList);
  onSidecarRequest('session.isMessageWrittenToDisk', handleIsMessageWrittenToDisk);
  onSidecarRequest('approval.check', handleApprovalCheck);
  onSidecarRequest('snapshot.beforeAiEdit', handleSnapshotBeforeAiEdit);
  onSidecarRequest('workspace.authorizedWritablePaths', handleWorkspaceAuthorizedPaths);
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
    // Stop is a synchronous local barrier: once requested, no pending or new
    // composer input may cross into the old run and later "come back to life".
    if (session.abortRequested || session.dropFrames) continue;
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
    blockedTools: session.options.blockedTools,
    allowedTools: session.options.allowedTools,
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
  clientMessageId: string;
  payloadDigest: string;
  conversationId: string;
  userMessage: string;
  options: {
    images?: ImageAttachment[];
    blockedTools?: string[];
    allowedTools?: string[];
    imContext?: IMContext;
    prePersistedUserMessageId?: string;
  };
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

interface AgentStartAck {
  version: 1;
  runId: string;
  clientMessageId: string;
  acceptedAt: number;
  state: 'accepted' | 'running' | 'terminal';
  replay: boolean;
  terminal?: AgentRunTerminal;
}

interface AgentRunStateResult {
  version: 1;
  runId: string;
  state: 'not_found' | 'accepted' | 'running' | 'terminal';
  terminal?: AgentRunTerminal;
}

function isAgentStartAck(value: unknown, runId: string, clientMessageId: string): value is AgentStartAck {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && candidate.runId === runId
    && candidate.clientMessageId === clientMessageId
    && typeof candidate.acceptedAt === 'number'
    && (candidate.state === 'accepted' || candidate.state === 'running' || candidate.state === 'terminal')
    && typeof candidate.replay === 'boolean'
    && (candidate.terminal === undefined || isAgentRunTerminal(candidate.terminal));
}

function isAgentRunStateResult(value: unknown, runId: string): value is AgentRunStateResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && candidate.runId === runId
    && (
      candidate.state === 'not_found'
      || candidate.state === 'accepted'
      || candidate.state === 'running'
      || candidate.state === 'terminal'
    )
    && (candidate.terminal === undefined || isAgentRunTerminal(candidate.terminal));
}

let runIdCounter = 0;
function generateRunId(): string {
  runIdCounter += 1;
  return `agl-${Date.now().toString(36)}-${runIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function digestRunPayload(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `rrp1-${value.length.toString(16)}-${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
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

async function establishAgentStart(
  params: AgentRunParams,
  session: RunSession,
): Promise<AgentStartAck> {
  const accept = (raw: unknown): AgentStartAck => {
    if (!isAgentStartAck(raw, params.runId, params.clientMessageId)) {
      throw new Error('agent.start response did not match the expected acknowledgement shape');
    }
    session.accepted = true;
    updateSessionMessageState(session, raw.state === 'running' ? 'running' : 'accepted');
    markRuntimeRunStage(params.runId, raw.state === 'running' ? 'running' : 'accepted');
    traceRuntimeEvent('renderer.agent_start_accepted', {
      runId: params.runId,
      clientMessageId: params.clientMessageId,
      executionPath: 'sidecar',
      stage: raw.state,
      replayCount: raw.replay ? 1 : 0,
      acceptedAt: raw.acceptedAt,
    });
    if (raw.terminal) handleAgentTerminal(raw.terminal);
    return raw;
  };

  try {
    return accept(await sidecarRequest('agent.start', params, AGENT_START_ACK_TIMEOUT_MS));
  } catch (startError) {
    traceRuntimeEvent('renderer.agent_start_ack_missing', {
      runId: params.runId,
      clientMessageId: params.clientMessageId,
      executionPath: 'sidecar',
      stage: 'querying_state',
      errorType: runtimeErrorType(startError),
    });

    try {
      const rawState = await sidecarRequest(
        'run.getState',
        { runId: params.runId },
        AGENT_STATE_QUERY_TIMEOUT_MS,
      );
      if (!isAgentRunStateResult(rawState, params.runId)) {
        throw new Error('run.getState response did not match the expected shape', { cause: startError });
      }
      if (rawState.state !== 'not_found') {
        if (rawState.terminal) handleAgentTerminal(rawState.terminal);
        return accept({
          version: 1,
          runId: params.runId,
          clientMessageId: params.clientMessageId,
          acceptedAt: Date.now(),
          state: rawState.state === 'terminal' ? 'terminal' : rawState.state,
          replay: true,
          ...(rawState.terminal ? { terminal: rawState.terminal } : {}),
        });
      }
    } catch (stateError) {
      logger.warn('run state query failed after missing start ACK; replaying idempotent start', {
        runId: params.runId,
        error: stateError instanceof Error ? stateError.message : String(stateError),
      });
    }

    // Same runId/clientMessageId/payloadDigest: the sidecar either accepts it
    // once or replays the existing fact. It can never execute twice.
    return accept(await sidecarRequest('agent.start', params, AGENT_START_ACK_TIMEOUT_MS));
  }
}

type TransportRecovery =
  | { action: 'terminal'; terminal: AgentRunTerminal }
  | { action: 'reattach' }
  | { action: 'replay_execution' }
  | { action: 'not_found' }
  | { action: 'unavailable' };

function recoveryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryRunForTransportRecovery(
  params: AgentRunParams,
): Promise<TransportRecovery> {
  const mirrored = await getElectronSidecarRunFact(params.runId);
  if (mirrored?.state === 'terminal' && isAgentRunTerminal(mirrored.terminal)) {
    return { action: 'terminal', terminal: mirrored.terminal };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (getSidecarStatus() === 'running') {
      try {
        const raw = await sidecarRequest(
          'run.getState',
          { runId: params.runId },
          AGENT_STATE_QUERY_TIMEOUT_MS,
        );
        if (isAgentRunStateResult(raw, params.runId)) {
          if (raw.terminal) return { action: 'terminal', terminal: raw.terminal };
          if (raw.state === 'running') return { action: 'reattach' };
          if (raw.state === 'accepted') return { action: 'replay_execution' };
          if (raw.state === 'not_found') return { action: 'not_found' };
        }
      } catch {
        // The supervisor may be between process generations. Bounded retry
        // below; no user work is replayed until a concrete state is known.
      }
    }
    if (attempt < 3) await recoveryDelay(500 * attempt);
  }
  return { action: 'unavailable' };
}

async function waitForReattachedTerminal(
  params: AgentRunParams,
  session: RunSession,
): Promise<AgentRunTerminal> {
  let unavailableChecks = 0;
  while (true) {
    const tick = recoveryDelay(2_000).then(() => ({ kind: 'tick' as const }));
    const terminal = session.terminalPromise!.then((value) => ({ kind: 'terminal' as const, value }));
    const outcome = await Promise.race([terminal, tick]);
    if (outcome.kind === 'terminal') return outcome.value;
    if (session.shellAbortController.signal.aborted) {
      throw session.shellAbortController.signal.reason ?? new Error('Agent run aborted while reattaching');
    }
    const recovery = await queryRunForTransportRecovery(params);
    if (recovery.action === 'terminal') {
      handleAgentTerminal(recovery.terminal);
      return recovery.terminal;
    }
    if (recovery.action === 'not_found') {
      throw new Error('Sidecar lost an accepted agent run before terminal state was observed');
    }
    if (recovery.action === 'unavailable') {
      unavailableChecks += 1;
      if (unavailableChecks >= 3) {
        throw new Error('Sidecar run state remained unavailable during reattach');
      }
    } else {
      unavailableChecks = 0;
    }
  }
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
  clientMessageId: string,
  conversationId: string,
  userMessage: string,
  options: AgentLoopOptions | undefined,
  abortSignal?: AbortSignal,
): Promise<AgentRunParams> {
  const initialConversationSnapshot = getConversationReader().getConversation(conversationId);
  if (!initialConversationSnapshot) {
    throw new Error(`buildAgentRunParams: no conversation record for "${conversationId}"`);
  }
  const indexEntrySnapshot = getConversationReader().getIndexEntry(conversationId);

  const { settings, settingsForModel } = resolveEntrySettings(conversationId);

  // Single source with runAgentLoop's own entry derivation AND
  // entryOrchestration.ts's precomputeOrchestration — see
  // resolveEntryModel.ts's doc for why this is the third (not a fourth,
  // hand-copied) caller of the same pure formula.
  const orchestration = await precomputeOrchestration(
    conversationId,
    userMessage,
    options?.imContext,
    { settings, settingsForModel },
    abortSignal,
  );
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

  const userContent = await buildUserMessageContent(
    conversationId,
    orchestration.route.cleanInput,
    options?.images,
  );
  useChatStore.getState().updateUserMessageRun(conversationId, clientMessageId, {
    state: 'pending',
    content: userContent,
    skill: orchestration.route.type === 'skill' && orchestration.route.skill ? {
      name: orchestration.route.skill.name,
      description: orchestration.route.skill.description,
    } : undefined,
    delegateAgent: orchestration.route.type === 'delegate' && orchestration.route.delegateAgent ? {
      name: orchestration.route.delegateAgent.name,
      description: orchestration.route.delegateAgent.description,
    } : undefined,
  });
  await waitForConversationPersistence(conversationId);
  const conversationSnapshot = getConversationReader().getConversation(conversationId);
  if (!conversationSnapshot) {
    throw new Error(`buildAgentRunParams: conversation "${conversationId}" disappeared before dispatch`);
  }

  // P1-3B-4 — snapshot the shell's userInputQueue for this conversation at
  // dispatch time (projected to the wire-safe shape — id/text/isSystem,
  // dropping the shell-local `timestamp`). See AgentRunParams.queuedInputs's
  // doc above for why this exists.
  const queuedInputs = getQueuedInputs(conversationId).map((qi) => ({
    id: qi.id,
    text: qi.text,
    ...(qi.isSystem ? { isSystem: qi.isSystem } : {}),
  }));

  const payloadDigest = digestRunPayload(JSON.stringify({
    version: 1,
    runId,
    clientMessageId,
    conversationId,
    userMessage,
    options: {
      images: options?.images,
      blockedTools: options?.blockedTools,
      allowedTools: options?.allowedTools,
      imContext: options?.imContext,
    },
  }));

  return {
    runId,
    clientMessageId,
    payloadDigest,
    conversationId,
    userMessage,
    options: {
      images: options?.images,
      blockedTools: options?.blockedTools,
      allowedTools: options?.allowedTools,
      imContext: options?.imContext,
      prePersistedUserMessageId: clientMessageId,
    },
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
 * only and non-empty trimmed text. Attachments cannot be represented by the
 * current text-only mid-run queue, so an attachment send is rejected while
 * preserving the composer draft; it must never start a concurrent run.
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
  const sidecarRunning = getSidecarStatus() === 'running';

  // ── Concurrency guard — see doc above for the two-venue rationale. This
  // runs before venue selection so sidecar-down/fallback callers cannot bypass
  // the same one-live-run-per-conversation invariant.
  {
    const runningConv = getConversationReader().getConversation(conversationId);
    const hasImages = Boolean(options?.images?.length);
    const stageable = userMessage.trim().length > 0 && !hasImages;
    const getBusyError = (): string => hasImages
      ? getI18n().chat.attachmentDuringRun
      : getI18n().chat.conversationBusy;
    const runningSession = findRunSessionForConversation(conversationId);
    if (runningSession?.runId) {
      const interactive = isInteractiveDesktop(options, runningConv);
      if (!interactive || hasImages || !stageable) {
        return { reason: 'error', error: getBusyError() };
      }
      if (stageable) {
        if (options?.requireNewRun) {
          return {
            reason: 'error',
            error: 'A restricted recovery run cannot join an existing agent loop',
          };
        }
        notifySidecar('agent.enqueueInput', { runId: runningSession.runId, userMessage });
        return { reason: 'enqueued' };
      }
    }
    if (runningConv?.status === 'running' && getAbortRegistry().hasAbortController(conversationId)) {
      const interactive = isInteractiveDesktop(options, runningConv);
      if (!interactive || hasImages || !stageable) {
        return { reason: 'error', error: getBusyError() };
      }
      if (stageable) {
        if (options?.requireNewRun) {
          return {
            reason: 'error',
            error: 'A restricted recovery run cannot join an existing agent loop',
          };
        }
        // A live IN-PROCESS run for this conversation — stage into ITS
        // queue via the same real function the in-process guard itself
        // calls (userInputQueue.ts, unchanged).
        enqueueUserInput(conversationId, userMessage);
        return { reason: 'enqueued' };
      }
    }
  }

  if (!sidecarRunning) {
    await ensureBuiltinBrowserRuntime();
    return runAgentLoop(conversationId, userMessage, options);
  }

  ensureHandlersRegistered();

  const runId = generateRunId();
  const clientMessageId = `msg-${runId}`;
  logger.debug('agent-loop path selected', { path: 'sidecar', runId, conversationId });
  const runtimeStartedAt = Date.now();
  startRuntimeRun(runId, 'sidecar', 'local_message_persisting');

  const abortRegistry = getAbortRegistry();
  abortRegistry.clearAbortController(conversationId);
  const shellAbortController = abortRegistry.getAbortController(conversationId);
  const shellChatDelta = getChatDelta();
  useChatStore.getState().addMessage(conversationId, {
    id: clientMessageId,
    clientMessageId,
    runId,
    runState: 'pending',
    role: 'user',
    content: userMessage,
    timestamp: runtimeStartedAt,
    loopId: runId,
  });
  shellChatDelta.setConversationStatus(conversationId, 'running');
  try {
    await waitForConversationPersistence(conversationId);
  } catch (error) {
    const displayMessage = getI18n().chat.messageSaveFailed;
    useChatStore.getState().updateUserMessageRun(conversationId, clientMessageId, {
      state: 'failed',
      error: displayMessage,
    });
    abortRegistry.clearAbortController(conversationId);
    shellChatDelta.setConversationStatus(conversationId, 'error');
    traceRuntimeEvent('renderer.local_message_persist_failed', {
      runId,
      clientMessageId,
      executionPath: 'sidecar',
      stage: 'local_message_persist_failed',
      outcome: 'error',
      errorType: runtimeErrorType(error),
      durationMs: Date.now() - runtimeStartedAt,
    });
    finishRuntimeRun(runId);
    // Let the failed lifecycle replacement attempt settle in the background;
    // execution remains fenced regardless of whether the disk is still down.
    void waitForConversationPersistence(conversationId).catch(() => undefined);
    return { reason: 'error', error: displayMessage };
  }
  markRuntimeRunStage(runId, 'local_message_persisted');
  traceRuntimeEvent('renderer.local_message_persisted', {
    runId,
    clientMessageId,
    executionPath: 'sidecar',
    stage: 'local_message_persisted',
    durationMs: Date.now() - runtimeStartedAt,
  });
  traceRuntimeEvent('renderer.agent_params_build_started', {
    runId,
    executionPath: 'sidecar',
    stage: 'building_params',
  });

  // Skill inline commands execute while the system prompt is precomputed, so
  // the task controller and visible conversation ownership must exist before
  // buildAgentRunParams starts. This closes the rapid double-send window:
  // ChatInput shows Stop, while another textual send is routed into the queue.
  let params: AgentRunParams;
  try {
    // Browser readiness and prompt preparation happen only after the user
    // message is visible and durable, so either operation can fail without
    // making the user's input disappear.
    await ensureBuiltinBrowserRuntime();
    params = await buildAgentRunParams(
      runId,
      clientMessageId,
      conversationId,
      userMessage,
      options,
      shellAbortController.signal,
    );
    markRuntimeRunStage(runId, 'params_built');
    traceRuntimeEvent('renderer.agent_params_build_completed', {
      runId,
      executionPath: 'sidecar',
      stage: 'params_built',
      durationMs: Date.now() - runtimeStartedAt,
    });
  } catch (err) {
    const wasAborted = shellAbortController.signal.aborted;
    if (wasAborted) {
      return finalizePreDispatchInterruptedRun(
        conversationId,
        clientMessageId,
        runId,
        'params_build_aborted',
        runtimeStartedAt,
      );
    }
    abortRegistry.clearAbortController(conversationId);
    shellChatDelta.setConversationStatus(conversationId, 'idle');
    // Failed before any dispatch — pre-commit by construction (see doc).
    logger.warn('agent-loop dispatch params build failed — running in-process', {
      runId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    traceRuntimeEvent('renderer.agent_params_build_failed', {
      runId,
      executionPath: 'sidecar',
      stage: 'fallback_in_process',
      outcome: 'error',
      errorType: runtimeErrorType(err),
      durationMs: Date.now() - runtimeStartedAt,
    });
    finishRuntimeRun(runId);
    return runInProcessWithPersistedMessage(
      conversationId,
      userMessage,
      runId,
      clientMessageId,
      options,
    );
  }
  if (shellAbortController.signal.aborted) {
    return finalizePreDispatchInterruptedRun(
      conversationId,
      clientMessageId,
      runId,
      'before_dispatch',
      runtimeStartedAt,
    );
  }

  // ── Shell-side session + abort wiring ────────────────────────────────
  // The controller above is the SAME controller the UI's existing Stop
  // button already targets via the real AbortRegistry
  // (chatStore.ts's `abortControllers` map), so the Stop button needs ZERO
  // changes (design doc §3's abortRegistry row) — its `.abort()` call fires
  // the listener below, which forwards to the sidecar.
  let resolveTerminal!: (terminal: AgentRunTerminal) => void;
  const terminalPromise = new Promise<AgentRunTerminal>((resolve) => {
    resolveTerminal = resolve;
  });
  const session: RunSession = {
    conversationId,
    loopId: runId, // same id as runId by convention — see agentLoop.ts's AgentLoopOptions.loopId doc.
    clientMessageId,
    userMessageId: clientMessageId,
    payloadDigest: params.payloadDigest,
    options: {
      requestCommandConfirmation: options?.commandConfirmCallback,
      requestFilePermission: options?.filePermissionCallback,
      blockedTools: options?.blockedTools,
      allowedTools: options?.allowedTools,
    },
    shellAbortController,
    transportAbortController: new AbortController(),
    terminalPromise,
    resolveTerminal,
    toolCallToStepId: new Map(),
    committed: false,
    runtimeStartedAt,
    // P1-3B-4 — the entries in `params.queuedInputs` were already seeded
    // into the sidecar's OWN queue at dispatch time (agentLoopHost.ts's
    // handleAgentRun), so pre-mark them forwarded BEFORE registerRunSession
    // installs the live forwarder — otherwise the forwarder would re-send
    // these same still-lingering (not-yet-consumed) shell-queue entries the
    // next time ANY queue mutation fires.
    forwardedQueueIds: new Set(params.queuedInputs?.map((qi) => qi.id)),
  };

  const onShellAbort = (): void => {
    // Once the ordered terminal fact has arrived, the run is already over.
    // A click racing with renderer cleanup must not rewrite that first-wins
    // outcome from completed to aborted.
    if (session.terminal) return;
    void requestSidecarRunAbort(session);
  };
  session.onShellAbort = onShellAbort;
  shellAbortController.signal.addEventListener('abort', onShellAbort, { once: true });

  registerRunSession(runId, session);
  installShellLoopContext(runId, session);
  markRuntimeRunStage(runId, 'waiting_for_first_delta');
  traceRuntimeEvent('renderer.agent_run_dispatched', {
    runId,
    method: 'agent.start',
    executionPath: 'sidecar',
    stage: 'waiting_for_first_delta',
    durationMs: Date.now() - runtimeStartedAt,
  });
  session.firstFrameStallTimer = setTimeout(() => {
    session.firstFrameStallTimer = undefined;
    if (session.firstDeltaAt !== undefined || session.dropFrames) return;
    markRuntimeRunStage(runId, 'stalled_before_first_delta');
    traceRuntimeEvent('renderer.agent_run_stalled', {
      runId,
      method: 'agent.start',
      executionPath: 'sidecar',
      stage: 'stalled_before_first_delta',
      outcome: 'stalled',
      durationMs: Date.now() - runtimeStartedAt,
    });
  }, AGENT_FIRST_FRAME_STALL_MS);
  let handedOffToLocal = false;

  const settleFromTerminal = async (terminal: AgentRunTerminal): Promise<AgentLoopResult> => {
    await settleRunPersistence(session);
    if (session.abortRequested) {
      await finalizeAbortedRun(session, 'run-terminal');
      traceRuntimeEvent('renderer.agent_run_aborted', {
        runId,
        executionPath: 'sidecar',
        stage: 'run_terminal',
        outcome: 'aborted',
        durationMs: Date.now() - runtimeStartedAt,
      });
      return { reason: 'aborted' };
    }

    if (terminal.state === 'failed') {
      const realMessage = terminal.result.error || 'Agent run failed';
      const displayMessage = realMessage === 'Sidecar process closed'
        ? getI18n().chat.sidecarInterrupted
        : realMessage;
      logger.warn('agent loop reported a failed terminal', {
        runId,
        conversationId,
        sidecarCause: realMessage,
        sidecarErrorType: terminal.failure?.errorType,
        sidecarStack: terminal.failure?.stack,
      });
      traceRuntimeEvent('renderer.agent_run_failed', {
        runId,
        executionPath: 'sidecar',
        stage: 'failed_terminal',
        outcome: 'error',
        errorType: terminal.failure?.errorType,
        durationMs: Date.now() - runtimeStartedAt,
      });
      await finalizeFailedRun(session, displayMessage);
      return { reason: 'error', error: realMessage };
    }

    const eventName = terminal.state === 'interrupted'
      ? 'renderer.agent_run_aborted'
      : 'renderer.agent_run_completed';
    traceRuntimeEvent(eventName, {
      runId,
      executionPath: 'sidecar',
      stage: terminal.state === 'interrupted' ? 'interrupted_terminal' : 'completed',
      outcome: terminal.result.reason,
      durationMs: Date.now() - runtimeStartedAt,
      firstFrameMs: session.firstDeltaAt === undefined
        ? undefined
        : session.firstDeltaAt - runtimeStartedAt,
    });
    updateSessionMessageState(
      session,
      terminal.state === 'interrupted' ? 'interrupted' : 'completed',
    );
    await waitForConversationPersistence(conversationId);
    return terminal.result;
  };

  try {
    await establishAgentStart(params, session);
    if (session.terminal) return await settleFromTerminal(session.terminal);

    const rpcOutcome = sidecarRequest(
      'agent.run',
      params,
      0,
      session.transportAbortController!.signal,
    ).then((raw) => ({ source: 'rpc' as const, raw }));
    const terminalOutcome = terminalPromise.then((terminal) => ({ source: 'terminal' as const, terminal }));
    const outcome = await Promise.race([rpcOutcome, terminalOutcome]);

    if (outcome.source === 'terminal') {
      // The terminal notification is the primary completion contract. Close
      // the now-redundant pending RPC so a lost response cannot leave a
      // request entry alive indefinitely.
      if (!session.transportAbortController!.signal.aborted) {
        const terminalReceived = new Error('agent.run terminal received');
        terminalReceived.name = 'AbortError';
        session.transportAbortController!.abort(terminalReceived);
      }
      return await settleFromTerminal(outcome.terminal);
    }

    const raw = outcome.raw;
    if (!isAgentLoopResult(raw)) {
      throw new Error('agent.run response did not match the expected AgentLoopResult shape');
    }
    // The sidecar flushes its coalescer before replying, and the transport
    // preserves byte order. Await the shell-side FIFO plus the store's
    // fire-and-forget JSONL writes before exposing a completed turn.
    await settleRunPersistence(session);
    // A new sidecar always writes agent.terminal before its RPC response.
    // Prefer that first-wins fact if both became observable in the same tick;
    // the raw response remains the compatibility path for older sidecars.
    if (session.terminal) return await settleFromTerminal(session.terminal);
    if (shellAbortController.signal.aborted) {
      await finalizeAbortedRun(session, 'run-terminal');
      traceRuntimeEvent('renderer.agent_run_aborted', {
        runId,
        executionPath: 'sidecar',
        stage: 'run_terminal',
        outcome: 'aborted',
        durationMs: Date.now() - runtimeStartedAt,
      });
      return { reason: 'aborted' };
    }
    traceRuntimeEvent('renderer.agent_run_completed', {
      runId,
      executionPath: 'sidecar',
      stage: 'completed',
      outcome: raw.reason,
      durationMs: Date.now() - runtimeStartedAt,
      firstFrameMs: session.firstDeltaAt === undefined
        ? undefined
        : session.firstDeltaAt - runtimeStartedAt,
    });
    updateSessionMessageState(
      session,
      raw.reason === 'aborted' ? 'interrupted' : raw.reason === 'error' ? 'failed' : 'completed',
      raw.error,
    );
    await waitForConversationPersistence(conversationId);
    return raw;
  } catch (err) {
    let transportError = err;
    // A failing RPC can still have flushed committed frames immediately
    // before its error response. Land those frames before deciding fallback
    // or applying the shell-owned error finalization.
    await settleRunPersistence(session);
    // The RPC may reject after a terminal notification was already received
    // (for example, the response line is lost or the transport closes between
    // the two). The terminal is authoritative even when no delta/tool call
    // marked the run committed, so never fall back and execute it twice.
    if (session.terminal) {
      return await settleFromTerminal(session.terminal);
    }
    if (shellAbortController.signal.aborted) {
      await finalizeAbortedRun(session, 'run-terminal');
      traceRuntimeEvent('renderer.agent_run_aborted', {
        runId,
        executionPath: 'sidecar',
        stage: 'run_terminal_error',
        outcome: 'aborted',
        durationMs: Date.now() - runtimeStartedAt,
      });
      return { reason: 'aborted' };
    }
    if (session.accepted) {
      const recovery = await queryRunForTransportRecovery(params);
      traceRuntimeEvent('renderer.agent_run_recovery_state', {
        runId,
        clientMessageId,
        executionPath: 'sidecar',
        stage: recovery.action,
        replayCount: session.transportReplayCount ?? 0,
      });
      if (recovery.action === 'terminal') {
        handleAgentTerminal(recovery.terminal);
        return await settleFromTerminal(recovery.terminal);
      }
      if (recovery.action === 'reattach') {
        try {
          return await settleFromTerminal(await waitForReattachedTerminal(params, session));
        } catch (reattachError) {
          transportError = reattachError;
        }
      }
      if (
        (recovery.action === 'replay_execution' || recovery.action === 'not_found')
        && !session.committed
        && (session.transportReplayCount ?? 0) < 1
      ) {
        session.transportReplayCount = (session.transportReplayCount ?? 0) + 1;
        try {
          if (recovery.action === 'not_found') {
            session.accepted = false;
            await establishAgentStart(params, session);
          }
          traceRuntimeEvent('renderer.agent_run_transport_replayed', {
            runId,
            clientMessageId,
            executionPath: 'sidecar',
            stage: 'replay_execution',
            replayCount: session.transportReplayCount,
          });
          const replayRpc = sidecarRequest(
            'agent.run',
            params,
            0,
            session.transportAbortController!.signal,
          ).then((raw) => ({ source: 'rpc' as const, raw }));
          const replayTerminal = terminalPromise.then((terminal) => ({ source: 'terminal' as const, terminal }));
          const replayOutcome = await Promise.race([replayRpc, replayTerminal]);
          if (replayOutcome.source === 'terminal') {
            return await settleFromTerminal(replayOutcome.terminal);
          }
          if (!isAgentLoopResult(replayOutcome.raw)) {
            throw new Error('replayed agent.run response did not match the expected result shape', { cause: err });
          }
          await settleRunPersistence(session);
          if (session.terminal) return await settleFromTerminal(session.terminal);
          updateSessionMessageState(
            session,
            replayOutcome.raw.reason === 'aborted'
              ? 'interrupted'
              : replayOutcome.raw.reason === 'error'
                ? 'failed'
                : 'completed',
            replayOutcome.raw.error,
          );
          await waitForConversationPersistence(conversationId);
          return replayOutcome.raw;
        } catch (replayError) {
          transportError = replayError;
        }
      }
    }
    if (!session.committed) {
      // Release the shell-side ownership before entering the in-process loop.
      // Otherwise its concurrency guard sees this still-live controller/session
      // and enqueues the original prompt instead of actually retrying it.
      removeShellLoopContext(runId);
      unregisterRunSession(runId);
      shellAbortController.signal.removeEventListener('abort', onShellAbort);
      abortRegistry.clearAbortController(conversationId);
      shellChatDelta.setConversationStatus(conversationId, 'idle');
      logger.warn('agent-loop transport failed before commit — retrying in-process', {
        runId,
        conversationId,
        error: transportError instanceof Error ? transportError.message : String(transportError),
      });
      traceRuntimeEvent('renderer.agent_run_fallback', {
        runId,
        executionPath: 'sidecar',
        stage: 'fallback_in_process',
        outcome: 'error',
        errorType: runtimeErrorType(transportError),
        durationMs: Date.now() - runtimeStartedAt,
      });
      // The local loop synchronously installs its own AbortController before its
      // first await. Mark the ownership transfer so this dispatch wrapper's
      // finally block cannot delete that replacement controller.
      handedOffToLocal = true;
      return runInProcessWithPersistedMessage(
        conversationId,
        userMessage,
        runId,
        clientMessageId,
        options,
      );
    }
    // Surface the REAL sidecar-side cause: a thrown handler comes back as a
    // generic `-32603 Internal error`, but `errorFromCaught` (sidecar
    // protocol.ts) carries the real message/stack in the error's `data`.
    // Logging only `err.message` (the generic wrapper) threw that away — pull
    // `data` out so the on-disk log names the actual failure.
    const errData = (transportError as { data?: unknown } | null)?.data;
    const realMessage =
      errData && typeof errData === 'object' && 'message' in errData
        ? String((errData as { message: unknown }).message)
        : transportError instanceof Error ? transportError.message : String(transportError);
    const displayMessage =
      realMessage === 'Sidecar process closed'
        ? getI18n().chat.sidecarInterrupted
        : realMessage;
    logger.warn('agent-loop transport failed after commit — surfacing error, no rerun', {
      runId,
      conversationId,
      error: transportError instanceof Error ? transportError.message : String(transportError),
      sidecarCause: realMessage,
      sidecarStack:
        errData && typeof errData === 'object' && 'stack' in errData
          ? String((errData as { stack: unknown }).stack)
          : undefined,
    });
    traceRuntimeEvent('renderer.agent_run_failed', {
      runId,
      executionPath: 'sidecar',
      stage: 'failed_after_commit',
      outcome: 'error',
      errorType: runtimeErrorType(transportError),
      durationMs: Date.now() - runtimeStartedAt,
    });
    // The sidecar loop threw uncaught, so its OWN terminal UI-finalization
    // frames (finishStreaming / setConversationStatus) never arrived — the
    // conversation is left mid-stream and hangs on "thinking". Finalize it
    // here, mirroring the in-process error path (agentLoop.ts:2238/2258), so
    // the UI always leaves the thinking state. Best-effort; all in-flight
    // delta frames were already flushed (sidecar handleAgentRun's finally
    // runs coalescer.flush() before the error propagates), so this runs after
    // them, not racing.
    const isConnectionFailure = realMessage === 'Sidecar process closed'
      || realMessage.startsWith('Sidecar event channel');
    await finalizeFailedRun(
      session,
      displayMessage,
      isConnectionFailure ? 'connection-failed' : 'failed',
    );
    return { reason: 'error', error: realMessage };
  } finally {
    if (session.firstFrameStallTimer) clearTimeout(session.firstFrameStallTimer);
    finishRuntimeRun(runId);
    removeShellLoopContext(runId);
    unregisterRunSession(runId);
    shellAbortController.signal.removeEventListener('abort', onShellAbort);
    if (!handedOffToLocal) {
      abortRegistry.clearAbortController(conversationId);
    }
  }
}
