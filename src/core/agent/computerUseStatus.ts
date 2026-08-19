/**
 * Computer Use session state — per-conversation reactive store.
 *
 * Used by toolExecutor to signal state changes, consumed by
 * ComputerUseStatusBar via useSyncExternalStore.
 *
 * Not a Zustand store because it bridges core/ and components/ without persistence.
 *
 * ── Why this is keyed by conversationId (it used to be one shared object) ──
 * This module used to hold a single module-level `state: CUState` shared by
 * every conversation. Abu's agent loop allows DIFFERENT conversations to run
 * concurrently — `runAgentLoop`'s concurrency guard (agentLoop.ts) only
 * blocks a SECOND loop on the SAME conversation, not a second conversation
 * running in parallel (e.g. a background scheduled task while the user
 * chats elsewhere) — and the sidecar's `cu.setState` RPC notification
 * (agentLoopRunner.ts's `CU_SET_STATE_ACTIONS`) is dispatched into this
 * module with no ownership check against who's currently "active". So
 * conversation B starting or ending a Computer Use session could silently
 * stomp conversation A's still-active session: A's step-limit/timeout
 * bookkeeping (`checkCUSessionLimits`) would be corrupted by B's unrelated
 * activity, and the physical Stop button/shortcut (`triggerAbort`, keyed off
 * a single `activeConversationId`) could abort the WRONG conversation.
 *
 * Fix scope: this module now keys session state by conversationId and adds
 * an ownership guard on `setComputerUseActive(false, id)` — a stale/late
 * deactivate from a conversation that is no longer the current owner can no
 * longer clobber whichever conversation legitimately owns the active session
 * now. That was the concrete, reproducible contamination bug (every
 * `setComputerUseActive(false)` call site in this codebase already had a
 * conversationId in scope but wasn't passing it — see the call sites in
 * agentLoop.ts/chatStore.ts).
 *
 * What this does NOT attempt: true parallel per-conversation CU tracking.
 * Computer Use drives the one real mouse/screen, so at most one session is
 * ever genuinely "active"; the six other setters forwarded verbatim over
 * `cu.setState` (see sidecar/src/shims/computerUseStatusRun.ts) don't carry
 * a conversationId on the wire at all, so they resolve against whichever
 * conversation currently owns the active session. Giving them real
 * per-conversation identity would need a wire-protocol change (out of this
 * fix's scope — flag as a follow-up if genuine concurrent CU tracking is
 * ever needed).
 */

import { getI18n, format } from '@/i18n';

export type CUSessionStatus = 'idle' | 'active' | 'paused';
export type CUPhase = 'checking' | 'observing' | 'acting' | 'verifying' | 'blocked';
export type CUCapabilityMode = 'full' | 'structured' | 'unsupported' | 'unknown';

/** Max steps per CU session before auto-stop */
const MAX_CU_STEPS = 30;
/** Max duration per CU session (ms) */
const MAX_CU_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export interface CUState {
  status: CUSessionStatus;
  stepCount: number;
  currentAction: string | null;
  phase: CUPhase;
  targetApp: string | null;
  capabilityMode: CUCapabilityMode | null;
  latestScreenshot: string | null; // base64
  activeConversationId: string | null; // for abort targeting
  /** Whether Abu window is hidden and border/stop-btn are shown (session-level, survives across batches) */
  sessionWindowHidden: boolean;
  /** Session start timestamp for timeout check */
  sessionStartTime: number | null;
}

/** Stable idle snapshot — returned by `getCUStatusSnapshot()` whenever no
 *  conversation owns an active session. Kept as one constant reference (not
 *  freshly constructed per call) because `useSyncExternalStore` requires a
 *  referentially stable snapshot when nothing changed, or React can loop. */
const IDLE_STATE: CUState = {
  status: 'idle',
  stepCount: 0,
  currentAction: null,
  phase: 'checking',
  targetApp: null,
  capabilityMode: null,
  latestScreenshot: null,
  activeConversationId: null,
  sessionWindowHidden: false,
  sessionStartTime: null,
};

/** Per-conversation session table — see module doc for why this exists. */
const sessions = new Map<string, CUState>();
/**
 * Whether the Abu window is currently hidden (and the screen border / Stop
 * overlay shown) for a Computer Use session.
 *
 * Deliberately NOT per-conversation: there is exactly ONE real OS window, and
 * `toolExecutor.ts` sets this BEFORE any owner exists —
 *
 *   if (hasInteractiveAction && !isSessionWindowHidden()) { …hide…; setSessionWindowHidden(true); }
 *   setComputerUseActive(true, conversationId);
 *
 * — so a value stored only inside the per-conversation `CUState` would be
 * written to a nonexistent owner (silent no-op) and then overwritten by the
 * fresh state `setComputerUseActive(true, …)` builds. That made `wasHidden`
 * permanently false at teardown, so `window_show`/`hide_screen_border` never
 * ran on natural loop completion: the app window stayed hidden and the red
 * border + Stop button stayed on screen. Keeping the flag module-level
 * restores the pre-Map behavior (the old singleton's `update({status:'active',…})`
 * partial simply never touched `sessionWindowHidden`) and matches the
 * sidecar shim's own global mirror (`sidecar/src/shims/computerUseStatusRun.ts`).
 * `CUState.sessionWindowHidden` is kept as a UI-visible mirror of this flag.
 */
let windowHiddenForCU = false;
/** The conversation that currently owns the (at most one) active session, or
 *  null when idle. The six parameterless setters below — forwarded 1:1 over
 *  `cu.setState` with no conversationId argument — resolve against this. */
let activeConversationId: string | null = null;

const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** The current owner's CUState, or undefined when idle. */
function getActive(): CUState | undefined {
  return activeConversationId ? sessions.get(activeConversationId) : undefined;
}

/** Merge a partial update into the current owner's state. No-ops (does NOT
 *  create a phantom entry) when there is no active owner — matches the old
 *  singleton's behavior where these setters were harmless no-ops on idle
 *  state, since the UI never renders anything for `status !== 'active'`. */
function updateActive(partial: Partial<CUState>) {
  if (!activeConversationId) return;
  const current = sessions.get(activeConversationId);
  if (!current) return;
  sessions.set(activeConversationId, { ...current, ...partial });
  notify();
}

// ─── Actions (called by toolExecutor) ───

/** Enter Computer Use session for `conversationId`, or (when `active` is
 *  false) end the CURRENT owner's session. */
export function setComputerUseActive(active: boolean, conversationId?: string) {
  if (active) {
    // Every real call site passes a conversationId (toolExecutor.ts); the
    // fallback below only guards against a hypothetical caller that doesn't,
    // so activation never silently no-ops.
    const id = conversationId ?? 'unknown';
    // ── Budget continuity across batches (RB-04) ──
    // toolExecutor calls this at the top of EVERY computer batch, and one CU
    // task normally spans many. Rebuilding the row unconditionally reset
    // `stepCount` to 0 and `sessionStartTime` to now, so the 30-step /
    // 5-minute caps restarted each batch and the displayed step count fell
    // back to 1 mid-task. Re-entry by the SAME owner is a continuation:
    // carry the budget. A different conversation taking over is a genuinely
    // new session and still starts at zero.
    //
    // The renderer is a MIRROR of this budget, not its enforcer — the
    // authoritative counter lives on the host task lease
    // (electron/computerUseGate.cjs, `taskBudgets`), which the renderer
    // cannot reach around. Keeping this side honest matters for what the
    // user is shown, and so the two never disagree.
    const previous = id === activeConversationId ? sessions.get(id) : undefined;
    activeConversationId = id;
    sessions.set(id, {
      status: 'active',
      stepCount: previous?.stepCount ?? 0,
      currentAction: null,
      phase: 'checking',
      targetApp: null,
      capabilityMode: null,
      latestScreenshot: null,
      activeConversationId: id,
      // Mirror the module-level flag — NEVER hardcode false here: the window
      // may already be hidden by this same batch (see `windowHiddenForCU`).
      sessionWindowHidden: windowHiddenForCU,
      sessionStartTime: previous?.sessionStartTime ?? Date.now(),
    });
    notify();
    setupAbortListener();
  } else {
    // ── Ownership guard — the actual contamination fix ──
    // `conversationId === undefined` means a caller couldn't be threaded
    // with an id; trust it and clear whatever is active rather than leaving
    // a possibly-stuck CU overlay forever un-clearable (fail OPEN, not
    // closed, for THIS specific case — every caller in this codebase does
    // pass an id today, so this branch should be dead in practice). But a
    // caller that DOES pass an id that isn't the current owner is a stale or
    // late deactivate from a conversation that already lost ownership —
    // ignore it instead of tearing down whoever owns the session now.
    if (conversationId !== undefined && conversationId !== activeConversationId) {
      // Still REAP the stale conversation's row — it lost ownership when a
      // later conversation activated, so nothing else would ever delete it
      // and its retained `latestScreenshot` (base64 PNG) would leak for the
      // lifetime of the process. Ownership state is untouched.
      sessions.delete(conversationId);
      return;
    }
    const owner = activeConversationId;
    const wasHidden = windowHiddenForCU;
    windowHiddenForCU = false;
    if (owner) sessions.delete(owner);
    activeConversationId = null;
    notify();
    cleanupAbortListener();
    // Session-level cleanup: restore window and hide overlay
    if (wasHidden) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('window_show').catch(() => {});
        invoke('hide_screen_border').catch(() => {});
      }).catch(() => {});
    }
  }
}

/** Pause the CU status bar without ending the session.
 *  Called when a non-computer tool batch starts so the "正在操控电脑" banner
 *  disappears, but the session (window hidden state) is preserved for
 *  potential future computer batches in the same agent loop. */
export function pauseComputerUseStatus() {
  const current = getActive();
  if (current?.status === 'active') {
    updateActive({ status: 'paused', currentAction: null });
  }
}

/** Increment step count and optionally set current action description. */
export function incrementComputerUseStep(action?: string) {
  const current = getActive();
  if (current?.status === 'active') {
    const newStep = current.stepCount + 1;
    updateActive({ stepCount: newStep, currentAction: action ?? null });
    // Push status to overlay window for display
    emitStatusToOverlay(newStep, action ?? null);
  }
}

/** Emit current step/action to the overlay window for display. */
function emitStatusToOverlay(step: number, action: string | null) {
  // Resolve the localized step label here (frontend has the UI locale) and push
  // it to the overlay HTML, which is a dumb view outside the React i18n tree.
  const stepLabel = format(getI18n().computerUse.overlayStep, { step });
  import('@tauri-apps/api/event').then(({ emit }) => {
    emit('computer-use-status', { step, action, stepLabel }).catch(() => {});
  }).catch(() => {});
}

/** Update the latest screenshot for live preview. */
export function updateLatestScreenshot(base64: string) {
  const current = getActive();
  if (current?.status === 'active') {
    updateActive({ latestScreenshot: base64 });
  }
}

/** Mark that the window has been hidden for this CU session. Writes the
 *  module-level flag (the window is one global resource, and this is called
 *  before an owner exists — see `windowHiddenForCU`), then mirrors it into
 *  the owner's state for the UI when there is one. */
export function setSessionWindowHidden(hidden: boolean) {
  windowHiddenForCU = hidden;
  updateActive({ sessionWindowHidden: hidden });
}

/** Check if window is already hidden for this session (avoid re-hiding across batches). */
export function isSessionWindowHidden(): boolean {
  return windowHiddenForCU;
}

/**
 * Check if the CU session has exceeded step or time limits.
 * Returns error message if exceeded, null if OK.
 */
export function checkCUSessionLimits(): string | null {
  const current = getActive();
  if (!current || current.status !== 'active') return null;

  if (current.stepCount >= MAX_CU_STEPS) {
    return `Computer Use 操作已达上限（${MAX_CU_STEPS} 步）。请向用户汇报当前进度和结果，询问是否继续。`;
  }

  if (current.sessionStartTime && Date.now() - current.sessionStartTime > MAX_CU_DURATION_MS) {
    return `Computer Use 操作已超时（${MAX_CU_DURATION_MS / 60000} 分钟）。请向用户汇报当前进度和结果。`;
  }

  return null;
}

/** Set current action description. */
export function setCurrentAction(action: string | null) {
  updateActive({ currentAction: action });
}

/** Product-facing Computer Use phase; carries no prompt, AX label, or typed text. */
export function setComputerUsePhase(phase: CUPhase) {
  const current = getActive();
  if (current?.status === 'active') updateActive({ phase });
}

/** Set safe structural context shown in the status bar. */
export function setComputerUseContext(input: {
  targetApp?: string | null;
  capabilityMode?: CUCapabilityMode | null;
}) {
  const current = getActive();
  if (!current || current.status !== 'active') return;
  updateActive({
    ...(input.targetApp !== undefined ? { targetApp: input.targetApp } : {}),
    ...(input.capabilityMode !== undefined ? { capabilityMode: input.capabilityMode } : {}),
  });
}

// ─── Stop button abort listener + global shortcut ───

let abortUnlisten: (() => void) | null = null;
let shortcutRegistered = false;

function triggerAbort() {
  const convId = activeConversationId;
  if (convId) {
    import('../../stores/chatStore').then(({ useChatStore }) => {
      useChatStore.getState().cancelStreaming(convId);
    }).catch(() => {});
  }
}

async function setupAbortListener() {
  if (abortUnlisten) return;

  // 1. Listen for stop button click event from overlay window
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen('computer-use-abort', triggerAbort);
    abortUnlisten = unlisten;
  } catch { /* ignore — event API unavailable */ }

  // 2. Register global shortcut Cmd+. (macOS) / Ctrl+. (Windows)
  if (!shortcutRegistered) {
    try {
      const { register } = await import('@tauri-apps/plugin-global-shortcut');
      await register('CommandOrControl+.', triggerAbort);
      shortcutRegistered = true;
    } catch { /* ignore — plugin unavailable or shortcut conflict */ }
  }
}

function cleanupAbortListener() {
  if (abortUnlisten) {
    abortUnlisten();
    abortUnlisten = null;
  }
  if (shortcutRegistered) {
    import('@tauri-apps/plugin-global-shortcut').then(({ unregister }) => {
      unregister('CommandOrControl+.').catch(() => {});
    }).catch(() => {});
    shortcutRegistered = false;
  }
}

// ─── React integration (useSyncExternalStore) ───

export function subscribeCUStatus(callback: () => void) {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function getCUStatusSnapshot(): CUState {
  return getActive() ?? IDLE_STATE;
}
