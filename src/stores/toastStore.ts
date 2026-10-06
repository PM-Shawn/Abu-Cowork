import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
  duration?: number;
  actions?: ToastAction[];
}

interface ToastState {
  // Oldest first; the last `places` of them are on screen.
  toasts: Toast[];
  // How many toasts the list shows at once.
  places: number;
}

interface ToastActions {
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
  setPlaces: (places: number) => void;
}

export type ToastStore = ToastState & ToastActions;

// The list shows the newest toasts: three, and one while the user is asked to decide something
// (an approval, a question): no toast may lie over the buttons that answer.
export const MAX_VISIBLE_TOASTS = 3;
export const VISIBLE_TOASTS_BESIDE_DECISION = 1;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

// Two properties together: a new toast is on screen at once, and no toast ends without having
// been on screen for its full duration. A toast pushed out by newer ones stays in the list with
// its clock stopped and returns, with the time it had left, when a place frees: the last one
// pushed out first. `duration` 0 means until dismissed; such a toast is pushed out and returns
// like any other, so it never blocks the list.
// A toast that returns stays at least this long, so one that was pushed out with a moment left
// does not flash. Only this floor can add to a toast's time on screen beyond its duration.
export const MIN_RETURN_MS = 1000;

interface Clock {
  // 0 = until dismissed.
  duration: number;
  remaining: number;
  startedAt: number;
  // It has been on screen before: the next time it comes on screen it returns.
  shownBefore: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}
const clocks = new Map<string, Clock>();

// Time that only moves forward: the time of day can be set back while a toast is on screen.
const monotonicNow = () => performance.now();

const labels = (toast: Omit<Toast, 'id'>) => (toast.actions ?? []).map((action) => action.label).join('\u0000');
// The same thing said again: adding it shows the one that is there, it does not add another.
const equal = (a: Omit<Toast, 'id'>, b: Omit<Toast, 'id'>) => a.type === b.type && a.title === b.title && a.message === b.message && labels(a) === labels(b);

export const useToastStore = create<ToastStore>()(
  immer((set, get) => {
    // Run the clock of every toast on screen and stop the clock of every toast that is not.
    const syncClocks = () => {
      const { toasts, places } = get();
      const shown = new Set(toasts.slice(-places).map((toast) => toast.id));
      const now = monotonicNow();
      for (const { id } of toasts) {
        const clock = clocks.get(id);
        if (!clock || clock.duration <= 0) continue;
        if (shown.has(id)) {
          if (clock.timeout !== null) continue;
          clock.startedAt = now;
          clock.timeout = setTimeout(() => drop(id), clock.shownBefore ? Math.max(clock.remaining, MIN_RETURN_MS) : clock.remaining);
          clock.shownBefore = true;
        } else if (clock.timeout !== null) {
          clearTimeout(clock.timeout);
          clock.timeout = null;
          clock.remaining = Math.min(clock.duration, Math.max(0, clock.remaining - (now - clock.startedAt)));
        }
      }
    };

    const stopClock = (id: string) => {
      const clock = clocks.get(id);
      if (clock?.timeout) clearTimeout(clock.timeout);
      clocks.delete(id);
    };

    const drop = (id: string) => {
      stopClock(id);
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id);
      });
      syncClocks();
    };

    return {
      toasts: [],
      places: MAX_VISIBLE_TOASTS,

      addToast: (toast) => {
        // An equal toast that is showing or waiting comes on screen as the newest, with its full time again.
        const id = get().toasts.find((existing) => equal(existing, toast))?.id ?? generateId();
        // Actionable toasts get longer duration by default
        const duration = toast.duration ?? (toast.actions ? 10000 : 3000);
        stopClock(id);
        clocks.set(id, { duration, remaining: duration, startedAt: 0, shownBefore: false, timeout: null });
        set((state) => {
          state.toasts = state.toasts.filter((t) => t.id !== id);
          state.toasts.push({ ...toast, id });
        });
        syncClocks();
      },

      removeToast: drop,

      setPlaces: (places) => {
        if (places === get().places) return;
        set({ places });
        syncClocks();
      },
    };
  }),
);

// For the layer provider's `onDecisionChange`.
export function setToastPlacesForDecision(decisionAsked: boolean): void {
  useToastStore.getState().setPlaces(decisionAsked ? VISIBLE_TOASTS_BESIDE_DECISION : MAX_VISIBLE_TOASTS);
}
