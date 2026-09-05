/**
 * Shell-side resolver for in-conversation team mode: turns the conversation's
 * pinned team id into the plain `TeamRouteContext` that `leaderRoute.ts`
 * consumes. Reads the team store + role registry, so it is NOT sidecar-safe —
 * only `entryOrchestration.ts` (shimmed out of the sidecar bundle) imports it.
 */
import type { SubagentDefinition } from '@/types';
import { useTeamStore } from '@/stores/teamStore';
import { resolveRoleId } from './roleIdentity';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { agentRegistry } from '@/core/agent/registry';
import type { TeamRouteContext } from './leaderRoute';

/** Resolve the pinned team into plain route context; null = run as ordinary Abu. */
export function resolveTeamRouteContext(teamId: string | undefined): TeamRouteContext | null {
  if (!teamId) return null;
  const team = useTeamStore.getState().teams.find((t) => t.id === teamId);
  if (!team || team.archivedAt) return null;
  const leader = resolveRoleId(team.leaderRoleId);
  if (!leader) return null;
  const members: SubagentDefinition[] = [];
  for (const roleId of team.memberRoleIds) {
    if (roleId === team.leaderRoleId) continue;
    const def = resolveRoleId(roleId);
    if (def && def.name !== leader.name && !members.some((m) => m.name === def.name)) members.push(def);
  }
  return {
    teamId: team.id,
    teamName: team.name,
    leader,
    members,
    leaderNote: team.leaderNote,
    requirePlanApproval: team.requirePlanApproval,
  };
}

/**
 * Async variant for the run entry: the registry is filled by the fire-and-forget
 * discovery, so a team-pinned conversation dispatched right after launch (or by
 * the scheduler's first tick) must wait for it instead of silently running as
 * plain Abu. Still null when the team/leader is really gone — and that is logged.
 */
export async function resolveTeamRouteContextAsync(teamId: string | undefined): Promise<TeamRouteContext | null> {
  if (!teamId) return null;
  const first = resolveTeamRouteContext(teamId);
  if (first) return first;
  const team = useTeamStore.getState().teams.find((t) => t.id === teamId);
  if (!team || team.archivedAt) return null;
  const discovery = useDiscoveryStore.getState();
  if (discovery.isLoading) {
    await new Promise<void>((done) => {
      const unsubscribe = useDiscoveryStore.subscribe((state) => {
        if (!state.isLoading) { unsubscribe(); done(); }
      });
    });
  } else if (agentRegistry.getAvailableAgents().length === 0) {
    await discovery.refresh();
  }
  const second = resolveTeamRouteContext(teamId);
  if (!second) {
    console.warn(`[team] conversation is pinned to team "${team.name}" but its leader (role ${team.leaderRoleId}) cannot be resolved — running as Abu`);
  }
  return second;
}
