/**
 * Notice badge store — tracks per-conversation pending notice counts.
 *
 * Purely ephemeral (no persist): badge counts reset on app restart,
 * which is correct — restart means user was away, notices are stale.
 *
 * Wired via `registerChannel('sidebar_badge', ...)` from pipeline.
 * Cleared per-conversation when user switches to that conversation.
 */

import { create } from 'zustand';
import { registerChannel } from '@/core/notice/pipeline';
import type { DeliveryTarget } from '@/core/notice/router';
import type { Notice } from '@/core/notice/types';

interface NoticeBadgeState {
  /** conversationId → pending count */
  counts: Record<string, number>;
}

interface NoticeBadgeActions {
  increment: (conversationId: string) => void;
  clear: (conversationId: string) => void;
  clearAll: () => void;
}

type NoticeBadgeStore = NoticeBadgeState & NoticeBadgeActions;

export const useNoticeBadgeStore = create<NoticeBadgeStore>()((set) => ({
  counts: {},

  increment: (conversationId: string) =>
    set((state) => ({
      counts: {
        ...state.counts,
        [conversationId]: (state.counts[conversationId] ?? 0) + 1,
      },
    })),

  clear: (conversationId: string) =>
    set((state) => {
      if (!state.counts[conversationId]) return state;
      const next = { ...state.counts };
      delete next[conversationId];
      return { counts: next };
    }),

  clearAll: () => set({ counts: {} }),
}));

/** Total badge count across all conversations. */
export function useTotalBadgeCount(): number {
  return useNoticeBadgeStore((s) =>
    Object.values(s.counts).reduce((sum, n) => sum + n, 0),
  );
}

/** Badge count for a specific conversation. */
export function useConversationBadgeCount(conversationId: string): number {
  return useNoticeBadgeStore((s) => s.counts[conversationId] ?? 0);
}

// ── Channel registration ───────────────────────────────────────────────

let registered = false;

/**
 * Register the sidebar_badge channel handler. Call once at app init.
 * Idempotent — safe to call multiple times.
 */
export function initSidebarBadgeChannel(): void {
  if (registered) return;
  registered = true;

  registerChannel('sidebar_badge', (_notice: Notice, target: DeliveryTarget) => {
    if (target.conversationId) {
      useNoticeBadgeStore.getState().increment(target.conversationId);
    }
  });
}
