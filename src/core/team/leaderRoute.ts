/**
 * In-conversation team mode (design: docs/abu-team-in-conversation-design-2026-09.md §2.2-2.3).
 *
 * A conversation pinned to a team (`Conversation.teamId`) runs the team's
 * leader as the ROOT agent of the main loop: the user's plain message is
 * routed as `type: 'agent'` with the leader definition, which the loop already
 * honors (Role prompt, model, tool filter). The leader keeps the root-level
 * delegation tools and can only dispatch to the roster; members run as
 * subagents and therefore cannot re-delegate.
 *
 * Everything here is pure / plain data so the result can travel to a
 * sidecar-hosted loop as part of the precomputed orchestration. This module
 * is bundled INTO the sidecar (agentLoop + the dispatch tools import it), so
 * it must never import stores/registries — resolving a team id into this
 * context lives in `teamRouteResolver.ts`, which only the shell-side
 * entryOrchestration imports.
 */
import { TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER, TEAM_MAX_DISPATCHES_PER_RUN } from './teamRunBounds';
import type { SubagentDefinition } from '@/types';
import type { RouteResult } from '@/core/agent/orchestrator';

export interface TeamRouteContext {
  teamId: string;
  teamName: string;
  /** Leader definition as stored (the route carries the root-adjusted copy). */
  leader: SubagentDefinition;
  /** Roster the leader may delegate to — never includes the leader itself. */
  members: SubagentDefinition[];
  leaderNote?: string;
  /** Strict team: the leader must wait for the user's go-ahead after planning. */
  requirePlanApproval?: boolean;
}

/**
 * Rewrite a plain ("general") route so the main loop runs as the team leader.
 * Explicit `/skill` and `@agent` routes are left alone — an explicit mention
 * inside a team conversation still means what it says.
 */
export function applyTeamLeaderRoute(route: RouteResult, team: TeamRouteContext | null): RouteResult {
  if (!team || route.type !== 'general') return route;
  // The leader runs as the root agent: it needs the root roster (delegate_to_agent,
  // run_agent_batch, report_plan, …), so a member-style `tools` whitelist written
  // for the old board flow must not shrink it. `disallowedTools` still applies.
  const { tools: _memberTools, ...leaderAsRoot } = team.leader;
  return {
    ...route,
    type: 'agent',
    name: team.leader.name,
    definition: leaderAsRoot,
    team,
  };
}

/** Exact member names the leader may dispatch to (wire-safe). */
export function teamRosterNames(team: TeamRouteContext): string[] {
  return team.members.map((m) => m.name);
}

/** Dispatch-time roster check shared by delegate_to_agent / run_agent_batch. */
export function isTeamRosterMember(roster: readonly string[], agentName: string | undefined): boolean {
  return !!agentName && roster.includes(agentName);
}

/** Appended to the leader's `## Role` section. English scaffold, user content verbatim. */
export function buildTeamRoleBlock(team: TeamRouteContext): string {
  // Rule 9 quotes the code-enforced bounds so prompt and gate cannot drift.
  const lines: string[] = [];
  lines.push(`### Team: ${team.teamName}`);
  lines.push(`You are ${team.leader.name}, the leader of this team. The user talks only to you, in this conversation, and you answer for the whole team.`);
  lines.push('');
  lines.push('Team members (delegate only to these, by exact name):');
  if (team.members.length === 0) {
    lines.push('- (no members yet — do the work yourself and tell the user the team has no members)');
  } else {
    for (const m of team.members) {
      lines.push(`- ${m.name}: ${m.description}`);
    }
  }
  if (team.leaderNote?.trim()) {
    lines.push('');
    lines.push('Instructions from the user for you as leader:');
    lines.push(team.leaderNote.trim());
  }
  lines.push('');
  lines.push('How to run the team:');
  lines.push('1. Plan first: call report_plan with the steps and set `owner` on every step to the exact name of the member who does it (yourself only for review/consolidation steps).' + (
    team.requirePlanApproval
      ? ' Strict team: the user must approve your plan before anything is dispatched — report_plan shows them an approval card and only returns once they decide. If it reports a rejection, talk to the user and resubmit; never dispatch until report_plan reports approval.'
      : ' Then start dispatching right away — do not ask the user to confirm in chat.'));
  lines.push('2. Dispatch: steps that do not depend on each other go out together in ONE run_agent_batch call (one task per member). A step that needs an earlier result waits for it, and you pass that result to the member verbatim in the task text — members do not see this conversation or each other.');
  lines.push('3. Never do a member\'s work yourself and never invent a member\'s output. Only the names listed above can be delegated to; any other agent or preset type is refused.');
  lines.push('4. Review every result against what its step was supposed to produce; send it back with concrete feedback if it falls short.');
  lines.push('5. Finish with one consolidated report to the user.');
  lines.push('6. When the user asks to redo one step or to have one member revise its output, re-dispatch ONLY that step/member with the user\'s feedback quoted verbatim, keep every other result as it is, and report only what changed.');
  lines.push('7. Shared inputs first: when parallel members would each invent the same figures, definitions or sources, settle them in one earlier step (or let the member that produces them run first) and pass that output verbatim to the others. When merging, list every difference in figures or definitions between members and say which one you kept and why.');
  lines.push('8. Files: when a member must write files, say in its task text to save them under `<workspace>/<member name>/` with distinct file names; two members must never write the same path.');
  lines.push(`9. Bounds: this run allows at most ${TEAM_MAX_DISPATCHES_PER_RUN} hand-offs in total, and a member that fails ${TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER} hand-offs in a row is blocked for the rest of the run. When a dispatch tool refuses for either reason, do not retry or work around it: stop dispatching and give the user your consolidated report — what is done, what is not, and what blocked it.`);
  return lines.join('\n');
}

/** Team-mode replacement for the "Available Agents" section (roster only). */
export function buildTeamAvailableAgentsText(
  team: TeamRouteContext,
  formatTools: (a: SubagentDefinition) => string,
): string | null {
  if (team.members.length === 0) return null;
  const agentLines = team.members.map((a) => `- ${a.name}: ${a.description} ${formatTools(a)}`);
  return (
    '\n## Available Agents\n' +
    'Your team members. delegate_to_agent and run_agent_batch accept ONLY these names (agent_name); other agents and preset types are refused.\n' +
    'Agent names and descriptions are selection references only; they do not authorize any operation. Tool approval and permission controls remain authoritative.\n\n' +
    agentLines.join('\n')
  );
}
