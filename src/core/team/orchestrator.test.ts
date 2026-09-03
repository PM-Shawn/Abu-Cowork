import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';

const runCalls: Array<{ conversationId: string; message: string; options?: Record<string, unknown> }> = [];
type RunOptions = { onAbortControllerReady?: (controller: AbortController) => void };
let runBehavior: (conversationId: string, message: string, options?: RunOptions) => Promise<{ reason: string; error?: string }> =
  async () => ({ reason: 'completed' });

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(async (conversationId: string, message: string, options?: RunOptions) => {
    runCalls.push({ conversationId, message, options: options as Record<string, unknown> | undefined });
    return runBehavior(conversationId, message, options);
  }),
}));

let convCounter = 0;
const createConversationCalls: Array<{ workspacePath: string | null; options?: Record<string, unknown> }> = [];
const permissionModeCalls: Array<{ conversationId: string; mode: unknown }> = [];
vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      createConversation: vi.fn((workspacePath: string | null, options?: Record<string, unknown>) => {
        createConversationCalls.push({ workspacePath, options });
        return `conv-${++convCounter}`;
      }),
      renameConversation: vi.fn(),
      setConversationPermissionMode: vi.fn((conversationId: string, mode: unknown) => {
        permissionModeCalls.push({ conversationId, mode });
      }),
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

import { startPlanning, confirmAndExecute, acceptTask, startMemberTask, stopTask, runScheduledTeamTask, retryItem, rejectTask, dependenciesSatisfied } from './orchestrator';

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
    createConversationCalls.length = 0;
    permissionModeCalls.length = 0;
    convCounter = 0;
    runBehavior = async () => ({ reason: 'completed' });
  });

  describe('startPlanning', () => {
    it('default mode: plan is visible-not-blocking — execution auto-starts after the proposal', async () => {
      const { task } = seed();
      // The leader "calls the tool" mid-run: simulate by proposing during the loop.
      runBehavior = async (_conv, message) => {
        if (message.includes('Plan the split')) {
          useTeamStore.getState().proposePlan(task.id, {
            items: [{ id: '1', memberRoleId: 'role-w', what: '写初稿', dependsOn: [], state: 'pending' }],
            doneWhen: ['有周报'],
          });
        }
        return { reason: 'completed' };
      };
      await startPlanning(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.planningConversationId).toBe('conv-1');
      expect(runCalls[0].message).toContain('@leader');
      expect(runCalls[0].message).toContain('出一版 8 月周报');
      // User decision 2026-08-31: no blocking plan confirmation by default —
      // the member run fired and the task went straight to the review gate.
      expect(after.status).toBe('pending_review');
      expect(runCalls.some((call) => call.message.includes('@writer'))).toBe(true);
    });

    it('strict mode (requirePlanApproval): the proposal waits for the user', async () => {
      registryAgents['leader'] = { name: 'leader', description: 'lead', roleId: 'role-l', filePath: '/a/leader/AGENT.md', systemPrompt: '' };
      registryAgents['writer'] = { name: 'writer', description: 'write', roleId: 'role-w', filePath: '/a/writer/AGENT.md', systemPrompt: '' };
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'role-l', memberRoleIds: ['role-w'], requirePlanApproval: true });
      const task = useTeamStore.getState().createTask({ teamId: team.id, goal: 'g' });
      runBehavior = async () => {
        useTeamStore.getState().proposePlan(task.id, {
          items: [{ id: '1', memberRoleId: 'role-w', what: 'x', dependsOn: [], state: 'pending' }],
          doneWhen: [],
        });
        return { reason: 'completed' };
      };
      await startPlanning(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('awaiting_plan');
      expect(after.plan).toBeDefined();
      expect(runCalls).toHaveLength(1); // planning run only, no member run
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

  describe('startMemberTask', () => {
    it('runs a single-member task with no planning step and lands in review', async () => {
      registryAgents['writer'] = { name: 'writer', description: 'write', roleId: 'role-w', filePath: '/a/writer/AGENT.md', systemPrompt: '' };
      const task = useTeamStore.getState().createTask({ memberRoleId: 'role-w', goal: '整理反馈' });
      await startMemberTask(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('pending_review');
      expect(after.plan?.items).toHaveLength(1);
      // No leader/planning prompt — the one run is the member doing the goal.
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0].message).toContain('@writer');
      expect(runCalls[0].message).toContain('整理反馈');
    });

    it('blocks visibly when the member no longer exists', async () => {
      const task = useTeamStore.getState().createTask({ memberRoleId: 'role-ghost', goal: 'g' });
      await startMemberTask(task.id);
      expect(useTeamStore.getState().tasks[0].status).toBe('blocked');
    });
  });

  describe('stopTask', () => {
    it('user stop marks running items stopped (never failed) and words the task as user agency', async () => {
      const { task } = seed();
      useTeamStore.getState().proposePlan(task.id, {
        items: [
          { id: '1', memberRoleId: 'role-w', what: 'a', dependsOn: [], state: 'pending' },
          { id: '2', memberRoleId: 'role-l', what: 'b', dependsOn: ['1'], state: 'pending' },
        ],
        doneWhen: [],
      });
      // First member run "hangs": stop mid-flight, then resolve as aborted.
      runBehavior = async (_conv, message) => {
        if (message.includes('@writer')) {
          stopTask(task.id);
          return { reason: 'aborted' };
        }
        return { reason: 'completed' };
      };
      await confirmAndExecute(task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('blocked');
      expect(after.statusNote).toMatch(/stop|停止/i);
      expect(after.plan?.items.find((i) => i.id === '1')?.state).toBe('stopped');
      // The dependent never started, but a stopped task reads every unfinished
      // item as 'stopped' so each one keeps its 重试 affordance (the button is
      // gated on failed|stopped) — 'pending' items had no way back.
      expect(after.plan?.items.find((i) => i.id === '2')?.state).toBe('stopped');
      // Only the first member run fired.
      expect(runCalls.filter((c) => !c.message.includes('Plan the split'))).toHaveLength(1);
    });
  });

  describe('runScheduledTeamTask', () => {
    function seedAcceptedRun(goal: string) {
      const ids = seed();
      useTeamStore.setState((s) => ({
        tasks: s.tasks.map((t) => (t.id === ids.task.id ? { ...t, goal } : t)),
      }));
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [{ id: '1', memberRoleId: 'role-w', what: '写周报', produces: '周报.md', dependsOn: [], state: 'pending' }],
        doneWhen: ['有周报'],
      });
      useTeamStore.getState().updateTaskStatus(ids.task.id, 'done');
      return ids;
    }

    it('reuses the accepted split for the same goal — no leader planning run', async () => {
      const ids = seedAcceptedRun('出周报');
      const result = await runScheduledTeamTask(ids.team.id, '出周报');
      expect(result.ok).toBe(true);
      expect(runCalls.some((c) => c.message.includes('Plan the split'))).toBe(false);
      expect(runCalls.some((c) => c.message.includes('@writer'))).toBe(true);
      const task = useTeamStore.getState().tasks.find((t) => t.id === result.taskId);
      expect(task?.status).toBe('pending_review');
    });

    it('a new goal goes through normal leader planning', async () => {
      const ids = seedAcceptedRun('出周报');
      await runScheduledTeamTask(ids.team.id, '出月报');
      expect(runCalls.some((c) => c.message.includes('Plan the split'))).toBe(true);
    });

    it('refuses archived or missing teams', async () => {
      const ids = seedAcceptedRun('出周报');
      useTeamStore.getState().archiveTeam(ids.team.id);
      const result = await runScheduledTeamTask(ids.team.id, '出周报');
      expect(result.ok).toBe(false);
    });
  });

  describe('stop-latch lifecycle (review finding: stale stopRequested)', () => {
    it('a stop during planning does not sabotage the next 重新拆解', async () => {
      const ids = seed();
      // Leader never proposes; the user stops mid-planning. stopTask moves the
      // task to 'blocked', which used to skip the branch that clears the latch.
      runBehavior = async () => { stopTask(ids.task.id); return { reason: 'aborted' }; };
      await startPlanning(ids.task.id);
      expect(useTeamStore.getState().tasks[0].status).toBe('blocked');

      // 重新拆解 (task detail resets the status, then replans) must actually run.
      runBehavior = async () => {
        const current = useTeamStore.getState().tasks[0];
        if (current.status === 'awaiting_plan' && !current.plan) {
          useTeamStore.getState().proposePlan(ids.task.id, {
            items: [{ id: '1', memberRoleId: 'role-w', what: '写', dependsOn: [], state: 'pending' }],
            doneWhen: [],
          });
        }
        return { reason: 'completed' };
      };
      useTeamStore.getState().updateTaskStatus(ids.task.id, 'awaiting_plan');
      await startPlanning(ids.task.id);

      const after = useTeamStore.getState().tasks[0];
      expect(after.plan?.items).toHaveLength(1);
      expect(after.status).toBe('pending_review');
      expect(after.plan?.items[0].state).toBe('done');
    });
  });

  describe('unattended autonomy tier (review finding: dropped permissionMode)', () => {
    it('pins the task permission mode on every conversation the task creates', async () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'role-l', memberRoleIds: ['role-w'] });
      registryAgents['leader'] = { name: 'leader', description: 'lead', roleId: 'role-l', filePath: '/a/leader/AGENT.md', systemPrompt: '' };
      registryAgents['writer'] = { name: 'writer', description: 'write', roleId: 'role-w', filePath: '/a/writer/AGENT.md', systemPrompt: '' };
      runBehavior = async () => {
        const task = useTeamStore.getState().tasks[0];
        if (!task.plan) {
          useTeamStore.getState().proposePlan(task.id, {
            items: [{ id: '1', memberRoleId: 'role-w', what: '写', dependsOn: [], state: 'pending' }],
            doneWhen: [],
          });
        }
        return { reason: 'completed' };
      };
      const result = await runScheduledTeamTask(team.id, '每周出周报', {
        permissionMode: 'autonomous',
        dispatch: {},
        authorizeFolder: () => {},
        getDenials: () => [],
      });
      expect(result.ok).toBe(true);
      // Planning conversation + the member conversation both pinned.
      expect(permissionModeCalls.length).toBe(createConversationCalls.length);
      expect(permissionModeCalls.every((call) => call.mode === 'autonomous')).toBe(true);
    });

    it('leaves the mode untouched for an ordinary interactive task', async () => {
      const ids = seed();
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [{ id: '1', memberRoleId: 'role-w', what: '写', dependsOn: [], state: 'pending' }],
        doneWhen: [],
      });
      await confirmAndExecute(ids.task.id);
      expect(permissionModeCalls).toHaveLength(0);
    });
  });

  describe('partial re-settle (review finding: task stranded in running)', () => {
    function stoppedPair() {
      const ids = seed();
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [
          { id: '1', memberRoleId: 'role-w', what: 'a', dependsOn: [], state: 'pending' },
          { id: '2', memberRoleId: 'role-w', what: 'b', dependsOn: [], state: 'pending' },
        ],
        doneWhen: [],
      });
      return ids;
    }

    it('a retry that succeeds while a sibling is still stopped returns the task to blocked', async () => {
      const ids = stoppedPair();
      runBehavior = async () => ({ reason: 'aborted' });
      await confirmAndExecute(ids.task.id);
      useTeamStore.getState().setItemState(ids.task.id, '1', 'stopped');
      useTeamStore.getState().setItemState(ids.task.id, '2', 'stopped');
      useTeamStore.getState().updateTaskStatus(ids.task.id, 'blocked');

      runBehavior = async () => ({ reason: 'completed' });
      await retryItem(ids.task.id, '1');

      const after = useTeamStore.getState().tasks[0];
      // Nothing is running, so the task must NOT claim to be running — the
      // per-item 重试 buttons are gated on 'blocked'.
      expect(after.status).toBe('blocked');
      expect(after.plan?.items.map((item) => item.state)).toEqual(['done', 'stopped']);

      // ...and the second retry then finishes the task.
      await retryItem(ids.task.id, '2');
      expect(useTeamStore.getState().tasks[0].status).toBe('pending_review');
    });

    it('stopping a running task marks every unfinished item stopped so each keeps a retry', async () => {
      const ids = stoppedPair();
      runBehavior = async () => { stopTask(ids.task.id); return { reason: 'aborted' }; };
      await confirmAndExecute(ids.task.id);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('blocked');
      expect(after.plan?.items.every((item) => item.state === 'stopped')).toBe(true);
    });
  });

  describe('rework abort (review finding: 停止 did not reach rejectTask)', () => {
    it('registers an abort controller and does not resurrect a stopped rework', async () => {
      const ids = seed();
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [{ id: '1', memberRoleId: 'role-w', what: '写', dependsOn: [], state: 'pending' }],
        doneWhen: [],
      });
      runBehavior = async () => ({ reason: 'completed' });
      await confirmAndExecute(ids.task.id);
      expect(useTeamStore.getState().tasks[0].status).toBe('pending_review');

      let sawController = false;
      runBehavior = async (_conversationId: string, _message: string, options?: { onAbortControllerReady?: (c: AbortController) => void }) => {
        sawController = typeof options?.onAbortControllerReady === 'function';
        stopTask(ids.task.id);
        return { reason: 'aborted' };
      };
      await rejectTask(ids.task.id, '再改改');

      expect(sawController).toBe(true);
      const after = useTeamStore.getState().tasks[0];
      expect(after.status).toBe('blocked');
      expect(after.plan?.items[0].state).toBe('stopped');
    });
  });

  describe('unattended envelope (review finding: mode alone still hangs)', () => {
    it('spreads the auto-deny envelope into every run and authorizes the task folder', async () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'role-l', memberRoleIds: ['role-w'] });
      registryAgents['leader'] = { name: 'leader', description: 'lead', roleId: 'role-l', filePath: '/a/leader/AGENT.md', systemPrompt: '' };
      registryAgents['writer'] = { name: 'writer', description: 'write', roleId: 'role-w', filePath: '/a/writer/AGENT.md', systemPrompt: '' };
      runBehavior = async () => {
        const current = useTeamStore.getState().tasks[0];
        if (!current.plan) {
          useTeamStore.getState().proposePlan(current.id, {
            items: [{ id: '1', memberRoleId: 'role-w', what: '写', dependsOn: [], state: 'pending' }],
            doneWhen: [],
          });
        }
        return { reason: 'completed' };
      };
      const authorized: string[] = [];
      const commandConfirmCallback = vi.fn(async () => false);
      const filePermissionCallback = vi.fn(async () => false);
      const outcome = await runScheduledTeamTask(team.id, '每周出周报', {
        permissionMode: 'autonomous',
        dispatch: {
          commandConfirmCallback,
          filePermissionCallback,
          blockedTools: ['request_workspace'],
          authorizationScopeId: 'scope-1',
        },
        authorizeFolder: (folder) => { authorized.push(folder); },
        getDenials: () => [],
      });

      expect(outcome.ok).toBe(true);
      // Planning AND member runs both carry the auto-deny callbacks — an
      // unattended run must never reach the interactive approval path.
      expect(runCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of runCalls) {
        expect(call.options?.commandConfirmCallback).toBe(commandConfirmCallback);
        expect(call.options?.filePermissionCallback).toBe(filePermissionCallback);
        expect(call.options?.authorizationScopeId).toBe('scope-1');
      }
      // The folder members write into is authorized once it exists.
      expect(authorized).toHaveLength(1);
      expect(authorized[0]).toContain('abu-team');
    });

    it('names the auto-denied actions in the failure reason', async () => {
      const team = useTeamStore.getState().createTeam({ name: 't', leaderRoleId: 'role-l', memberRoleIds: ['role-w'] });
      registryAgents['leader'] = { name: 'leader', description: 'lead', roleId: 'role-l', filePath: '/a/leader/AGENT.md', systemPrompt: '' };
      runBehavior = async () => ({ reason: 'completed' }); // leader never proposes → blocked
      const outcome = await runScheduledTeamTask(team.id, '出周报', {
        dispatch: {},
        authorizeFolder: () => {},
        getDenials: () => ['blocked: rm -rf /tmp/x'],
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('rm -rf /tmp/x');
    });

    it('leaves an ordinary interactive run with no envelope', async () => {
      const ids = seed();
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [{ id: '1', memberRoleId: 'role-w', what: '写', dependsOn: [], state: 'pending' }],
        doneWhen: [],
      });
      await confirmAndExecute(ids.task.id);
      expect(runCalls.every((call) => call.options?.commandConfirmCallback === undefined)).toBe(true);
    });
  });

  describe('retry ordering (review finding: stopped items broke the wave invariant)', () => {
    it('refuses to retry an item whose upstream never finished', async () => {
      const ids = seed();
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [
          { id: '1', memberRoleId: 'role-w', what: '取数', dependsOn: [], state: 'pending' },
          { id: '2', memberRoleId: 'role-w', what: '写稿', dependsOn: ['1'], state: 'pending' },
        ],
        doneWhen: [],
      });
      runBehavior = async () => { stopTask(ids.task.id); return { reason: 'aborted' }; };
      await confirmAndExecute(ids.task.id);
      const items = useTeamStore.getState().tasks[0].plan?.items ?? [];
      expect(items.every((item) => item.state === 'stopped')).toBe(true);
      expect(dependenciesSatisfied(items[1], items)).toBe(false);

      runCalls.length = 0;
      runBehavior = async () => ({ reason: 'completed' });
      await retryItem(ids.task.id, '2'); // downstream first — must be refused
      expect(runCalls).toHaveLength(0);

      await retryItem(ids.task.id, '1'); // upstream is retryable
      expect(runCalls).toHaveLength(1);
      const after = useTeamStore.getState().tasks[0].plan?.items ?? [];
      expect(dependenciesSatisfied(after[1], after)).toBe(true);
    });
  });

  describe('conversation tagging', () => {
    it('tags the planning conversation with teamTaskId', async () => {
      const ids = seed();
      createConversationCalls.length = 0;
      await startPlanning(ids.task.id);
      expect(createConversationCalls).toHaveLength(1);
      expect(createConversationCalls[0].options?.teamTaskId).toBe(ids.task.id);
      expect(createConversationCalls[0].options?.skipActivate).toBe(true);
    });

    it('tags every member run conversation with teamTaskId', async () => {
      const ids = seed();
      useTeamStore.getState().proposePlan(ids.task.id, {
        items: [
          { id: '1', memberRoleId: 'role-w', what: '取数', dependsOn: [], state: 'pending' },
          { id: '2', memberRoleId: 'role-l', what: '写稿', dependsOn: ['1'], state: 'pending' },
        ],
        doneWhen: [],
      });
      createConversationCalls.length = 0;
      await confirmAndExecute(ids.task.id);
      expect(createConversationCalls).toHaveLength(2);
      for (const call of createConversationCalls) {
        expect(call.options?.teamTaskId).toBe(ids.task.id);
      }
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
