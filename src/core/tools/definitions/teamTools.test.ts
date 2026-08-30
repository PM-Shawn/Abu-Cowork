import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';
import { proposeTeamPlanTool } from './teamTools';

const registryAgents: Record<string, { name: string; roleId?: string }> = {};
vi.mock('../../agent/registry', () => ({
  agentRegistry: {
    getAvailableAgents: () => Object.values(registryAgents),
    getAgent: (name: string) => registryAgents[name],
  },
}));

function seed() {
  registryAgents['leader'] = { name: 'leader', roleId: 'role-l' };
  registryAgents['writer'] = { name: 'writer', roleId: 'role-w' };
  const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'role-l', memberRoleIds: ['role-w'] });
  const task = useTeamStore.getState().createTask({ teamId: team.id, goal: 'g' });
  useTeamStore.getState().setPlanningConversation(task.id, 'conv-plan');
  return task;
}

const validInput = {
  items: [
    { id: '1', member: 'writer', what: '取数' },
    { id: '2', member: 'leader', what: '汇总', depends_on: ['1'] },
  ],
  done_when: ['有周报'],
};

describe('team_propose_plan tool', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [], tasks: [] });
    for (const key of Object.keys(registryAgents)) delete registryAgents[key];
  });

  it('rejects calls from conversations that are not planning any task (no smuggled plans)', async () => {
    seed();
    const result = await proposeTeamPlanTool.execute(validInput, { conversationId: 'conv-unrelated' });
    expect(String(result)).toContain('Error');
    expect(useTeamStore.getState().tasks[0].plan).toBeUndefined();
  });

  it('rejects calls without a conversation context', async () => {
    seed();
    const result = await proposeTeamPlanTool.execute(validInput, {});
    expect(String(result)).toContain('Error');
  });

  it('records a valid plan against the planning conversation and does NOT start execution', async () => {
    const task = seed();
    const result = await proposeTeamPlanTool.execute(validInput, { conversationId: 'conv-plan' });
    expect(String(result)).not.toContain('Error');
    const after = useTeamStore.getState().tasks.find((item) => item.id === task.id);
    expect(after?.plan?.items).toHaveLength(2);
    expect(after?.plan?.items[0].memberRoleId).toBe('role-w');
    expect(after?.status).toBe('awaiting_plan'); // proposing ≠ starting
  });

  it('rejects unknown members and names the valid roster', async () => {
    seed();
    const result = await proposeTeamPlanTool.execute(
      { items: [{ id: '1', member: 'ghost', what: 'x' }], done_when: [] },
      { conversationId: 'conv-plan' },
    );
    expect(String(result)).toContain('ghost');
    expect(String(result)).toContain('writer');
  });

  it('rejects a second proposal while one is already awaiting the user', async () => {
    seed();
    await proposeTeamPlanTool.execute(validInput, { conversationId: 'conv-plan' });
    const again = await proposeTeamPlanTool.execute(validInput, { conversationId: 'conv-plan' });
    expect(String(again)).toContain('Error');
  });

  it('rejects dependency cycles via store validation', async () => {
    seed();
    const result = await proposeTeamPlanTool.execute(
      {
        items: [
          { id: '1', member: 'writer', what: 'a', depends_on: ['2'] },
          { id: '2', member: 'leader', what: 'b', depends_on: ['1'] },
        ],
        done_when: [],
      },
      { conversationId: 'conv-plan' },
    );
    expect(String(result)).toContain('cycle');
  });
});
