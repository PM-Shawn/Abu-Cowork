/**
 * Scheduler output-delivery tests (review finding [2]).
 *
 * Mirrors the trigger delivery tests: a scheduled run that hit the turn cap
 * (max_turns) still produced a usable partial answer, so its output must still be
 * pushed to the configured IM channel (flagged incomplete). no_progress / aborted
 * have no usable output and must NOT be delivered.
 *
 * runAgentLoop is mocked so we control the exit reason; outputSender is mocked so
 * `buildMessage` being called is the observable "delivery happened" signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useScheduleStore } from '../../stores/scheduleStore';
import { useChatStore } from '../../stores/chatStore';
import type { ScheduledTask } from '../../types/schedule';
import type { ConfirmationInfo } from '../tools/registry';
import { initLanguage } from '../../i18n';
import { checkReadPath, checkWritePath, revokeWorkspace } from '../tools/pathSafety';

// Mock agentLoop — control the exit reason. isIncompleteReason is a trivial pure
// fn (tested in agentLoop.test.ts); duplicate it here to avoid importing the real
// heavy module and its dependency tree.
vi.mock('../agent/agentLoop', () => ({
  runAgentLoop: vi.fn(),
  isIncompleteReason: (r: string) => r === 'max_turns' || r === 'no_progress',
}));

// Mock outputSender — buildMessage being called means delivery was entered.
vi.mock('../im/outputSender', () => ({
  outputSender: {
    buildMessage: vi.fn().mockReturnValue('test message'),
    send: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// Mock notifications (avoid Tauri)
vi.mock('../../utils/notifications', () => ({
  notifyScheduledTaskCompleted: vi.fn(),
  notifyScheduledTaskError: vi.fn(),
}));

// Import after mocks
import { schedulerEngine } from './scheduler';
import { runAgentLoop } from '../agent/agentLoop';
import { outputSender } from '../im/outputSender';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    prompt: 'do something',
    schedule: { frequency: 'daily', time: { hour: 9, minute: 0 } },
    status: 'active',
    // Output configured so the delivery path (pushToIMChannel → buildMessage) is reachable
    outputChannelId: 'channel-1',
    outputChatIds: 'chat-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runs: [],
    totalRuns: 0,
    ...overrides,
  };
}

function latestRunStatus(taskId: string): string | undefined {
  const runs = useScheduleStore.getState().tasks[taskId]?.runs ?? [];
  return runs[runs.length - 1]?.status;
}

describe('SchedulerEngine output delivery by exit reason', () => {
  beforeEach(() => {
    useScheduleStore.setState({ tasks: {} });
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      thinkingStartTime: null,
    });
    vi.clearAllMocks();
  });

  it('delivers output when the run hit the turn cap (max_turns)', async () => {
    const task = makeTask({ id: 'task-maxturns' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'max_turns' });

    await schedulerEngine.runNow(task.id);

    expect(outputSender.buildMessage).toHaveBeenCalled();
    expect(latestRunStatus(task.id)).toBe('completed');
  });

  it('does NOT deliver output on no_progress (degenerate result)', async () => {
    const task = makeTask({ id: 'task-noprogress' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'no_progress' });

    await schedulerEngine.runNow(task.id);

    expect(outputSender.buildMessage).not.toHaveBeenCalled();
    expect(latestRunStatus(task.id)).toBe('error');
  });

  it('does NOT deliver output on aborted', async () => {
    const task = makeTask({ id: 'task-aborted' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'aborted' });

    await schedulerEngine.runNow(task.id);

    expect(outputSender.buildMessage).not.toHaveBeenCalled();
    expect(latestRunStatus(task.id)).toBe('error');
  });
});

// ── Unattended autonomy tier (permission plan §3 + §7 decision B) ──
//
// Before this, the scheduler hard-coded "deny anything that needs asking" and
// reported a bare "failed". Two things are pinned here: the task's tier
// actually decides what runs, and whatever it refused reaches the run's result
// text so the user can act on it.
describe('SchedulerEngine permission tier', () => {
  beforeEach(() => {
    useScheduleStore.setState({ tasks: {} });
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      thinkingStartTime: null,
    });
    vi.clearAllMocks();
    initLanguage('zh-CN');
    // authorizeWorkspace is a module-level map that outlives a single test.
    revokeWorkspace('/Users/testuser/Projects/report');
    revokeWorkspace('/Users/testuser/Projects/safe-report');
  });

  /** Drive the run's confirmation callback, then end the run with `reason`. */
  function runWithProbe(
    probe: (options: {
      commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
    }) => Promise<void>,
    reason: 'error' | 'completed' = 'error',
  ) {
    vi.mocked(runAgentLoop).mockImplementation(async (_conv, _msg, options) => {
      await probe(options as never);
      return { reason, error: reason === 'error' ? 'boom' : undefined } as never;
    });
  }

  function latestRunError(taskId: string): string | undefined {
    const runs = useScheduleStore.getState().tasks[taskId]?.runs ?? [];
    return runs[runs.length - 1]?.error;
  }

  it('read_tools refuses commands and says so in the result text', async () => {
    const task = makeTask({ id: 'task-read', permissionMode: 'read_tools' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let allowed: boolean | undefined;
    runWithProbe(async (options) => {
      allowed = await options.commandConfirmCallback({
        command: 'ls -la', level: 'safe', reason: '',
      });
    });

    await schedulerEngine.runNow(task.id);

    expect(allowed).toBe(false);
    expect(latestRunError(task.id)).toContain('只看不动');
    expect(latestRunError(task.id)).toContain('ls -la');
  });

  it('full lets a non-blocked command through', async () => {
    const task = makeTask({ id: 'task-full', permissionMode: 'full' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let allowed: boolean | undefined;
    runWithProbe(async (options) => {
      allowed = await options.commandConfirmCallback({
        command: 'npm run build', level: 'warn', reason: '',
      });
    });

    await schedulerEngine.runNow(task.id);

    expect(allowed).toBe(true);
  });

  it('names the site when a browser action is refused', async () => {
    // Browser gating reaches the scheduler through the same confirmation
    // callback (registry passes kind: 'browser' + the origin), which is what
    // makes the "authorize it in Settings" hint possible with no extra layer.
    const task = makeTask({ id: 'task-browser', permissionMode: 'safe_tools' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async (options) => {
      await options.commandConfirmCallback({
        command: 'abu-browser__click (https://example.com)',
        level: 'warn',
        reason: '',
        kind: 'browser',
        browserOrigin: 'https://example.com',
      });
    });

    await schedulerEngine.runNow(task.id);

    expect(latestRunError(task.id)).toContain('https://example.com');
    expect(latestRunError(task.id)).toContain('设置');
  });

  it('falls back to the safe default when a task predates the field', async () => {
    const task = makeTask({ id: 'task-legacy' });
    delete (task as { permissionMode?: unknown }).permissionMode;
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let allowed: boolean | undefined;
    runWithProbe(async (options) => {
      allowed = await options.commandConfirmCallback({
        command: 'ls', level: 'safe', reason: '',
      });
    });

    await schedulerEngine.runNow(task.id);

    expect(allowed).toBe(false);
    expect(latestRunError(task.id)).toContain('只看不动');
  });

  it('read_tools does not gain write access to its own workspace', async () => {
    // resolveTriggerCallbacks pre-authorizes workspacePath with read+write for
    // every tier, and an authorized workspace short-circuits checkWritePath
    // before the file callback runs — so delegating the pre-authorization
    // would have made "reads information, changes nothing" a lie.
    const task = makeTask({
      id: 'task-ws',
      permissionMode: 'read_tools',
      workspacePath: '/Users/testuser/Projects/report',
    });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {});

    await schedulerEngine.runNow(task.id);

    const write = await checkWritePath('/Users/testuser/Projects/report/out.md');
    expect(write.allowed).not.toBe(true);
    // Reading is the whole point of the tier, so that stays open.
    expect((await checkReadPath('/Users/testuser/Projects/report/in.md')).allowed).toBe(true);
  });

  it('safe_tools does get write access to its workspace', async () => {
    const task = makeTask({
      id: 'task-ws-write',
      permissionMode: 'safe_tools',
      workspacePath: '/Users/testuser/Projects/safe-report',
    });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {});

    await schedulerEngine.runNow(task.id);

    const write = await checkWritePath('/Users/testuser/Projects/safe-report/out.md');
    expect(write.allowed).toBe(true);
  });

  it('leaves the result text alone when nothing was refused', async () => {
    const task = makeTask({ id: 'task-clean', permissionMode: 'read_tools' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {});

    await schedulerEngine.runNow(task.id);

    expect(latestRunError(task.id)).toBe('boom');
  });
});
