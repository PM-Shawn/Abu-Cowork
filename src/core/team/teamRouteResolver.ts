/**
 * Shell-side resolver for in-conversation team mode: turns the conversation's
 * pinned team id into the plain `TeamRouteContext` that `leaderRoute.ts`
 * consumes. Reads the team store + role registry, so it is NOT sidecar-safe —
 * only `entryOrchestration.ts` (shimmed out of the sidecar bundle) imports it.
 */
import type { SubagentDefinition } from '@/types';
import { useTeamStore } from '@/stores/teamStore';
import { resolveRoleId } from './roleIdentity';
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
