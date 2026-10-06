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
  toasts: Toast[];
}

interface ToastActions {
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export type ToastStore = ToastState & ToastActions;

// The list shows the first this-many toasts; the rest wait their turn, oldest first.
export const MAX_VISIBLE_TOASTS = 3;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

// How long each toast stays once it is shown (0 = until dismissed), and the running timers.
// A toast's time starts when it enters the shown ones, so none expires without having been
// on screen for its full duration.
const toastDurations = new Map<string, number>();
const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastStore>()(
  immer((set, get) => {
    const drop = (id: string) => {
      const timeoutId = toastTimeouts.get(id);
      if (timeoutId) clearTimeout(timeoutId);
      toastTimeouts.delete(id);
      toastDurations.delete(id);
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id);
      });
      startShown();
    };

    // Start the time of every shown toast that has not started yet.
    const startShown = () => {
      for (const { id } of get().toasts.slice(0, MAX_VISIBLE_TOASTS)) {
        const duration = toastDurations.get(id) ?? 0;
        if (duration <= 0 || toastTimeouts.has(id)) continue;
        toastTimeouts.set(id, setTimeout(() => drop(id), duration));
      }
    };

    return {
      toasts: [],

      addToast: (toast) => {
        const id = generateId();
        // Actionable toasts get longer duration by default
        toastDurations.set(id, toast.duration ?? (toast.actions ? 10000 : 3000));
        set((state) => {
          state.toasts.push({ ...toast, id });
        });
        startShown();
      },

      removeToast: drop,
    };
  }),
);
