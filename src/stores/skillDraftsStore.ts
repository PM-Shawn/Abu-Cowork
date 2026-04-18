/**
 * Skill drafts store — ephemeral by design.
 *
 * The authoritative copy of each draft lives on disk (see `core/skill/drafts.ts`);
 * this store is a read-through cache that the UI subscribes to. No persist
 * middleware: the drafts list is always derived fresh from the filesystem on
 * boot and on workspace switch, so persisting it would just create drift.
 *
 * Responsibilities:
 *   - refresh(): rebuild the in-memory list from disk for the active workspace
 *   - accept(name) / reject(name, reason?): proxy to drafts.ts, then refresh
 *     (and trigger a skill-discovery refresh on accept so the newly-promoted
 *     skill shows up in the main skills panel immediately)
 *   - cleanExpired() / cleanTrash(): wrappers for the TTL sweepers, called
 *     from the boot hook below on a one-hour cadence
 *
 * Adaptive-downgrade is deliberately not implemented here — the PRD routes
 * that logic through `evaluateProactivity()` which depends on acceptance-rate
 * stats persisted separately (Module H / Task #23). This store only exposes
 * the hook points.
 */

import { create } from 'zustand';
import {
  type DraftRecord,
  listDrafts,
  acceptDraft as acceptDraftFs,
  rejectDraft as rejectDraftFs,
  cleanExpiredDrafts,
  emptyExpiredTrash,
} from '../core/skill/drafts';
import { skillLoader } from '../core/skill/loader';
import { useWorkspaceStore } from './workspaceStore';
import { useDiscoveryStore } from './discoveryStore';

interface SkillDraftsState {
  drafts: DraftRecord[];
  isLoading: boolean;
  lastRefreshedAt: number | null;
  /**
   * Most recent error from a filesystem call, surfaced for the UI's error banner.
   * Cleared on the next successful refresh / accept / reject.
   */
  lastError: string | null;
}

interface SkillDraftsActions {
  refresh: () => Promise<void>;
  /**
   * Promote a draft to workspace-auto. `workspaceOverride` is used by
   * in-chat proposal cards (see `InteractiveNoticeCard`) to bypass the
   * global workspaceStore — cards carry the workspace captured at
   * proposal time, so clicks work after restart / conversation switch
   * even if the global store has drifted.
   */
  acceptDraft: (
    name: string,
    workspaceOverride?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  rejectDraft: (
    name: string,
    reason?: string,
    workspaceOverride?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  cleanExpired: () => Promise<number>;
  cleanTrash: () => Promise<number>;
}

export type SkillDraftsStore = SkillDraftsState & SkillDraftsActions;

export const useSkillDraftsStore = create<SkillDraftsStore>()((set, get) => ({
  drafts: [],
  isLoading: false,
  lastRefreshedAt: null,
  lastError: null,

  refresh: async () => {
    const wp = useWorkspaceStore.getState().currentPath;
    if (!wp) {
      set({ drafts: [], isLoading: false, lastError: null });
      return;
    }
    set({ isLoading: true });
    try {
      const drafts = await listDrafts(wp);
      set({ drafts, isLoading: false, lastRefreshedAt: Date.now(), lastError: null });
    } catch (err) {
      set({
        isLoading: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  acceptDraft: async (name, workspaceOverride) => {
    const wp = workspaceOverride ?? useWorkspaceStore.getState().currentPath;
    if (!wp) return { ok: false, error: 'no active workspace' };
    try {
      await acceptDraftFs(name, wp);

      // Align the global workspaceStore to the workspace the skill was
      // just written to, so discoveryStore.refresh (which reads the
      // global store) scans the right project. Without this, accepting
      // from an old conversation whose conv.workspacePath was never
      // bound leaves currentPath=null, and the promoted skill stays
      // invisible in the Toolbox even though it's on disk.
      const globalWp = useWorkspaceStore.getState().currentPath;
      if (globalWp !== wp) {
        useWorkspaceStore.getState().setWorkspace(wp);
      }

      // Accepted skills need to show up in the main skills list — refresh the
      // loader so discoveryStore picks them up on its next read.
      await skillLoader.discoverSkills(wp).catch(() => {
        /* loader failure shouldn't abort the accept */
      });
      await useDiscoveryStore.getState().refresh();
      await get().refresh();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ lastError: msg });
      return { ok: false, error: msg };
    }
  },

  rejectDraft: async (name, reason, workspaceOverride) => {
    const wp = workspaceOverride ?? useWorkspaceStore.getState().currentPath;
    if (!wp) return { ok: false, error: 'no active workspace' };
    try {
      await rejectDraftFs(name, wp, reason);
      // Mirror the acceptDraft sync: if override is steering us, bring the
      // global store along so the drafts panel (which reads globalStore in
      // its own refresh) doesn't fall back to an empty "no workspace" view.
      const globalWp = useWorkspaceStore.getState().currentPath;
      if (globalWp !== wp) {
        useWorkspaceStore.getState().setWorkspace(wp);
      }
      await get().refresh();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ lastError: msg });
      return { ok: false, error: msg };
    }
  },

  cleanExpired: async () => {
    const wp = useWorkspaceStore.getState().currentPath;
    if (!wp) return 0;
    try {
      const n = await cleanExpiredDrafts(wp);
      if (n > 0) await get().refresh();
      return n;
    } catch (err) {
      console.warn('[skillDraftsStore] cleanExpired failed:', err);
      return 0;
    }
  },

  cleanTrash: async () => {
    const wp = useWorkspaceStore.getState().currentPath;
    if (!wp) return 0;
    try {
      return await emptyExpiredTrash(wp);
    } catch (err) {
      console.warn('[skillDraftsStore] cleanTrash failed:', err);
      return 0;
    }
  },
}));

// ── Boot hooks ──────────────────────────────────────────────────────────
//
// Two passive subscriptions kick in as soon as this module is imported:
//
//   1. Workspace switch → rebuild drafts + sweep expired. Mirrors the pattern
//      in discoveryStore.ts so both stores reload on the same signal.
//   2. Hourly sweep → cleanExpired + cleanTrash. Single setInterval, cleaned
//      up via module-scoped handle so HMR / test re-imports don't stack.
//
// App.tsx triggers an initial refresh on boot; we don't duplicate that here.

let lastWorkspaceForDrafts: string | null | undefined;
useWorkspaceStore.subscribe((state) => {
  if (state.currentPath === lastWorkspaceForDrafts) return;
  lastWorkspaceForDrafts = state.currentPath;
  void (async () => {
    await useSkillDraftsStore.getState().refresh();
    await useSkillDraftsStore.getState().cleanExpired();
    await useSkillDraftsStore.getState().cleanTrash();
  })();
});

const HOURLY_SWEEP_MS = 60 * 60 * 1000;
let sweepHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Called from App.tsx bootstrap after workspace initialization. Idempotent —
 * safe to call multiple times; a second call replaces the prior interval.
 */
export function startDraftsSweeper(): void {
  if (sweepHandle) clearInterval(sweepHandle);
  sweepHandle = setInterval(() => {
    void useSkillDraftsStore.getState().cleanExpired();
    void useSkillDraftsStore.getState().cleanTrash();
  }, HOURLY_SWEEP_MS);
}

/** Test / teardown helper. */
export function stopDraftsSweeper(): void {
  if (sweepHandle) {
    clearInterval(sweepHandle);
    sweepHandle = null;
  }
}
