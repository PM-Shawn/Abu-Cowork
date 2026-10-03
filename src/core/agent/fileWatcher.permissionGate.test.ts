import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { useChatStore } from '../../stores/chatStore';
import { initLanguage } from '../../i18n';
import { checkToolApproval, type ConfirmationInfo } from '../tools/registry';
import { TOOL_NAMES } from '../tools/toolNames';

const runAgentLoopDispatchedMock = vi.fn();

vi.mock('./agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatchedMock(...args),
}));

vi.mock('../observability/browserRunReportEmitter', () => ({
  emitBrowserRunReport: vi.fn(),
}));

const HOST_ROSTER = [TOOL_NAMES.RUN_COMMAND, TOOL_NAMES.READ_FILE, TOOL_NAMES.MANAGE_FILE_WATCH];
const getAllToolsMock = vi.fn(() => HOST_ROSTER.map((name) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
})));
vi.mock('./ports/toolInvoker', () => ({
  getToolInvoker: () => ({
    getAllTools: () => getAllToolsMock(),
    executeAnyTool: vi.fn(),
    toolResultToString: (value: unknown) => String(value),
  }),
}));

const builtinBrowserMocks = vi.hoisted(() => ({
  waitForBuiltinBrowserTools: vi.fn(async () => 'ready' as const),
}));
vi.mock('../browser/builtinBrowserRuntime', () => ({
  BUILTIN_BROWSER_SERVER_NAME: 'abu-browser',
  waitForBuiltinBrowserTools: builtinBrowserMocks.waitForBuiltinBrowserTools,
  ensureBuiltinBrowserRuntime: vi.fn(async () => false),
  initBuiltinBrowserRuntime: vi.fn(),
  cleanupBuiltinBrowserRuntime: vi.fn(async () => {}),
}));

import { handleWatchTrigger, type FileWatchRule } from './fileWatcher';

interface DispatchedOptions {
  commandConfirmCallback: (info: ConfirmationInfo, loopId?: string) => Promise<boolean>;
  filePermissionCallback: never;
  allowedTools?: string[];
  blockedTools?: string[];
  authorizationScopeId?: string;
  runPermissionCeiling?: unknown;
  initiatedBy?: string;
}

interface Observed {
  decision?: Awaited<ReturnType<typeof checkToolApproval>>;
  confirmationAsked: boolean;
  conversationId?: string;
  options?: DispatchedOptions;
}

/**
 * Drives the REAL tool gate with exactly the options the watcher dispatched,
 * the same way `scheduler.test.ts` does for scheduled runs.
 */
function dispatchThroughRealGate(toolName: string, input: Record<string, unknown>): Observed {
  const observed: Observed = { confirmationAsked: false };
  runAgentLoopDispatchedMock.mockImplementation(
    async (conversationId: string, _prompt: string, options: DispatchedOptions) => {
      observed.conversationId = conversationId;
      observed.options = options;
      observed.decision = await checkToolApproval(
        toolName,
        input,
        {
          conversationId,
          authorizationScopeId: options.authorizationScopeId,
          runPermissionCeiling: options.runPermissionCeiling,
          initiatedBy: options.initiatedBy,
          interactionMode: 'background',
        } as never,
        async (info, loopId) => {
          observed.confirmationAsked = true;
          return options.commandConfirmCallback(info, loopId);
        },
        options.filePermissionCallback,
      );
      return { reason: 'completed' };
    },
  );
  return observed;
}

describe('file watcher run authority', () => {
  const watchedDir = '/Users/testuser/Inbox';
  const riskyCommand = { command: 'rm -rf ./processed', cwd: watchedDir };
  let ruleSeq = 0;

  // handleWatchTrigger debounces per rule id; every case gets its own rule.
  function nextRule(): FileWatchRule {
    ruleSeq += 1;
    return {
      id: `watch-gate-${ruleSeq}`,
      path: watchedDir,
      event: 'any',
      prompt: 'Process {fileName}',
      enabled: true,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T10:00:00Z'));
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    initLanguage('zh-CN');
    runAgentLoopDispatchedMock.mockReset();
    getAllToolsMock.mockClear();
    builtinBrowserMocks.waitForBuiltinBrowserTools.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-denies a risky command under the global standard mode', async () => {
    setMigratedBrowserSettings({ permissionMode: 'standard' });
    const observed = dispatchThroughRealGate(TOOL_NAMES.RUN_COMMAND, riskyCommand);

    await handleWatchTrigger(nextRule(), `${watchedDir}/a.pdf`);

    expect(observed.confirmationAsked).toBe(true);
    expect(observed.decision?.decision).toBe('deny');
  });

  it('auto-denies a risky command under the global autonomous mode', async () => {
    setMigratedBrowserSettings({ permissionMode: 'autonomous' });
    const observed = dispatchThroughRealGate(TOOL_NAMES.RUN_COMMAND, riskyCommand);

    await handleWatchTrigger(nextRule(), `${watchedDir}/b.pdf`);

    expect(observed.confirmationAsked).toBe(true);
    expect(observed.decision?.decision).toBe('deny');
  });

  it('auto-denies a command writing outside the watched directory under the global autonomous mode', async () => {
    setMigratedBrowserSettings({ permissionMode: 'autonomous' });
    const observed = dispatchThroughRealGate(TOOL_NAMES.RUN_COMMAND, {
      command: 'cp report.pdf /Users/testuser/Desktop/report.pdf',
      cwd: watchedDir,
    });

    await handleWatchTrigger(nextRule(), `${watchedDir}/c.pdf`);

    expect(observed.decision?.decision).toBe('deny');
  });

  it('still runs an ordinary command inside the watched directory', async () => {
    setMigratedBrowserSettings({ permissionMode: 'autonomous' });
    const observed = dispatchThroughRealGate(TOOL_NAMES.RUN_COMMAND, {
      command: 'mkdir processed',
      cwd: watchedDir,
    });

    await handleWatchTrigger(nextRule(), `${watchedDir}/d.pdf`);

    expect(observed.confirmationAsked).toBe(false);
    expect(observed.decision?.decision).toBe('allow');
  });

  it('pins the run conversation to the standard mode whatever the global mode is', async () => {
    setMigratedBrowserSettings({ permissionMode: 'autonomous' });
    const observed = dispatchThroughRealGate(TOOL_NAMES.READ_FILE, { path: `${watchedDir}/e.pdf` });

    await handleWatchTrigger(nextRule(), `${watchedDir}/e.pdf`);

    expect(useChatStore.getState().conversations[observed.conversationId!]?.permissionMode).toBe('standard');
  });

  it('dispatches with a frozen scheduled ceiling built from the host roster', async () => {
    setMigratedBrowserSettings({ permissionMode: 'standard' });
    const observed = dispatchThroughRealGate(TOOL_NAMES.READ_FILE, { path: `${watchedDir}/f.pdf` });

    await handleWatchTrigger(nextRule(), `${watchedDir}/f.pdf`);

    expect(builtinBrowserMocks.waitForBuiltinBrowserTools).toHaveBeenCalledTimes(1);
    expect(observed.options?.allowedTools).toEqual(HOST_ROSTER);
    expect(observed.options?.runPermissionCeiling).toEqual({
      version: 1,
      source: 'scheduler',
      capability: 'scheduled',
      allowedTools: HOST_ROSTER,
    });
    expect(Object.isFrozen(observed.options?.runPermissionCeiling)).toBe(true);
    expect(observed.options?.blockedTools).toEqual([TOOL_NAMES.REQUEST_WORKSPACE]);
  });

  it('refuses a tool that was not in the host roster at dispatch', async () => {
    setMigratedBrowserSettings({ permissionMode: 'autonomous' });
    const observed = dispatchThroughRealGate('late_plugin__do_anything', {});

    await handleWatchTrigger(nextRule(), `${watchedDir}/g.pdf`);

    expect(observed.decision?.decision).toBe('deny');
    expect(observed.confirmationAsked).toBe(false);
  });

  it('refuses a self-extension tool at the ceiling, before any confirmation', async () => {
    setMigratedBrowserSettings({ permissionMode: 'autonomous' });
    const observed = dispatchThroughRealGate(TOOL_NAMES.MANAGE_FILE_WATCH, {
      action: 'add',
      path: '/Users/testuser/Documents',
      prompt: 'anything',
    });

    await handleWatchTrigger(nextRule(), `${watchedDir}/h.pdf`);

    expect(observed.decision?.decision).toBe('deny');
    expect(observed.confirmationAsked).toBe(false);
  });
});
