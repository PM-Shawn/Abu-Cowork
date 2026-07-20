/**
 * Shell-side channel handler module for the main agent loop's sidecar run —
 * the main-loop twin of `subagentRunner.ts` (P1-3a). This batch (P1-3b-2,
 * design doc §5 "3b-2 信道件") is CHANNEL PLUMBING ONLY: run-session
 * registry, reverse-channel handlers, shell→sidecar push emitters, and the
 * shell-side LoopContext/EventRouter construction seam. NO `agent.run`
 * dispatch, no selector, no caller changes — that's 3b-3 (design doc §5
 * "3b-3 入驻"). Every export here is DORMANT: nothing calls
 * `ensureHandlersRegistered()` yet (no production code path constructs a
 * `RunSession` this batch), so this module has zero effect on any existing
 * run until 3b-3 wires it up.
 *
 * See docs/2026-07-20-phase1-p3b-loop-entry-design.md §4 for the wire
 * protocol this implements (the sidecar→shell half — `agent.delta` /
 * `approval.drain` / `plan.clear` / `caps.record` / `shell.notifyTask` /
 * `cu.setState` / `native.invoke` / `tool.list` /
 * `session.isMessageWrittenToDisk`) and the shell→sidecar push half
 * (`state.settings` / `state.convPatch` / `state.planMode`).
 */
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import {
  onSidecarNotification,
  onSidecarRequest,
  notifySidecar,
  SidecarRequestError,
} from '../sidecar/sidecarManager';
import { applyDeltaFrames, type PortFrame } from './frameApplier';
import { getExecutionPort } from './ports/executionPort';
import { getChatDelta } from './ports/chatDelta';
import { getScratchpadPort } from './ports/scratchpadPort';
import { getCapsPort } from './ports/capsPort';
import { getToolInvoker } from './ports/toolInvoker';
import { getSettingsReader } from './ports/settingsReader';
import { toSerializableTool } from './subagentRunner';
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
import { clearPlanMode, onPlanModeChange } from './planMode';
import {
  setComputerUseActive,
  setCurrentAction,
  incrementComputerUseStep,
  pauseComputerUseStatus,
  setSessionWindowHidden,
} from './computerUseStatus';
import { setComputerUseBatchMode, setSkipAutoScreenshot } from '../tools/builtins';
import { notifyTaskCompleted, notifyTaskError } from '../../utils/notifications';
import { useSettingsStore } from '../../stores/settingsStore';
import { useChatStore } from '../../stores/chatStore';
import { getLocale } from '../../i18n';
import { createLogger } from '../logging/logger';

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
}

const sessions = new Map<string, RunSession>();

/** Register a run session — exported for 3b-3 (the `agent.run` dispatch path) and this batch's own tests. Idempotent overwrite (a second register for the same runId replaces the first). Installs the push emitters on the FIRST registration. */
export function registerRunSession(runId: string, session: RunSession): void {
  sessions.set(runId, session);
  installPushEmitters();
}

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
 * P1-3B-2-REPORT.md's inventory). Not listed → fail-closed
 * `SidecarRequestError`, never silently forwarded.
 */
const NATIVE_INVOKE_ALLOWLIST: ReadonlySet<string> = new Set([
  'show_screen_border',
  'get_active_window',
  'window_hide',
  'activate_app',
  'run_shell_command',
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

let handlersRegistered = false;

/** Idempotent — registers every reverse-channel handler exactly once, no matter how many times it's called. Mirrors subagentRunner.ts's ensureHandlersRegistered() shape. */
export function ensureHandlersRegistered(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  onSidecarNotification('agent.delta', handleAgentDelta);
  onSidecarNotification('approval.drain', handleApprovalDrain);
  onSidecarNotification('plan.clear', handlePlanClear);
  onSidecarNotification('caps.record', handleCapsRecord);
  onSidecarNotification('shell.notifyTask', handleShellNotifyTask);
  onSidecarNotification('cu.setState', handleCuSetState);

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
    notifySidecar('state.convPatch', { conversationId: session.conversationId, patch });
  }
}

let planModeUnsub: (() => void) | undefined;

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
  planModeUnsub = onPlanModeChange((conversationId, mode) => {
    notifySidecar('state.planMode', { conversationId, mode });
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
  planModeUnsub?.();
  planModeUnsub = undefined;
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
