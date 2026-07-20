/**
 * ScratchpadStore - State management for intermediate results during AI processing
 *
 * Captures extracted text, analysis results, search summaries etc.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
// Relocated to a pure module so eventRouter.ts (and anything else that needs
// zero store-graph coupling) can import them directly — see
// scratchpadClassify.ts's module doc. Re-exported below unchanged.
import {
  generateScratchpadTitle,
  inferScratchpadType,
  shouldCaptureScratchpad,
  truncateScratchpadContent,
} from '../core/agent/scratchpadClassify';
export {
  generateScratchpadTitle,
  inferScratchpadType,
  shouldCaptureScratchpad,
  truncateScratchpadContent,
};

export type ScratchpadEntryType = 'extraction' | 'analysis' | 'search' | 'summary' | 'preview';

export interface ScratchpadEntry {
  id: string;
  conversationId: string;
  title: string;                // e.g. "invoice48.png - Text Extraction"
  type: ScratchpadEntryType;
  content: string;              // Extracted/analyzed result
  sourceFile?: string;          // Source file path
  toolName?: string;            // Which tool generated this
  timestamp: number;
  isViewed: boolean;
  metadata?: Record<string, unknown>;
}

interface ScratchpadState {
  /** All scratchpad entries */
  entries: Record<string, ScratchpadEntry>;
  /** Order of entries (newest first) */
  order: string[];
}

interface ScratchpadActions {
  /** Add a new entry */
  addEntry: (entry: Omit<ScratchpadEntry, 'id' | 'timestamp' | 'isViewed'>) => string;
  /** Mark entry as viewed */
  markViewed: (entryId: string) => void;
  /** Mark all entries for a conversation as viewed */
  markAllViewed: (conversationId: string) => void;
  /** Remove an entry */
  removeEntry: (entryId: string) => void;
  /** Clear entries for a conversation */
  clearConversation: (conversationId: string) => void;
  /** Clear all entries */
  clearAll: () => void;
  /** Get entries for a conversation */
  getEntriesByConversation: (conversationId: string) => ScratchpadEntry[];
  /** Get unviewed count for a conversation */
  getUnviewedCount: (conversationId: string) => number;
}

export type ScratchpadStore = ScratchpadState & ScratchpadActions;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export const useScratchpadStore = create<ScratchpadStore>()(
  persist(
    immer((set, get) => ({
      entries: {},
      order: [],

      addEntry: (entry) => {
        const id = generateId();
        const fullEntry: ScratchpadEntry = {
          ...entry,
          id,
          timestamp: Date.now(),
          isViewed: false,
        };

        set((state) => {
          state.entries[id] = fullEntry;
          state.order.unshift(id); // Add to front (newest first)
        });

        return id;
      },

      markViewed: (entryId) => {
        set((state) => {
          const entry = state.entries[entryId];
          if (entry) {
            entry.isViewed = true;
          }
        });
      },

      markAllViewed: (conversationId) => {
        set((state) => {
          for (const entry of Object.values(state.entries)) {
            if (entry.conversationId === conversationId) {
              entry.isViewed = true;
            }
          }
        });
      },

      removeEntry: (entryId) => {
        set((state) => {
          delete state.entries[entryId];
          state.order = state.order.filter((id) => id !== entryId);
        });
      },

      clearConversation: (conversationId) => {
        set((state) => {
          const toRemove = Object.keys(state.entries).filter(
            (id) => state.entries[id].conversationId === conversationId
          );
          for (const id of toRemove) {
            delete state.entries[id];
          }
          state.order = state.order.filter((id) => !toRemove.includes(id));
        });
      },

      clearAll: () => {
        set((state) => {
          state.entries = {};
          state.order = [];
        });
      },

      getEntriesByConversation: (conversationId) => {
        const state = get();
        return state.order
          .map((id) => state.entries[id])
          .filter((entry) => entry && entry.conversationId === conversationId);
      },

      getUnviewedCount: (conversationId) => {
        const state = get();
        return Object.values(state.entries).filter(
          (entry) => entry.conversationId === conversationId && !entry.isViewed
        ).length;
      },
    })),
    {
      name: 'abu-scratchpad-store',
      version: 1,
      // Limit persisted entries to last 100
      partialize: (state) => {
        const limitedOrder = state.order.slice(0, 100);
        const limitedEntries: Record<string, ScratchpadEntry> = {};
        for (const id of limitedOrder) {
          if (state.entries[id]) {
            limitedEntries[id] = state.entries[id];
          }
        }
        return {
          entries: limitedEntries,
          order: limitedOrder,
        };
      },
    }
  )
);

// --- Selector Hooks ---

export function useScratchpadByConversation(conversationId: string | undefined) {
  return useScratchpadStore(
    useShallow((s) => {
      if (!conversationId) return [];
      return s.order
        .map((id) => s.entries[id])
        .filter((entry) => entry && entry.conversationId === conversationId);
    })
  );
}

export function useUnviewedScratchpadCount(conversationId: string | undefined) {
  return useScratchpadStore((s) => {
    if (!conversationId) return 0;
    return Object.values(s.entries).filter(
      (entry) => entry.conversationId === conversationId && !entry.isViewed
    ).length;
  });
}

// --- Helper Functions for EventRouter Integration ---
// generateScratchpadTitle / inferScratchpadType / shouldCaptureScratchpad /
// truncateScratchpadContent now live in ../core/agent/scratchpadClassify.ts
// (see import + re-export above).
