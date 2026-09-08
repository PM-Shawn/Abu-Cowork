import { useMemo } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { resolveTeamRouteContext } from '@/core/team/teamRouteResolver';
import type { TeamRouteContext } from '@/core/team/leaderRoute';
import { collectMemberDispatches, summarizeByMember, type MemberDispatch, type MemberSummary } from './teamDispatches';

/** The leader's or a member's definition by name; a bare stand-in when the roster changed. */
export function memberDefByName(team: TeamRouteContext, name: string): { name: string; description: string; avatar?: string; filePath?: string } {
  return (name === team.leader.name ? team.leader : team.members.find((m) => m.name === name)) ?? { name, description: '' };
}

/** Team pinned to a conversation, re-resolved when the team store changes. */
export function useConversationTeam(conversationId: string): TeamRouteContext | null {
  const teamId = useChatStore((s) => s.conversations[conversationId]?.teamId);
  const teams = useTeamStore((s) => s.teams);
  // Roles resolve through the agent registry, which fills in asynchronously
  // after launch/reopen; without this dependency a reopened team conversation
  // stayed at "队员 · 0" (retest G1, 2026-09-07).
  const agents = useDiscoveryStore((s) => s.agents);
  // `teams` / `agents` are the reactive dependencies; resolveTeamRouteContext reads through the stores.
  return useMemo(() => resolveTeamRouteContext(teamId), [teamId, teams, agents]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Every hand-off of a conversation (live executions first, then the message
 * snapshots) plus the per-member summary — computed once and shared by the
 * member bar, the follow-up chips and the team tab.
 */
export function useTeamDispatches(conversationId: string): { team: TeamRouteContext | null; dispatches: MemberDispatch[]; members: MemberSummary[] } {
  const team = useConversationTeam(conversationId);
  const messages = useChatStore((s) => s.conversations[conversationId]?.messages);
  const executions = useTaskExecutionStore((s) => s.executions);
  const dispatches = useMemo(
    () => (team ? collectMemberDispatches({ conversationId, executions: Object.values(executions), messages: messages ?? [] }) : []),
    [team, conversationId, executions, messages],
  );
  const members = useMemo(() => summarizeByMember(team?.members.map((m) => m.name) ?? [], dispatches), [team, dispatches]);
  return { team, dispatches, members };
}
