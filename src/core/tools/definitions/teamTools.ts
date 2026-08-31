import type { ToolDefinition } from '../../../types';
import { useTeamStore } from '../../../stores/teamStore';

/**
 * team_propose_plan — the leader's ONLY channel for reporting its split
 * (PRD docs/abu-team-prd-v2.md §4.4).
 *
 * Scope discipline: the tool only accepts calls from the conversation that the
 * orchestrator registered as a task's planning conversation, and only while
 * that task is still awaiting_plan without a proposal. Everything else fails
 * loud — a plan can never be smuggled in from an unrelated run, and proposing
 * never starts execution (the user confirms first; 指派 ≠ 启动).
 */
export const proposeTeamPlanTool: ToolDefinition = {
  name: 'team_propose_plan',
  description: 'Report your proposed split of the current team task to the user for confirmation. Only available when you are planning a team task. Each item assigns one member (by exact member name) one clearly scoped piece of work. Use depends_on for ordering; independent items run in parallel. Call this exactly once, then stop — the user reviews and confirms the plan; execution is NOT started by this call.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'The split. One entry per member assignment, 1-8 entries.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short stable id for this item, e.g. "1", "2".' },
            member: { type: 'string', description: 'Exact member name from the roster (including yourself for leader-owned work).' },
            what: { type: 'string', description: 'What this member should do, one clear instruction.' },
            produces: { type: 'string', description: 'Expected output file/deliverable name (optional).' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Ids of items that must finish first (optional).' },
          },
          required: ['id', 'member', 'what'],
        },
      },
      done_when: {
        type: 'array',
        items: { type: 'string' },
        description: 'How the user will know this task is done — 1-4 short, checkable statements drafted by you.',
      },
    },
    required: ['items', 'done_when'],
  },
  isConcurrencySafe: true,
  execute: async (input, context) => {
    const conversationId = context?.conversationId;
    if (!conversationId) {
      return 'Error: team_propose_plan is only available inside a team planning run.';
    }
    const store = useTeamStore.getState();
    const task = store.tasks.find((t) => t.planningConversationId === conversationId);
    if (!task) {
      return 'Error: this conversation is not planning any team task. Do not call team_propose_plan here.';
    }
    if (task.status !== 'awaiting_plan' || task.plan) {
      return 'Error: this task already has a proposed plan awaiting the user. Stop here.';
    }
    const team = store.teams.find((t) => t.id === task.teamId);
    if (!team) {
      return 'Error: the team for this task no longer exists.';
    }

    // Resolve member names → stable roleIds against the CURRENT roster
    // (covers both frontmatter role-ids and synthetic builtin: ids).
    const { agentRegistry } = await import('../../agent/registry');
    const { effectiveRoleId } = await import('../../team/roleIdentity');
    const roleIdByName = new Map<string, string>();
    for (const meta of agentRegistry.getAvailableAgents()) {
      const agent = agentRegistry.getAgent(meta.name);
      if (!agent) continue;
      const roleId = effectiveRoleId(agent);
      if (roleId && team.memberRoleIds.includes(roleId)) {
        roleIdByName.set(agent.name, roleId);
      }
    }

    const rawItems = input.items as Array<{ id: string; member: string; what: string; produces?: string; depends_on?: string[] }>;
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 8) {
      return 'Error: provide between 1 and 8 plan items.';
    }
    const unknown = rawItems.filter((item) => !roleIdByName.has(item.member));
    if (unknown.length > 0) {
      return `Error: unknown member(s): ${unknown.map((item) => item.member).join(', ')}. Use exact names from the roster: ${[...roleIdByName.keys()].join(', ')}.`;
    }

    try {
      useTeamStore.getState().proposePlan(task.id, {
        items: rawItems.map((item) => ({
          id: String(item.id),
          memberRoleId: roleIdByName.get(item.member) as string,
          what: item.what,
          produces: item.produces,
          dependsOn: (item.depends_on ?? []).map(String),
          state: 'pending',
        })),
        doneWhen: (input.done_when as string[] | undefined) ?? [],
      });
    } catch (err) {
      return `Error: invalid plan: ${err instanceof Error ? err.message : String(err)}`;
    }
    return 'Plan recorded and sent to the user for confirmation. Do not start any work — stop your turn now.';
  },
};
