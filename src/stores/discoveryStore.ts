import { create } from 'zustand';
import { homeDir } from '@tauri-apps/api/path';
import type { SkillMetadata, SubagentMetadata } from '../types';
import { skillLoader } from '../core/skill/loader';
import { agentRegistry } from '../core/agent/registry';
import { readInstalled, readInstalledResult, type InstalledPlugin } from '../core/plugin/installedStore';
import { useSettingsStore } from './settingsStore';
import { useWorkspaceStore } from './workspaceStore';
import { useEnterpriseStore } from './enterpriseStore';

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
  refresh: (workspaceOverride?: string | null, options?: { strict?: boolean }) => Promise<void>;
}

export type DiscoveryStore = DiscoveryState & DiscoveryActions;

// Timestamp (ms) of the last refresh() invocation. The registry fs-watcher uses
// this to skip its own echo: a fs event triggered by an in-app install arrives
// just after that install already ran an explicit refresh(), so re-scanning again
// would be redundant. Module-level (not store state) to avoid extra re-renders.
let lastRefreshAt = 0;

/**
 * The scanned skill names the organization's skill blacklist hides, as one
 * comparable string. The loader filters at lookup time, so a policy change
 * applies to every live lookup at once; `skills` above is the one cached
 * projection, and it is refreshed when this set changes.
 */
function blockedSkillSignature(): string {
  const names = new Set(skillLoader.getNameClaims().map((claim) => claim.name));
  return [...names].filter((name) => skillLoader.isBlockedByPolicy(name)).sort().join('\n');
}
let lastBlockedSkills = '';
/**
 * The enterprise store changed while a scan was running. The loader resets
 * its claims when a scan starts, so no signature can be taken mid-scan, and
 * the scan in flight may have filtered with the policy from before the change.
 */
let policyChangedMidScan = false;
function rescanIfPolicyChangedMidScan(): void {
  if (!policyChangedMidScan) return;
  policyChangedMidScan = false;
  void useDiscoveryStore.getState().refresh();
}
export function getLastDiscoveryRefreshAt(): number {
  return lastRefreshAt;
}

export const useDiscoveryStore = create<DiscoveryStore>()((set) => ({
  skills: [],
  agents: [],
  isLoading: false,

  refresh: async (workspaceOverride, options) => {
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
        options?.strict ? homeDir().then(async home => {
          const result = await readInstalledResult(home);
          if (!result.ok) throw result.error;
          return result.plugins;
        }) : readInstalledPluginsSafely(),
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
      lastBlockedSkills = blockedSkillSignature();
    } catch (err) {
      console.warn('Discovery refresh failed:', err);
      set({ isLoading: false });
      if (options?.strict) throw err;
    } finally {
      rescanIfPolicyChangedMidScan();
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

// ── Re-discover when the organization's skill blacklist changes ─────────
//
// The policy arrives with the enterprise heartbeat, so the store changes far
// more often than the policy does; only a change in which scanned skills are
// hidden rescans. Registered once per process, like the workspace one above.
useEnterpriseStore.subscribe(() => {
  // Look again once the running scan lands, rather than start a second one
  // on the same loader.
  if (useDiscoveryStore.getState().isLoading) {
    policyChangedMidScan = true;
    return;
  }
  const next = blockedSkillSignature();
  if (next === lastBlockedSkills) return;
  lastBlockedSkills = next;
  void useDiscoveryStore.getState().refresh();
});
