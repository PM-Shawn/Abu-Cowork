import { useMemo } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import { resolveRoleId } from '@/core/team/roleIdentity';

/** Who answers in a team-pinned conversation (design §2.3: the leader is the root agent). */
export interface ConversationTeamLeader {
  teamId: string;
  teamName: string;
  leaderName: string;
  /** Emoji avatar from the leader's AGENT.md; a neutral fallback when absent. */
  leaderAvatar: string;
}

export const DEFAULT_LEADER_AVATAR = '🧑‍💼';

export function teamLeaderFromTeam(team: Team | null | undefined): ConversationTeamLeader | null {
  if (!team || team.archivedAt) return null;
  const leader = resolveRoleId(team.leaderRoleId);
  if (!leader) return null;
  return {
    teamId: team.id,
    teamName: team.name,
    leaderName: leader.name,
    leaderAvatar: leader.avatar?.trim() || DEFAULT_LEADER_AVATAR,
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
