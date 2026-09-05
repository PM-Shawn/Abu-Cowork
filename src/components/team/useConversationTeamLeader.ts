import { useMemo } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import { resolveRoleId } from '@/core/team/roleIdentity';
import type { SubagentDefinition } from '@/types';
import { userAgentAvatar } from '@/components/common/AgentAvatar';

/** Who answers in a team-pinned conversation (design §2.3: the leader is the root agent). */
export interface ConversationTeamLeader {
  teamId: string;
  teamName: string;
  leaderName: string;
  /** The user's emoji for their own leader agent; null = the default mark. */
  leaderAvatar: string | null;
  leader: SubagentDefinition;
  teamAvatar: string | null;
}

export function teamLeaderFromTeam(team: Team | null | undefined): ConversationTeamLeader | null {
  if (!team || team.archivedAt) return null;
  const leader = resolveRoleId(team.leaderRoleId);
  if (!leader) return null;
  return {
    teamId: team.id,
    teamName: team.name,
    leaderName: leader.name,
    leaderAvatar: userAgentAvatar(leader),
    leader,
    teamAvatar: team.avatar?.trim() || null,
  };
}

/**
 * Reactive: follows the conversation's team pin and the team store. Returns
 * null for ordinary conversations, so callers fall back to Abu's own avatar.
 */
export function useConversationTeamLeader(conversationId: string | null | undefined): ConversationTeamLeader | null {
  const teamId = useChatStore((s) => (conversationId ? s.conversations[conversationId]?.teamId : undefined));
  const team = useTeamStore((s) => (teamId ? s.teams.find((entry) => entry.id === teamId) ?? null : null));
  return useMemo(() => teamLeaderFromTeam(team), [team]);
}
