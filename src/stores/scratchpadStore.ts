/**
 * ScratchpadStore - State management for intermediate results during AI processing
 *
 * Captures extracted text, analysis results, search summaries etc.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { TOOL_NAMES } from '@/core/tools/toolNames';

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

/**
 * Generate scratchpad entry title from tool call
 */
export function generateScratchpadTitle(
  _toolName: string,
  toolInput: Record<string, unknown>,
  type: ScratchpadEntryType
): string {
  const path = (toolInput.path || toolInput.file_path || toolInput.filePath) as string | undefined;
  const fileName = path ? path.split(/[/\\]/).pop() : undefined;
  const query = (toolInput.query || toolInput.pattern) as string | undefined;

  switch (type) {
    case 'extraction':
      return fileName ? `${fileName} - 内容提取` : '内容提取';
    case 'analysis':
      return fileName ? `${fileName} - 分析结果` : '分析结果';
    case 'search':
      return query ? `搜索: ${query.slice(0, 30)}${query.length > 30 ? '...' : ''}` : '搜索结果';
    case 'summary':
      return fileName ? `${fileName} - 摘要` : '摘要';
    case 'preview':
      return fileName ? `${fileName} - 预览` : '预览';
    default:
      return '结果';
  }
}

/**
 * Determine scratchpad entry type from tool name
 */
export function inferScratchpadType(toolName: string): ScratchpadEntryType | null {
  // File read tools → extraction
  if ([TOOL_NAMES.READ_FILE, 'read', 'get_file_contents'].includes(toolName)) {
    return 'extraction';
  }

  // Search tools → search
  if ([TOOL_NAMES.WEB_SEARCH, 'search', 'grep', 'find'].includes(toolName)) {
    return 'search';
  }

  // List directory → preview
  if (toolName === TOOL_NAMES.LIST_DIRECTORY) {
    return 'preview';
  }

  return null;
}

/**
 * Should this tool result be captured in scratchpad?
 */
export function shouldCaptureScratchpad(
  toolName: string,
  result: string
): boolean {
  const type = inferScratchpadType(toolName);
  if (!type) return false;

  // Only capture if result is substantial (not just a status message)
  const minLength = 100;
  if (result.length < minLength) return false;

  // Don't capture error results
  if (result.toLowerCase().startsWith('error:')) return false;

  return true;
}

/**
 * Truncate content for scratchpad preview
 */
export function truncateScratchpadContent(content: string, maxLength: number = 2000): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + `\n\n... (${content.length - maxLength} more characters)`;
}
