import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type WorkProcessFoldMode = 'auto' | 'expanded' | 'collapsed';

export interface WorkProcessFoldEntry {
  key: string;
  conversationId: string;
  mode: WorkProcessFoldMode;
  autoCollapseHandled: boolean;
  accessTick: number;
}

interface WorkProcessFoldState {
  entries: Record<string, WorkProcessFoldEntry>;
  accessClock: number;
}

interface WorkProcessFoldActions {
  touch: (conversationId: string, key: string) => void;
  pruneToLimit: () => void;
  setMode: (conversationId: string, key: string, mode: WorkProcessFoldMode) => void;
  markAutoCollapsed: (conversationId: string, key: string) => void;
  clearConversation: (conversationId: string) => void;
  reset: () => void;
}

export const WORK_PROCESS_FOLD_MAX_ENTRIES = 256;

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

export function makeWorkProcessFoldKey(
  conversationId: string,
  loopId: string | undefined,
  leadingUserMessageId: string | undefined,
  firstAssistantMessageId: string | undefined,
): string {
  const stableId = loopId ?? leadingUserMessageId ?? firstAssistantMessageId ?? '__unknown__';
  return `v1:${encodePart(conversationId)}:${encodePart(stableId)}`;
}

function ensureEntry(
  state: WorkProcessFoldState,
  conversationId: string,
  key: string,
): WorkProcessFoldEntry {
  state.accessClock++;
  state.entries[key] ??= {
    key,
    conversationId,
    mode: 'auto',
    autoCollapseHandled: false,
    accessTick: state.accessClock,
  };
  state.entries[key].accessTick = state.accessClock;
  return state.entries[key];
}

function trimLru(state: WorkProcessFoldState): void {
  const entries = Object.entries(state.entries);
  if (entries.length <= WORK_PROCESS_FOLD_MAX_ENTRIES) return;
  entries
    .sort(([aKey, a], [bKey, b]) => a.accessTick - b.accessTick || aKey.localeCompare(bKey))
    .slice(0, entries.length - WORK_PROCESS_FOLD_MAX_ENTRIES)
    .forEach(([key]) => { delete state.entries[key]; });
}

export const useWorkProcessFoldStore = create<WorkProcessFoldState & WorkProcessFoldActions>()(
  immer((set) => ({
    entries: {},
    accessClock: 0,

    touch: (conversationId, key) => {
      set((state) => {
        ensureEntry(state, conversationId, key);
        trimLru(state);
      });
    },

    pruneToLimit: () => {
      set((state) => {
        trimLru(state);
      });
    },

    setMode: (conversationId, key, mode) => {
      set((state) => {
        const entry = ensureEntry(state, conversationId, key);
        entry.mode = mode;
        if (mode === 'auto') entry.autoCollapseHandled = false;
        trimLru(state);
      });
    },

    markAutoCollapsed: (conversationId, key) => {
      set((state) => {
        const entry = ensureEntry(state, conversationId, key);
        if (entry.mode !== 'auto') return;
        entry.autoCollapseHandled = true;
        trimLru(state);
      });
    },

    clearConversation: (conversationId) => {
      set((state) => {
        for (const [key, entry] of Object.entries(state.entries)) {
          if (entry.conversationId === conversationId) delete state.entries[key];
        }
      });
    },

    reset: () => {
      set((state) => {
        state.entries = {};
        state.accessClock = 0;
      });
    },
  })),
);
