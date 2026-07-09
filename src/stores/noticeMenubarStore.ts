/**
 * Notice menubar store — tracks notices delivered to the menubar channel.
 *
 * Purely ephemeral (no persist): menubar state resets on restart.
 *
 * Wired via `registerChannel('menubar', ...)` from pipeline.
 * When count changes, calls Rust `update_tray_notice_count` to update
 * the tray icon title/tooltip.
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { registerChannel } from '@/core/notice/pipeline';
import type { Notice } from '@/core/notice/types';
import { getI18n } from '@/i18n';

interface MenubarNotice {
  id: string;
  type: string;
  tier: string;
  summary: string;
  createdAt: number;
}

interface NoticeMenubarState {
  /** Pending notices shown in menubar, newest first. */
  notices: MenubarNotice[];
}

interface NoticeMenubarActions {
  addNotice: (notice: Notice) => void;
  dismiss: (noticeId: string) => void;
  dismissAll: () => void;
}

type NoticeMenubarStore = NoticeMenubarState & NoticeMenubarActions;

function summarize(notice: Notice): string {
  const m = getI18n().noticeMenubar;
  const typeLabels: Record<string, string> = {
    meeting_prep: m.meetingPrep,
    permission_request: m.permissionRequest,
    user_input_needed: m.userInputNeeded,
    agent_error: m.agentError,
    schedule_fired: m.scheduleFired,
    task_complete: m.taskComplete,
    skill_proposal_offer: m.skillProposalOffer,
    skill_draft_ready: m.skillDraftReady,
    skill_patch: m.skillPatch,
    stuck_detection: m.stuckDetection,
    im_inbound: m.imInbound,
    context_resume: m.contextResume,
    deep_focus_enter: m.deepFocusEnter,
    deep_focus_exit: m.deepFocusExit,
  };
  return typeLabels[notice.type] ?? notice.type;
}

function syncTrayCount(count: number) {
  try {
    const result = invoke('update_tray_notice_count', { count });
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        // Tray might not be available in dev/test
      });
    }
  } catch {
    // invoke mock may not return a Promise in test env
  }
}

export const useNoticeMenubarStore = create<NoticeMenubarStore>()((set) => ({
  notices: [],

  addNotice: (notice: Notice) => {
    const entry: MenubarNotice = {
      id: notice.id,
      type: notice.type,
      tier: notice.tier,
      summary: summarize(notice),
      createdAt: notice.createdAt,
    };
    set((state) => {
      const next = [entry, ...state.notices].slice(0, 50);
      syncTrayCount(next.length);
      return { notices: next };
    });
  },

  dismiss: (noticeId: string) => {
    set((state) => {
      const next = state.notices.filter((n) => n.id !== noticeId);
      syncTrayCount(next.length);
      return { notices: next };
    });
  },

  dismissAll: () => {
    set({ notices: [] });
    syncTrayCount(0);
  },
}));

/** Count of pending menubar notices. */
export function useMenubarNoticeCount(): number {
  return useNoticeMenubarStore((s) => s.notices.length);
}

// ── Channel registration ───────────────────────────────────────────────

let registered = false;

/**
 * Register the menubar channel handler. Call once at app init.
 * Idempotent — safe to call multiple times.
 */
export function initMenubarChannel(): void {
  if (registered) return;
  registered = true;

  registerChannel('menubar', (notice: Notice) => {
    useNoticeMenubarStore.getState().addNotice(notice);
  });
}
