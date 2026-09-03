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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useScheduleStore } from '../../stores/scheduleStore';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ScheduledTask } from '../../types/schedule';
import type { ConfirmationInfo } from '../tools/registry';
import { initLanguage } from '../../i18n';
import { checkWritePath, hasFullShellAuthorizationScope, revokeWorkspace } from '../tools/pathSafety';
import { checkToolApproval } from '../tools/registry';

const getSchedulerToolsMock = vi.fn(() => [
  { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'github__list_repositories', description: 'mcp read', inputSchema: { type: 'object', properties: {} } },
  { name: 'github__delete_repository', description: 'mcp destructive', inputSchema: { type: 'object', properties: {} } },
  { name: 'computer', description: 'foreground UI', inputSchema: { type: 'object', properties: {} } },
]);
vi.mock('../agent/ports/toolInvoker', () => ({
  getToolInvoker: () => ({
    getAllTools: () => getSchedulerToolsMock(),
    executeAnyTool: vi.fn(),
    toolResultToString: (value: unknown) => String(value),
  }),
}));

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
import {
  buildBrowserSignalContext,
  buildBrowserSignalRecord,
  clearBrowserSignals,
  clearSchedulerDriftSignals,
  getRecentSchedulerDriftSignals,
  recordBrowserSignal,
} from '../observability/browserSignals';
import { isBrowserRunReportMessage } from '../observability/browserRunReport';
import type { Message } from '../../types';

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

  // A run that stopped ITSELF after consecutive browser refusals is not the
  // same event as a user pressing Stop, and the run history is the only place
  // the user sees either. Without this the abort cause the guard records has
  // no reader at all, and the run reads as a bare "Task was cancelled".
  it('names the consecutive-browser-denial cause in the run result', async () => {
    const task = makeTask({ id: 'task-browser-denials' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({
      reason: 'aborted',
      abortCause: 'consecutive_browser_denials',
    } as never);

    await schedulerEngine.runNow(task.id);

    const runs = useScheduleStore.getState().tasks[task.id]?.runs ?? [];
    // The suite runs under en-US; the zh-CN string names 浏览器操作 the same way.
    expect(runs[runs.length - 1]?.error).toContain('browser actions were refused');
    expect(runs[runs.length - 1]?.error).not.toContain('Task was cancelled');
  });
});

// ── U7: the unattended task report card ───────────────────────────────────
//
// The one part of the unattended feature a person actually reads. Everything
// else works or refuses silently; if the card is missing, empty, or about the
// wrong run, the user's verdict on the whole night is "it did nothing".
describe('SchedulerEngine run report card', () => {
  /** Every terminal path leads here, so the card is emitted from `finally`. */
  function cardsIn(conversationId: string): Message[] {
    const conv = useChatStore.getState().conversations[conversationId];
    return (conv?.messages ?? []).filter(isBrowserRunReportMessage);
  }

  function conversationsForTask(taskId: string): string[] {
    return (useScheduleStore.getState().tasks[taskId]?.runs ?? [])
      .map((run) => run.conversationId)
      .filter((id): id is string => typeof id === 'string');
  }

  beforeEach(() => {
    useScheduleStore.setState({ tasks: {} });
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      currentUsage: null,
      pendingInput: null,
      agentStates: new Map(),
    });
    clearBrowserSignals();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearBrowserSignals();
  });

  it('appends a card describing the run that just touched the browser', async () => {
    const task = makeTask({ id: 'task-report' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    // The conversation is created inside executeTask, so resolve its id lazily.
    vi.mocked(runAgentLoop).mockImplementation(async (conversationId: string) => {
      recordBrowserSignal(
        buildBrowserSignalRecord(
          {
            kind: 'tool_call',
            tool: 'abu-browser__navigate',
            ok: true,
            durationMs: 5,
            origin: 'https://intranet.example',
          },
          buildBrowserSignalContext('builtin', conversationId, 1_700_000_000_000),
        ),
      );
      return { reason: 'completed' } as never;
    });

    await schedulerEngine.runNow(task.id);

    const [conversationId] = conversationsForTask(task.id);
    const cards = cardsIn(conversationId);
    expect(cards).toHaveLength(1);
    expect(cards[0].browserRunReport).toMatchObject({
      outcome: 'completed',
      actions: { total: 1, failed: 0 },
      sites: [{ origin: 'https://intranet.example', actions: 1, failures: 0 }],
    });
  });

  it('does NOT append a card to a run that never touched the browser', async () => {
    const task = makeTask({ id: 'task-no-browser' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'completed' });

    await schedulerEngine.runNow(task.id);

    const [conversationId] = conversationsForTask(task.id);
    expect(cardsIn(conversationId)).toHaveLength(0);
  });

  it('reports a run that was refused everything — the master switch case', async () => {
    // R1 §1.2: "the report records that it was skipped because the master
    // switch is off, never silently". The run looks successful and did nothing.
    const task = makeTask({ id: 'task-master-off' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockImplementation(async (conversationId: string) => {
      recordBrowserSignal(
        buildBrowserSignalRecord(
          {
            kind: 'gate_denied',
            tool: 'abu-browser__navigate',
            opClass: 'interactive',
            reason: 'master-switch-off',
            runMode: 'unattended',
          },
          buildBrowserSignalContext('builtin', conversationId, 1_700_000_000_000),
        ),
      );
      return { reason: 'completed' } as never;
    });

    await schedulerEngine.runNow(task.id);

    const card = cardsIn(conversationsForTask(task.id)[0])[0];
    expect(card.browserRunReport?.skippedByMasterSwitch).toBe(true);
    expect(card.browserRunReport?.nextSteps).toContain('enable-master-switch');
  });

  it('still reports a run that FAILED — the terminal most worth explaining', async () => {
    const task = makeTask({ id: 'task-failed' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockImplementation(async (conversationId: string) => {
      recordBrowserSignal(
        buildBrowserSignalRecord(
          {
            kind: 'tool_call',
            tool: 'abu-browser__click',
            ok: false,
            durationMs: 5,
            errorClass: 'timeout',
            origin: 'https://intranet.example',
          },
          buildBrowserSignalContext('builtin', conversationId, 1_700_000_000_000),
        ),
      );
      return { reason: 'error', error: 'boom', messageTaken: true } as never;
    });

    await schedulerEngine.runNow(task.id);

    const card = cardsIn(conversationsForTask(task.id)[0])[0];
    expect(card.browserRunReport?.outcome).toBe('error');
    expect(card.browserRunReport?.actions).toEqual({ total: 1, failed: 1 });
  });

  it('names the consecutive-denial abort in the card, not just in the run history', async () => {
    const task = makeTask({ id: 'task-denial-abort' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockImplementation(async (conversationId: string) => {
      recordBrowserSignal(
        buildBrowserSignalRecord(
          {
            kind: 'gate_denied',
            tool: 'abu-browser__execute_js',
            opClass: 'scripting',
            reason: 'approval-refused',
            runMode: 'unattended',
          },
          buildBrowserSignalContext('builtin', conversationId, 1_700_000_000_000),
        ),
      );
      return { reason: 'aborted', abortCause: 'consecutive_browser_denials' } as never;
    });

    await schedulerEngine.runNow(task.id);

    expect(cardsIn(conversationsForTask(task.id)[0])[0].browserRunReport?.outcome)
      .toBe('aborted-denials');
  });

  /**
   * Ruling 2, at the real integration point — and the invariant it pins is
   * the SEQ CURSOR, not the conversation id.
   *
   * This test used to let the scheduler mint a conversation per run, so the
   * conversation predicate alone separated them and a mutant that deleted
   * `seq > sinceSeq` still passed here (verified: only the aggregation-layer
   * case went red). Both runs now share ONE conversation — the case Ruling 2
   * actually exists for — so the cursor is the only thing keeping yesterday's
   * actions out of today's card.
   */
  it('does not put the previous run\'s actions in the next run\'s card', async () => {
    const task = makeTask({ id: 'task-two-runs' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });

    // Pin both runs to one conversation. A conversation CAN host more than one
    // run (a person types a follow-up into a scheduled task's conversation; an
    // IM session is long-lived); the scheduler simply does not reuse one
    // today, which is why this had to be forced to test the real invariant.
    const shared = useChatStore.getState().createConversation(null, {
      scheduledTaskId: task.id,
      skipActivate: true,
    });
    const realCreateConversation = useChatStore.getState().createConversation;
    useChatStore.setState({ createConversation: (() => shared) as never });

    let origin = 'https://first.example';
    vi.mocked(runAgentLoop).mockImplementation(async (conversationId: string) => {
      recordBrowserSignal(
        buildBrowserSignalRecord(
          { kind: 'tool_call', tool: 'abu-browser__navigate', ok: true, durationMs: 5, origin },
          buildBrowserSignalContext('builtin', conversationId, 1_700_000_000_000),
        ),
      );
      return { reason: 'completed' } as never;
    });

    try {
      await schedulerEngine.runNow(task.id);
      origin = 'https://second.example';
      await schedulerEngine.runNow(task.id);
    } finally {
      useChatStore.setState({ createConversation: realCreateConversation });
    }

    // Both runs used the same conversation, and both cards landed in it.
    expect(conversationsForTask(task.id)).toEqual([shared, shared]);
    const [first, second] = cardsIn(shared).map((m) => m.browserRunReport);
    expect(first?.sites.map((s) => s.origin)).toEqual(['https://first.example']);
    expect(second?.sites.map((s) => s.origin)).toEqual(['https://second.example']);
    // The failure this pins: yesterday's actions showing up in today's report.
    expect(second?.actions.total).toBe(1);
    expect(JSON.stringify(second)).not.toContain('first.example');
    expect(JSON.stringify(first)).not.toContain('second.example');
  });

  // The card carries no text on purpose, and `pushToIMChannel` extracts the
  // LAST message. Appending before the push would send an empty IM message
  // instead of the answer the task produced.
  it('appends the card after the IM push has read the last message', async () => {
    const task = makeTask({ id: 'task-push-order' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockImplementation(async (conversationId: string) => {
      recordBrowserSignal(
        buildBrowserSignalRecord(
          { kind: 'tool_call', tool: 'abu-browser__navigate', ok: true, durationMs: 5, origin: 'https://a.example' },
          buildBrowserSignalContext('builtin', conversationId, 1_700_000_000_000),
        ),
      );
      return { reason: 'completed' } as never;
    });
    let cardsAtPushTime = -1;
    vi.mocked(outputSender.buildMessage).mockImplementation(((convId: string) => {
      cardsAtPushTime = cardsIn(convId).length;
      return 'test message';
    }) as never);

    await schedulerEngine.runNow(task.id);

    expect(cardsAtPushTime).toBe(0);
    expect(cardsIn(conversationsForTask(task.id)[0])).toHaveLength(1);
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

  it('creates a full shell authorization scope for autonomous tasks', async () => {
    const task = makeTask({ id: 'task-full-scope', permissionMode: 'autonomous' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let scopeWasFull: boolean | undefined;
    runWithProbe(async (options) => {
      const scopeId = (options as { authorizationScopeId?: string }).authorizationScopeId;
      scopeWasFull = hasFullShellAuthorizationScope(scopeId);
    }, 'completed');

    await schedulerEngine.runNow(task.id);

    expect(scopeWasFull).toBe(true);
  });

  it('creates a full shell scope when an unset task follows global autonomous mode', async () => {
    useSettingsStore.setState({ permissionMode: 'autonomous' });
    const task = makeTask({ id: 'task-follow-full', permissionMode: undefined });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let scopeWasFull: boolean | undefined;
    runWithProbe(async (options) => {
      const scopeId = (options as { authorizationScopeId?: string }).authorizationScopeId;
      scopeWasFull = hasFullShellAuthorizationScope(scopeId);
    }, 'completed');

    await schedulerEngine.runNow(task.id);

    expect(scopeWasFull).toBe(true);
  });

  it('leaves the conversation permissionMode unset when the task follows global settings', async () => {
    const task = makeTask({ id: 'task-follow' }); // permissionMode undefined
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {}, 'completed');

    await schedulerEngine.runNow(task.id);

    const conversationId = latestRun(task.id)?.conversationId;
    expect(useChatStore.getState().conversations[conversationId!]?.permissionMode).toBeUndefined();
  });

  it('freezes the exact runtime tool snapshot into both dispatch filters and the ceiling', async () => {
    const task = makeTask({ id: 'task-roster', permissionMode: 'autonomous' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let capturedOptions: Record<string, unknown> | undefined;
    vi.mocked(runAgentLoop).mockImplementation(async (_conv, _msg, options) => {
      capturedOptions = options as unknown as Record<string, unknown>;
      return { reason: 'completed' };
    });

    await schedulerEngine.runNow(task.id);

    expect(capturedOptions?.allowedTools).toEqual([
      'read_file',
      'github__list_repositories',
      'github__delete_repository',
      'computer',
    ]);
    expect(capturedOptions?.allowedTools).not.toContain('get_system_info');
    expect(capturedOptions?.allowedTools).not.toContain('*');
    expect(capturedOptions?.runPermissionCeiling).toEqual({
      version: 1,
      source: 'scheduler',
      capability: 'scheduled',
      allowedTools: capturedOptions?.allowedTools,
    });
    expect(Object.isFrozen(capturedOptions?.runPermissionCeiling)).toBe(true);
    expect(Object.isFrozen(capturedOptions?.allowedTools)).toBe(true);
  });

  it('records a roster snapshot failure and releases the scheduled-run owner', async () => {
    const task = makeTask({ id: 'task-roster-failure' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    getSchedulerToolsMock.mockImplementationOnce(() => {
      throw new Error('tool snapshot unavailable');
    });

    await expect(schedulerEngine.runNow(task.id)).resolves.toBeUndefined();

    expect(latestRunStatus(task.id)).toBe('error');
    expect(schedulerEngine.isTaskRunning(task.id)).toBe(false);
    expect(runAgentLoop).not.toHaveBeenCalled();
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

  // The gate now refuses unattended browser actions itself instead of refusing
  // by way of a callback that answered false — so it NOTIFIES the run's
  // callback (ConfirmationInfo.deniedNotice) to keep this accounting alive.
  // Without it a 3am task would report "failed" and nothing else. These drive
  // the REAL gate so the whole chain is covered, not just the recorder.
  describe('unattended browser refusals still explain themselves in the run result', () => {
    /**
     * Production shape on purpose: a real scheduled run carries the
     * run-permission ceiling the scheduler builds, and the ceiling refuses
     * browser actions BEFORE the operation-policy branch does. A harness that
     * passed only `{conversationId}` would never exercise that path — which is
     * exactly how an untranslated, unactionable ceiling diagnostic reached the
     * run result unnoticed.
     */
    function runWithRealGate(toolName: string, input: Record<string, unknown>) {
      // The scheduled ceiling's roster is a snapshot of the tools that existed
      // at dispatch, so a browser tool has to be in it or the run is refused
      // one layer earlier, for an unrelated reason.
      getSchedulerToolsMock.mockReturnValueOnce([
        { name: toolName, description: 'browser', inputSchema: { type: 'object', properties: {} } },
      ] as never);
      vi.mocked(runAgentLoop).mockImplementation(async (conversationId, _msg, options) => {
        const opts = options as {
          commandConfirmCallback: never;
          runPermissionCeiling?: unknown;
        };
        await checkToolApproval(
          toolName,
          input,
          {
            conversationId,
            runPermissionCeiling: opts.runPermissionCeiling,
          } as never,
          opts.commandConfirmCallback,
        );
        return { reason: 'error', error: 'boom' } as never;
      });
    }

    it('names the master switch and the site when unattended browser use is off', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: false,
        browserSitePermissions: { 'https://example.com': 'allowed' },
      });
      const task = makeTask({ id: 'task-browser-master-off', permissionMode: 'autonomous' });
      useScheduleStore.setState({ tasks: { [task.id]: task } });
      runWithRealGate('abu-browser__navigate', { tabId: 1, url: 'https://example.com/report' });

      await schedulerEngine.runNow(task.id);

      expect(latestRunError(task.id)).toContain('https://example.com');
      expect(latestRunError(task.id)).toContain('设置');
    });

    it('stays localized and actionable even though the ceiling refuses first', async () => {
      // The scheduled ceiling denies browser before the policy branch runs, so
      // the notice must not inherit the ceiling's hardcoded English diagnostic
      // ('browser action is not permitted by the unattended browser policy') —
      // that names neither the master switch nor where to change it.
      useSettingsStore.setState({
        allowUnattendedBrowser: false,
        browserSitePermissions: { 'https://example.com': 'allowed' },
      });
      const task = makeTask({ id: 'task-browser-ceiling', permissionMode: 'autonomous' });
      useScheduleStore.setState({ tasks: { [task.id]: task } });
      runWithRealGate('abu-browser__navigate', { tabId: 1, url: 'https://example.com/report' });

      await schedulerEngine.runNow(task.id);

      const error = latestRunError(task.id);
      expect(error).toContain('https://example.com');
      expect(error).toContain('设置');
      expect(error).not.toContain('browser action is not permitted');
    });

    it('names the site when the run may use the browser but not on that site', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserSitePermissions: {},
      });
      const task = makeTask({ id: 'task-browser-site', permissionMode: 'autonomous' });
      useScheduleStore.setState({ tasks: { [task.id]: task } });
      runWithRealGate('abu-browser__navigate', { tabId: 1, url: 'https://unlisted.com/report' });

      await schedulerEngine.runNow(task.id);

      expect(latestRunError(task.id)).toContain('https://unlisted.com');
      expect(latestRunError(task.id)).toContain('无人值守');
    });
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

  it('authorizes the workspace only for the unattended run scope and disposes it after completion', async () => {
    const task = makeTask({
      id: 'task-ws',
      permissionMode: 'standard',
      workspacePath: '/Users/testuser/Projects/report',
    });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let scopedWriteAllowed: boolean | undefined;
    runWithProbe(async (options) => {
      const scopeId = (options as { authorizationScopeId?: string }).authorizationScopeId;
      expect(scopeId).toBeDefined();
      scopedWriteAllowed = (await checkWritePath('/Users/testuser/Projects/report/out.md', scopeId)).allowed;
    }, 'completed');

    await schedulerEngine.runNow(task.id);

    expect(scopedWriteAllowed).toBe(true);
    const writeAfterRun = await checkWritePath('/Users/testuser/Projects/report/out.md');
    expect(writeAfterRun.allowed).toBe(false);
    expect(writeAfterRun.needsPermission).toBe(true);
  });

  it('disposes the unattended run scope when the agent run throws', async () => {
    const task = makeTask({
      id: 'task-ws-throw',
      permissionMode: 'standard',
      workspacePath: '/Users/testuser/Projects/report',
    });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    let scopeId: string | undefined;
    let scopedWriteAllowedDuringRun: boolean | undefined;
    vi.mocked(runAgentLoop).mockImplementation(async (_conv, _msg, options) => {
      scopeId = (options as { authorizationScopeId?: string }).authorizationScopeId;
      expect(scopeId).toBeDefined();
      scopedWriteAllowedDuringRun = (await checkWritePath('/Users/testuser/Projects/report/out.md', scopeId)).allowed;
      throw new Error('agent exploded');
    });

    await schedulerEngine.runNow(task.id);

    expect(scopedWriteAllowedDuringRun).toBe(true);
    expect(latestRunError(task.id)).toContain('agent exploded');
    expect((await checkWritePath('/Users/testuser/Projects/report/out.md', scopeId)).allowed).toBe(false);
    expect((await checkWritePath('/Users/testuser/Projects/report/out.md')).allowed).toBe(false);
  });

  it('leaves the result text alone when nothing was refused', async () => {
    const task = makeTask({ id: 'task-clean', permissionMode: 'standard' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    runWithProbe(async () => {});

    await schedulerEngine.runNow(task.id);

    expect(latestRunError(task.id)).toBe('boom');
  });
});

// ── F1.4: scheduler trigger drift (batch 1, T5) ─────────────────────────
// "调度漂移" — planned fire time (task.nextRunAt, read BEFORE the run
// recomputes it in completeRun/errorRun) vs. actual fire time. Observation
// only: never gates or alters what the run does.
describe('SchedulerEngine trigger drift signal (F1.4)', () => {
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
    clearSchedulerDriftSignals();
  });

  afterEach(() => {
    clearSchedulerDriftSignals();
  });

  it('records planned vs. actual fire time when the task carries a nextRunAt', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_010_000); // fires 10s after its planned slot
      const task = makeTask({ id: 'task-drift', nextRunAt: 1_700_000_000_000 });
      useScheduleStore.setState({ tasks: { [task.id]: task } });
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'completed' });

      await schedulerEngine.runNow(task.id);

      const drifts = getRecentSchedulerDriftSignals();
      expect(drifts).toHaveLength(1);
      expect(drifts[0]).toMatchObject({
        kind: 'scheduler_drift',
        taskId: 'task-drift',
        plannedAt: 1_700_000_000_000,
        actualAt: 1_700_000_010_000,
        driftMs: 10_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not record a drift signal when the task has no nextRunAt (nothing to compare against)', async () => {
    const task = makeTask({ id: 'task-no-next-run' });
    delete (task as { nextRunAt?: number }).nextRunAt;
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'completed' });

    await schedulerEngine.runNow(task.id);

    expect(getRecentSchedulerDriftSignals()).toHaveLength(0);
  });

  it('still records the drift signal when the run ultimately errors (observation is independent of outcome)', async () => {
    const task = makeTask({ id: 'task-drift-error', nextRunAt: 1_700_000_000_000 });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'error', error: 'boom' });

    await schedulerEngine.runNow(task.id);

    expect(getRecentSchedulerDriftSignals()).toHaveLength(1);
  });

  it('never lets drift recording block or alter the run result', async () => {
    const task = makeTask({ id: 'task-drift-normal', nextRunAt: 1_700_000_000_000 });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'completed' });

    await schedulerEngine.runNow(task.id);

    expect(latestRunStatus(task.id)).toBe('completed');
  });
});
