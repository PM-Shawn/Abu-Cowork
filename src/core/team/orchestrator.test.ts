import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';

const runCalls: Array<{ conversationId: string; message: string }> = [];
let runBehavior: (conversationId: string, message: string) => Promise<{ reason: string; error?: string }> =
  async () => ({ reason: 'completed' });

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(async (conversationId: string, message: string) => {
    runCalls.push({ conversationId, message });
    return runBehavior(conversationId, message);
  }),
}));

let convCounter = 0;
vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      createConversation: vi.fn(() => `conv-${++convCounter}`),
      renameConversation: vi.fn(),
    }),
  },
}));

const registryAgents: Record<string, { name: string; description: string; roleId?: string; filePath: string; systemPrompt: string }> = {};
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAvailableAgents: () => Object.values(registryAgents).map((a) => ({ name: a.name, roleId: a.roleId })),
    getAgent: (name: string) => registryAgents[name],
  },
}));

vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/home/user') }));
vi.mock('@/utils/notifications', () => ({
  notifyTeamTaskPendingReview: vi.fn(async () => undefined),
  notifyTeamTaskBlocked: vi.fn(async () => undefined),
}));

import { startPlanning, confirmAndExecute, acceptTask } from './orchestrator';

function seed() {
  registryAgents['leader'] = { name: 'leader', description: 'lead', roleId: 'role-l', filePath: '/a/leader/AGENT.md', systemPrompt: '' };
  registryAgents['writer'] = { name: 'writer', description: 'write', roleId: 'role-w', filePath: '/a/writer/AGENT.md', systemPrompt: '' };
  const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'role-l', memberRoleIds: ['role-w'] });
  const task = useTeamStore.getState().createTask({ teamId: team.id, goal: '出一版 8 月周报' });
  return { team, task };
}

describe('team orchestrator', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [], tasks: [] });
    for (const key of Object.keys(registryAgents)) delete registryAgents[key];
    runCalls.length = 0;
    convCounter = 0;
    runBehavior = async () => ({ reason: 'completed' });
  });

  describe('startPlanning', () => {
    it('registers a planning conversation and delegates to the leader with the verbatim goal', async () => {
      const { task } = seed();
      // The leader "calls the tool" mid-run: simulate by proposing during the loop.
      runBehavior = async () => {
        useTeamStore.getState().proposePlan(task.id, {
          items: [{ id: '1', memberRoleId: 'role-w', what: '写初稿', dependsOn: [], state: 'pending' }],
          doneWhen: ['有周报'],
        });
        return { reason: 'completed' };
      };
      await startPlanning(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.planningConversationId).toBe('conv-1');
      expect(runCalls[0].message).toContain('@leader');
      expect(runCalls[0].message).toContain('出一版 8 月周报');
      // Proposing never starts execution.
      expect(after.status).toBe('awaiting_plan');
      expect(after.plan).toBeDefined();
    });

    it('marks the task blocked (visibly, not silently) when the leader never proposes', async () => {
      const { task } = seed();
      await startPlanning(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('blocked');
      expect(after.statusNote).toBeTruthy();
    });

    it('blocks with a named reason when the leader is missing', async () => {
      const { task } = seed();
      delete registryAgents['leader'];
      await startPlanning(task.id);
      expect(useTeamStore.getState().tasks[0].status).toBe('blocked');
    });
  });

  describe('confirmAndExecute', () => {
    function seedWithPlan() {
      const ids = seed();
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [
          { id: '1', memberRoleId: 'role-w', what: '取数', produces: '数据.csv', dependsOn: [], state: 'pending' },
          { id: '2', memberRoleId: 'role-l', what: '写稿', dependsOn: ['1'], state: 'pending' },
        ],
        doneWhen: ['有周报'],
      });
      return ids;
    }

    it('runs dependency waves in order and lands in pending_review', async () => {
      const { task } = seedWithPlan();
      await confirmAndExecute(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('pending_review');
      expect(after.folder).toContain('abu-team');
      expect(after.plan?.items.every((item) => item.state === 'done')).toBe(true);
      // Wave order: item 1 (writer) ran before item 2 (leader).
      expect(runCalls[0].message).toContain('@writer');
      expect(runCalls[1].message).toContain('@leader');
      // Downstream prompt mentions upstream output.
      expect(runCalls[1].message).toContain('数据.csv');
    });

    it('a failed item blocks the task with a plain-language note and skips dependents', async () => {
      const { task } = seedWithPlan();
      runBehavior = async (_conv, message) =>
        message.includes('@writer') ? { reason: 'error', error: 'boom' } : { reason: 'completed' };
      await confirmAndExecute(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('blocked');
      expect(after.plan?.items.find((item) => item.id === '1')?.state).toBe('failed');
      // Dependent never ran.
      expect(after.plan?.items.find((item) => item.id === '2')?.state).toBe('pending');
      expect(runCalls).toHaveLength(1);
    });

    it('does nothing without user confirmation path (wrong status)', async () => {
      const { task } = seedWithPlan();
      useTeamStore.getState().updateTaskStatus(task.id, 'done');
      await confirmAndExecute(task.id);
      expect(runCalls).toHaveLength(0);
    });
  });

  describe('acceptTask', () => {
    it('only the user moves a task to done, and only from pending_review', () => {
      const { task } = seed();
      acceptTask(task.id);
      expect(useTeamStore.getState().tasks[0].status).toBe('awaiting_plan');
      useTeamStore.getState().updateTaskStatus(task.id, 'pending_review');
      acceptTask(task.id);
      expect(useTeamStore.getState().tasks[0].status).toBe('done');
    });
  });
});
