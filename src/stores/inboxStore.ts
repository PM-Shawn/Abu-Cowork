import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { InboxItem, InboxItemType } from '../types/todo';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

let _lastTs = 0;
function monotonicNow(): number {
  const now = Date.now();
  _lastTs = now > _lastTs ? now : _lastTs + 1;
  return _lastTs;
}

interface AddItemInput {
  type: InboxItemType;
  summary: string;
  conversationId?: string;
  todoId?: string;
  payload?: Record<string, unknown>;
}

interface InboxState {
  items: Record<string, InboxItem>;
}

interface InboxActions {
  addItem: (input: AddItemInput) => string;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** Soft-process: mark accepted, keep in history */
  accept: (id: string) => void;
  /** Soft-process: mark ignored, keep in history */
  ignore: (id: string) => void;
  /** Hard delete (used to permanently remove a historical item) */
  dismiss: (id: string) => void;
  getAll: () => InboxItem[];
  getUnreadCount: () => number;
  /** Count items still requiring user decision (status === 'pending') */
  getPendingCount: () => number;
}

export type InboxStore = InboxState & InboxActions;

export const useInboxStore = create<InboxStore>()(
  persist(
    immer((set, get) => ({
      items: {},

      addItem: (input) => {
        const id = generateId();
        set((state) => {
          state.items[id] = {
            id,
            type: input.type,
            summary: input.summary,
            conversationId: input.conversationId,
            todoId: input.todoId,
            payload: input.payload,
            unread: true,
            status: 'pending',
            createdAt: monotonicNow(),
          };
        });
        return id;
      },

      markRead: (id) => {
        set((state) => {
          const item = state.items[id];
          if (item) item.unread = false;
        });
      },

      markAllRead: () => {
        set((state) => {
          for (const item of Object.values(state.items)) {
            item.unread = false;
          }
        });
      },

      accept: (id) => {
        set((state) => {
          const item = state.items[id];
          if (!item) return;
          item.status = 'accepted';
          item.processedAt = Date.now();
          item.unread = false;
        });
      },

      ignore: (id) => {
        set((state) => {
          const item = state.items[id];
          if (!item) return;
          item.status = 'ignored';
          item.processedAt = Date.now();
          item.unread = false;
        });
      },

      dismiss: (id) => {
        set((state) => {
          delete state.items[id];
        });
      },

      getAll: () => {
        return Object.values(get().items).sort((a, b) => b.createdAt - a.createdAt);
      },

      getUnreadCount: () => {
        return Object.values(get().items).filter((i) => i.unread).length;
      },

      getPendingCount: () => {
        return Object.values(get().items).filter((i) => i.status === 'pending').length;
      },
    })),
    {
      name: 'abu-inbox',
      version: 2,
      partialize: (state) => ({ items: state.items }),
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { items?: Record<string, InboxItem> };
        // V2: add `status` field to existing items (default to 'pending' so
        // pre-V2 history surfaces in the "待处理" tab on first launch — they
        // were always actionable before this version anyway).
        if (version < 2 && state.items) {
          for (const item of Object.values(state.items)) {
            if (!('status' in item)) {
              (item as InboxItem).status = 'pending';
            }
          }
        }
        return state;
      },
    },
  ),
);
