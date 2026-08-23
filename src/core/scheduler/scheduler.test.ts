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
import { useSettingsStore } from '../../stores/settingsStore';
import type { ScheduledTask } from '../../types/schedule';
import type { ConfirmationInfo } from '../tools/registry';
import { initLanguage } from '../../i18n';
import { checkWritePath, revokeWorkspace } from '../tools/pathSafety';

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
    createdAt: 1_700_000_000_000, // filler (TESTING.md §3) — not read by scheduler.ts
    updatedAt: 1_700_000_000_000,
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
      currentUsage: null,
      pendingInput: null,
      agentStates: new Map(),
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

// ── Unattended autonomy tier (permission plan §3, redone per user
//    correction: reuse chat's own standard/smart/autonomous PermissionMode
//    instead of a scheduler-only vocabulary) ──
//
// Before the original tier existed, the scheduler hard-coded "deny anything
// that needs asking" and reported a bare "failed". Three things are pinned
// here: the run's conversation actually gets the task's mode (or none, to
// follow global settings), a "confirm"-requiring action is always denied
// (nobody unattended can click through a dialog) regardless of mode, and
// whatever got refused reaches the run's result text so the user can act on
// it.
describe('SchedulerEngine permission tier', () => {
  beforeEach(() => {
    useScheduleStore.setState({ tasks: {} });
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      currentUsage: null,
      pendingInput: null,
      agentStates: new Map(),
    });
    // Pin the global fallback mode so "follows settings" tests are deterministic.
    useSettingsStore.setState({ permissionMode: 'standard' });
    vi.clearAllMocks();
    initLanguage('zh-CN');
    // authorizeWorkspace is a module-level map that outlives a single test.
    revokeWorkspace('/Users/testuser/Projects/report');
  });

  /** Drive the run's confirmation callback, then end the run with `reason`. */
  function runWithProbe(
    probe: (options: {
      commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
      filePermissionCallback: (request: { path: string; capability: 'read' | 'write' }) => Promise<boolean>;
    }) => Promise<void>,
    reason: 'error' | 'completed' = 'error',
  ) {
    vi.mocked(runAgentLoop).mockImplementation(async (_conv, _msg, options) => {
      await probe(options as never);
      return { reason, error: reason === 'error' ? 'boom' : undefined } as never;
    });
  }

  function latestRun(taskId: string): { conversationId: string; error?: string } | undefined {
    const runs = useScheduleStore.getState().tasks[taskId]?.runs ?? [];
    return runs[runs.length - 1];
  }

  function latestRunError(taskId: string): string | undefined {
    return latestRun(taskId)?.error;
  }

  it('sets the run conversation permissionMode to the task\'s explicit mode', async () => {
    const task = makeTask({ id: 'task-explicit', permissionMode: 'autonomous' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {}, 'completed');

    await schedulerEngine.runNow(task.id);

    const conversationId = latestRun(task.id)?.conversationId;
    expect(conversationId).toBeDefined();
    expect(useChatStore.getState().conversations[conversationId!]?.permissionMode).toBe('autonomous');
  });

  it('leaves the conversation permissionMode unset when the task follows global settings', async () => {
    const task = makeTask({ id: 'task-follow' }); // permissionMode undefined
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {}, 'completed');

    await schedulerEngine.runNow(task.id);

    const conversationId = latestRun(task.id)?.conversationId;
    expect(useChatStore.getState().conversations[conversationId!]?.permissionMode).toBeUndefined();
  });

  it('denies a confirm-requiring command and names the effective mode in the result text', async () => {
    const task = makeTask({ id: 'task-standard', permissionMode: 'standard' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let allowed: boolean | undefined;
    runWithProbe(async (options) => {
      allowed = await options.commandConfirmCallback({
        command: 'rm -rf /tmp/x', level: 'danger', reason: '',
      });
    });

    await schedulerEngine.runNow(task.id);

    expect(allowed).toBe(false);
    // '请求批准' is settings.permissionModeStandard (zh-CN) — the exact label
    // PermissionModeChip shows in chat, not a scheduler-only word.
    expect(latestRunError(task.id)).toContain('请求批准');
    expect(latestRunError(task.id)).toContain('rm -rf /tmp/x');
  });

  it('denies a confirm-requiring file access and records the path', async () => {
    const task = makeTask({ id: 'task-file', permissionMode: 'standard' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let granted: boolean | undefined;
    runWithProbe(async (options) => {
      granted = await options.filePermissionCallback({ path: '/etc/hosts', capability: 'write' });
    });

    await schedulerEngine.runNow(task.id);

    expect(granted).toBe(false);
    expect(latestRunError(task.id)).toContain('/etc/hosts');
  });

  it('still denies a browser action in autonomous mode (hard floor) and names the site', async () => {
    // Browser gating reaches the scheduler through the same confirmation
    // callback (registry passes kind: 'browser' + the origin), which is what
    // makes the "authorize it in Settings" hint possible with no extra layer.
    // autonomous still routes this through the confirm gate — decideOtherTool
    // keeps browser/self-extension behind a hard floor in every mode.
    const task = makeTask({ id: 'task-browser', permissionMode: 'autonomous' });
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
    expect(latestRunError(task.id)).toContain('完全自主');
  });

  it('labels the denial with the global settings mode when the task follows settings', async () => {
    const task = makeTask({ id: 'task-legacy' });
    delete (task as { permissionMode?: unknown }).permissionMode;
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let allowed: boolean | undefined;
    runWithProbe(async (options) => {
      allowed = await options.commandConfirmCallback({
        command: 'ls', level: 'danger', reason: '',
      });
    });

    await schedulerEngine.runNow(task.id);

    expect(allowed).toBe(false);
    expect(latestRunError(task.id)).toContain('请求批准');
  });

  it('authorizes the workspace with full read+write regardless of mode (no read-only rung in this model)', async () => {
    const task = makeTask({
      id: 'task-ws',
      permissionMode: 'standard',
      workspacePath: '/Users/testuser/Projects/report',
    });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {}, 'completed');

    await schedulerEngine.runNow(task.id);

    const write = await checkWritePath('/Users/testuser/Projects/report/out.md');
    expect(write.allowed).toBe(true);
  });

  it('leaves the result text alone when nothing was refused', async () => {
    const task = makeTask({ id: 'task-clean', permissionMode: 'standard' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {});

    await schedulerEngine.runNow(task.id);

    expect(latestRunError(task.id)).toBe('boom');
  });
});
