/**
 * Computer Use session state — module-level reactive store.
 *
 * Used by toolExecutor to signal state changes, consumed by FloatingConsole
 * and ComputerUseStatusBar via useSyncExternalStore.
 *
 * Not a Zustand store because it bridges core/ and components/ without persistence.
 */

export type CUSessionStatus = 'idle' | 'active' | 'paused';

export interface CUState {
  status: CUSessionStatus;
  stepCount: number;
  currentAction: string | null;
  latestScreenshot: string | null; // base64
  isFloating: boolean;
}

let state: CUState = {
  status: 'idle',
  stepCount: 0,
  currentAction: null,
  latestScreenshot: null,
  isFloating: false,
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
export function setComputerUseActive(active: boolean) {
  if (active) {
    update({ status: 'active', stepCount: 0, currentAction: null, latestScreenshot: null });
  } else {
    update({ status: 'idle', stepCount: 0, currentAction: null, isFloating: false });
  }
}

/** Increment step count and optionally set current action description. */
export function incrementComputerUseStep(action?: string) {
  if (state.status === 'active') {
    update({ stepCount: state.stepCount + 1, currentAction: action ?? null });
  }
}

/** Update the latest screenshot for live preview. */
export function updateLatestScreenshot(base64: string) {
  if (state.status === 'active') {
    update({ latestScreenshot: base64 });
  }
}

/** Mark floating mode on/off. */
export function setFloatingMode(floating: boolean) {
  update({ isFloating: floating });
}

/** Set current action description. */
export function setCurrentAction(action: string | null) {
  update({ currentAction: action });
}

// ─── React integration (useSyncExternalStore) ───

export function subscribeCUStatus(callback: () => void) {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function getCUStatusSnapshot(): CUState {
  return state;
}
