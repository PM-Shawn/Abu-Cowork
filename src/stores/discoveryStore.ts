import { create } from 'zustand';
import type { SkillMetadata, SubagentMetadata } from '../types';
import { skillLoader } from '../core/skill/loader';
import { agentRegistry } from '../core/agent/registry';
import { useSettingsStore } from './settingsStore';
import { useWorkspaceStore } from './workspaceStore';

interface DiscoveryState {
  skills: SkillMetadata[];
  agents: SubagentMetadata[];
  isLoading: boolean;
}

interface DiscoveryActions {
  /**
   * Re-scan installed skills + agents.
   *
   * @param workspaceOverride — scan a specific workspace instead of
   *   the globally active one. Lets callers refresh for a workspace
   *   without having to flip the global `workspaceStore.currentPath`
   *   first (Task #44 — fixes the silent workspace-switch bug in
   *   skillDraftsStore's accept/reject when the user clicks a card
   *   from a different project's conversation).
   *   - omit / pass `undefined` → use the global current workspace
   *   - pass `null` explicitly → scan with no workspace (global scan)
   *   - pass a string → scan that workspace
   */
  refresh: (workspaceOverride?: string | null) => Promise<void>;
}

export type DiscoveryStore = DiscoveryState & DiscoveryActions;

// Timestamp (ms) of the last refresh() invocation. The registry fs-watcher uses
// this to skip its own echo: a fs event triggered by an in-app install arrives
// just after that install already ran an explicit refresh(), so re-scanning again
// would be redundant. Module-level (not store state) to avoid extra re-renders.
let lastRefreshAt = 0;
export function getLastDiscoveryRefreshAt(): number {
  return lastRefreshAt;
}

export const useDiscoveryStore = create<DiscoveryStore>()((set) => ({
  skills: [],
  agents: [],
  isLoading: false,

  refresh: async (workspaceOverride) => {
    lastRefreshAt = Date.now();
    set({ isLoading: true });
    try {
      // Prefer the explicit override when provided (including `null`
      // for "no workspace" — `undefined` falls back to the global).
      const wp =
        workspaceOverride !== undefined
          ? workspaceOverride
          : useWorkspaceStore.getState().currentPath;
      const [skills, agents] = await Promise.all([
        skillLoader.discoverSkills(wp),
        agentRegistry.discoverAgents(),
      ]);

      // Auto-disable project-level skills on first discovery (opt-in model).
      // Users must explicitly enable them in the Skills panel.
      const projectSkillNames = skills
        .filter((s) => s.source === 'project' || s.source === 'project-standard')
        .map((s) => s.name);
      if (projectSkillNames.length > 0) {
        useSettingsStore.getState().autoDisableProjectSkills(projectSkillNames);
      }

      set({ skills, agents, isLoading: false });
    } catch (err) {
      console.warn('Discovery refresh failed:', err);
      set({ isLoading: false });
    }
  },
}));

// ── Auto-re-discover on workspace switch ────────────────────────────────
//
// App.tsx already triggers an initial `refresh()` at boot. This subscription
// only kicks in for subsequent workspace changes — switching workspaces
// should replace the project/project-standard/workspace-auto/draft scope
// without requiring a manual refresh.
//
// Module-level subscribe registers once per process. Fire-and-forget: the
// refresh action handles its own errors.
let lastWorkspaceForDiscovery: string | null | undefined;
useWorkspaceStore.subscribe((state) => {
  if (state.currentPath !== lastWorkspaceForDiscovery) {
    lastWorkspaceForDiscovery = state.currentPath;
    void useDiscoveryStore.getState().refresh();
  }
});
