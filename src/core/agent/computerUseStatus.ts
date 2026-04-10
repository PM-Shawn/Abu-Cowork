/**
 * Computer Use session state — module-level reactive store.
 *
 * Used by toolExecutor to signal state changes, consumed by
 * ComputerUseStatusBar via useSyncExternalStore.
 *
 * Not a Zustand store because it bridges core/ and components/ without persistence.
 */

export type CUSessionStatus = 'idle' | 'active' | 'paused';

/** Max steps per CU session before auto-stop */
const MAX_CU_STEPS = 30;
/** Max duration per CU session (ms) */
const MAX_CU_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export interface CUState {
  status: CUSessionStatus;
  stepCount: number;
  currentAction: string | null;
  latestScreenshot: string | null; // base64
  activeConversationId: string | null; // for abort targeting
  /** Whether Abu window is hidden and border/stop-btn are shown (session-level, survives across batches) */
  sessionWindowHidden: boolean;
  /** Session start timestamp for timeout check */
  sessionStartTime: number | null;
}

let state: CUState = {
  status: 'idle',
  stepCount: 0,
  currentAction: null,
  latestScreenshot: null,
  activeConversationId: null,
  sessionWindowHidden: false,
  sessionStartTime: null,
};

const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function update(partial: Partial<CUState>) {
  state = { ...state, ...partial };
  notify();
}

// ─── Actions (called by toolExecutor) ───

/** Enter Computer Use session. */
export function setComputerUseActive(active: boolean, conversationId?: string) {
  if (active) {
    update({ status: 'active', stepCount: 0, currentAction: null, latestScreenshot: null, activeConversationId: conversationId ?? null, sessionStartTime: Date.now() });
    setupAbortListener();
  } else {
    const wasHidden = state.sessionWindowHidden;
    update({ status: 'idle', stepCount: 0, currentAction: null, latestScreenshot: null, activeConversationId: null, sessionWindowHidden: false, sessionStartTime: null });
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

/** Increment step count and optionally set current action description. */
export function incrementComputerUseStep(action?: string) {
  if (state.status === 'active') {
    const newStep = state.stepCount + 1;
    update({ stepCount: newStep, currentAction: action ?? null });
    // Push status to overlay window for display
    emitStatusToOverlay(newStep, action ?? null);
  }
}

/** Emit current step/action to the overlay window for display. */
function emitStatusToOverlay(step: number, action: string | null) {
  import('@tauri-apps/api/event').then(({ emit }) => {
    emit('computer-use-status', { step, action }).catch(() => {});
  }).catch(() => {});
}

/** Update the latest screenshot for live preview. */
export function updateLatestScreenshot(base64: string) {
  if (state.status === 'active') {
    update({ latestScreenshot: base64 });
  }
}

/** Mark that the window has been hidden for this CU session. */
export function setSessionWindowHidden(hidden: boolean) {
  update({ sessionWindowHidden: hidden });
}

/** Check if window is already hidden for this session (avoid re-hiding across batches). */
export function isSessionWindowHidden(): boolean {
  return state.sessionWindowHidden;
}

/**
 * Check if the CU session has exceeded step or time limits.
 * Returns error message if exceeded, null if OK.
 */
export function checkCUSessionLimits(): string | null {
  if (state.status !== 'active') return null;

  if (state.stepCount >= MAX_CU_STEPS) {
    return `Computer Use 操作已达上限（${MAX_CU_STEPS} 步）。请向用户汇报当前进度和结果，询问是否继续。`;
  }

  if (state.sessionStartTime && Date.now() - state.sessionStartTime > MAX_CU_DURATION_MS) {
    return `Computer Use 操作已超时（${MAX_CU_DURATION_MS / 60000} 分钟）。请向用户汇报当前进度和结果。`;
  }

  return null;
}

/** Set current action description. */
export function setCurrentAction(action: string | null) {
  update({ currentAction: action });
}

// ─── Stop button abort listener + global shortcut ───

let abortUnlisten: (() => void) | null = null;
let shortcutRegistered = false;

function triggerAbort() {
  const convId = state.activeConversationId;
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
  return state;
}
