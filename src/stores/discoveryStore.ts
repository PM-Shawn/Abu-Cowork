import { create } from 'zustand';
import { homeDir } from '@tauri-apps/api/path';
import type { SkillMetadata, SubagentMetadata } from '../types';
import { skillLoader } from '../core/skill/loader';
import { agentRegistry } from '../core/agent/registry';
import { readInstalled, type InstalledPlugin } from '../core/plugin/installedStore';
import { useSettingsStore } from './settingsStore';
import { useWorkspaceStore } from './workspaceStore';

/**
 * Resolve every agent's plugin provenance against `installed.json`.
 *
 * `installed.json`'s `contributed.agents` — the same list uninstall trusts — is
 * the SOLE authority on which agents belong to a plugin. A `source:` parsed off
 * an AGENT.md is only a cache of it:
 *
 *  - a name a record claims is labelled with THAT record's key, whatever the
 *    file said (a fresh install stamps the file, but the file can also be stale,
 *    hand-edited, or written by the `save_agent` tool);
 *  - a name no record claims loses any `source` it carried in, so a user's own
 *    agent cannot lock itself behind the plugin read-only gates (delete/save
 *    disabled in `AgentsSection`/`AgentEditor`) just because the string
 *    `source: plugin:x` reached its frontmatter — nor can an orphan left behind
 *    by a refused `removeContributedAgent`.
 *
 * Backfill is the same rule seen from the other side: an agent installed before
 * the `source:` key existed has no provenance on disk, and rewriting its
 * AGENT.md would edit a file that now lives in the user's `~/.abu/agents`, so
 * the label is restored here, in memory.
 *
 * Lives in the store, not in `core/agent/registry`, on purpose: the registry
 * must not learn about `core/plugin` (the plugin installer already depends on
 * the registry, and the reverse edge would close the cycle).
 */
export function applyPluginAgentSources(
  agents: SubagentMetadata[],
  installed: readonly InstalledPlugin[],
): SubagentMetadata[] {
  const owner = new Map<string, string>();
  for (const record of installed) {
    for (const name of record.contributed?.agents ?? []) {
      if (!owner.has(name)) owner.set(name, record.key);
    }
  }

  return agents.map((agent) => {
    const plugin = owner.get(agent.name);
    if (plugin) {
      if (agent.source?.plugin === plugin) return agent;
      return { ...agent, source: { kind: 'plugin' as const, plugin } };
    }
    if (!agent.source) return agent;
    const { source: _unclaimed, ...withoutSource } = agent;
    return withoutSource;
  });
}

/**
 * `installed.json`, or `[]`. Discovery must not fail because the plugin
 * manifest could not be read — the agents themselves are already on disk and
 * usable; only the provenance label is lost.
 */
async function readInstalledPluginsSafely(): Promise<InstalledPlugin[]> {
  try {
    return await readInstalled(await homeDir());
  } catch {
    return [];
  }
}

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
      const [skills, agents, installedPlugins] = await Promise.all([
        skillLoader.discoverSkills(wp),
        agentRegistry.discoverAgents(),
        readInstalledPluginsSafely(),
      ]);

      // Auto-disable project-level skills on first discovery (opt-in model).
      // Users must explicitly enable them in the Skills panel.
      const projectSkillNames = skills
        .filter((s) => s.source === 'project' || s.source === 'project-standard')
        .map((s) => s.name);
      if (projectSkillNames.length > 0) {
        useSettingsStore.getState().autoDisableProjectSkills(projectSkillNames);
      }

      set({ skills, agents: applyPluginAgentSources(agents, installedPlugins), isLoading: false });
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
