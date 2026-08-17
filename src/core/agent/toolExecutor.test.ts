import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolExecutionContext } from '@/types';
import type { EventRouter } from './eventRouter';
import type { ToolInvoker } from './ports/toolInvoker';

const mocks = vi.hoisted(() => ({
  updateToolCall: vi.fn(),
  setMessageToolCalls: vi.fn(),
  setAgentStatus: vi.fn(),
  executeAnyTool: vi.fn(),
  emitHook: vi.fn(),
  route: vi.fn(),
  setLoopContext: vi.fn(),
}));

vi.mock('./ports/chatDelta', () => ({
  getChatDelta: () => ({
    updateToolCall: mocks.updateToolCall,
    setMessageToolCalls: mocks.setMessageToolCalls,
    setAgentStatus: mocks.setAgentStatus,
  }),
}));

vi.mock('./lifecycleHooks', () => ({
  emitHook: (...args: unknown[]) => mocks.emitHook(...args),
}));

vi.mock('./planMode', () => ({
  getPlanMode: () => 'off',
  evaluatePlanGate: () => ({ allow: true }),
}));

vi.mock('../session/sessionMemory', () => ({
  processToolResult: async (_conversationId: string, _toolCallId: string, result: string) => ({
    stored: result,
    offloaded: false,
  }),
}));

vi.mock('../tools/builtins', () => ({
  setComputerUseBatchMode: vi.fn(),
  setSkipAutoScreenshot: vi.fn(),
}));

vi.mock('./computerUseStatus', () => ({
  setComputerUseActive: vi.fn(),
  incrementComputerUseStep: vi.fn(),
  setCurrentAction: vi.fn(),
  isSessionWindowHidden: () => false,
  setSessionWindowHidden: vi.fn(),
  pauseComputerUseStatus: vi.fn(),
}));

vi.mock('./permissionBridge', () => ({
  setLoopContext: (...args: unknown[]) => mocks.setLoopContext(...args),
  clearLoopContext: vi.fn(),
}));

vi.mock('./ports/conversationReader', () => ({
  getConversationReader: () => ({
    getConversation: () => ({ workspacePath: null }),
  }),
}));

vi.mock('../observability/langfuse', () => ({
  startToolSpan: () => ({ end: vi.fn() }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { executeToolBatch } from './toolExecutor';

function makeToolCall(name: string, input: Record<string, unknown> = {}): ToolCall {
  return {
    id: `tc-${name}`,
    name,
    input,
    isExecuting: true,
  };
}

function makeInvoker(
  executeAnyTool: ToolInvoker['executeAnyTool'],
): ToolInvoker {
  return {
    getAllTools: () => [],
    executeAnyTool,
    toolResultToString: (result) => String(result),
  };
}

function makeParams(
  toolCall: ToolCall,
  invoker: ToolInvoker,
  blockedTools?: string[],
  allowedTools?: string[],
) {
  return {
    collectedToolCalls: [toolCall],
    toolCallToStepId: new Map<string, string>(),
    conversationId: 'conv-1',
    assistantMsgId: 'msg-1',
    loopId: 'loop-1',
    abortController: new AbortController(),
    eventRouter: { route: mocks.route } as unknown as EventRouter,
    executionId: 'exec-1',
    inputValidators: new Map<string, (input: Record<string, unknown>) => boolean>(),
    blockedTools,
    allowedTools,
    confirmCb: async () => true,
    filePermCb: async () => true,
    toolContext: {} as ToolExecutionContext,
    toolInvoker: invoker,
    settingsReader: { getSnapshot: () => ({}) as never },
    continueLoop: true,
  };
}

describe('executeToolBatch · hard run restrictions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitHook.mockResolvedValue({ blocked: false });
  });

  it('fails closed before invoking a tool on the per-run denylist', async () => {
    const executeAnyTool = vi.fn();
    const toolCall = makeToolCall('run_command');

    const result = await executeToolBatch(
      makeParams(toolCall, makeInvoker(executeAnyTool), ['run_command']),
    );

    expect(executeAnyTool).not.toHaveBeenCalled();
    expect(mocks.updateToolCall).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      toolCall.id,
      'Error: tool "run_command" is blocked for this agent run',
      undefined,
      true,
      undefined,
      undefined,
    );
    expect(result).toEqual({
      mcpChanged: false,
      requiresUserRecovery: false,
      observations: [{
        name: 'run_command',
        input: {},
        result: 'Error: tool "run_command" is blocked for this agent run',
        error: true,
      }],
    });
  });

  it('installs the frozen parent settings reader for nested delegate tools', async () => {
    const executeAnyTool = vi.fn().mockResolvedValue('ok');
    const params = makeParams(makeToolCall('delegate_to_agent'), makeInvoker(executeAnyTool));

    await executeToolBatch(params);

    expect(mocks.setLoopContext).toHaveBeenCalledWith(
      'loop-1',
      expect.objectContaining({
        conversationId: 'conv-1',
        settingsReader: params.settingsReader,
      }),
    );
  });

  it('fails closed before invoking a tool outside the per-run whitelist', async () => {
    const executeAnyTool = vi.fn();
    const toolCall = makeToolCall('write_file');

    await executeToolBatch(
      makeParams(toolCall, makeInvoker(executeAnyTool), undefined, ['read_*']),
    );

    expect(executeAnyTool).not.toHaveBeenCalled();
    expect(mocks.updateToolCall).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      toolCall.id,
      'Error: tool "write_file" is not allowed for this agent run',
      undefined,
      true,
      undefined,
      undefined,
    );
  });

  it.each(['tool_search', 'use_skill', 'read_file', 'run_command'])(
    'recovery allowlist blocks a guessed %s call before registry execution',
    async (toolName) => {
      const executeAnyTool = vi.fn();

      const result = await executeToolBatch(
        makeParams(
          makeToolCall(toolName),
          makeInvoker(executeAnyTool),
          undefined,
          ['computer', 'ask_user_question'],
        ),
      );

      expect(executeAnyTool).not.toHaveBeenCalled();
      expect(result.observations[0]).toMatchObject({
        name: toolName,
        error: true,
      });
    },
  );

  it('allows a tool matching a wildcard whitelist pattern', async () => {
    const executeAnyTool = vi.fn().mockResolvedValue('ok');
    const toolCall = makeToolCall('read_file');

    await executeToolBatch(
      makeParams(toolCall, makeInvoker(executeAnyTool), undefined, ['read_*']),
    );

    expect(executeAnyTool).toHaveBeenCalledTimes(1);
  });

  it('enforces an allowed-tool input constraint, not just the tool name', async () => {
    const executeAnyTool = vi.fn();
    const toolCall = makeToolCall('run_command', { command: 'rm -rf build' });

    await executeToolBatch(
      makeParams(toolCall, makeInvoker(executeAnyTool), undefined, ['run_command(npm run *)']),
    );

    expect(executeAnyTool).not.toHaveBeenCalled();
  });

  it('marks trusted recovery metadata as an error and stops the parent loop', async () => {
    const executeAnyTool = vi.fn(
      async (
        _name: string,
        _input: Record<string, unknown>,
        _confirm: unknown,
        _filePermission: unknown,
        context?: ToolExecutionContext,
      ) => {
        context?.reportMetadata?.({
          sandboxRecovery: {
            kind: 'app-automation',
            targetApp: 'Notes',
          },
        });
        return 'blocked';
      },
    );
    const toolCall = makeToolCall('run_command');

    const result = await executeToolBatch(
      makeParams(toolCall, makeInvoker(executeAnyTool)),
    );

    expect(mocks.updateToolCall).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      toolCall.id,
      'blocked',
      undefined,
      true,
      undefined,
      {
        sandboxRecovery: {
          kind: 'app-automation',
          targetApp: 'Notes',
        },
      },
    );
    expect(result).toEqual({
      mcpChanged: false,
      requiresUserRecovery: true,
      observations: [{
        name: 'run_command',
        input: {},
        result: 'blocked',
        error: true,
      }],
    });
  });
});

describe('executeToolBatch · run_command batch scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitHook.mockResolvedValue({ blocked: false });
  });

  function makeBatchParams(toolCalls: ToolCall[], invoker: ToolInvoker) {
    return {
      ...makeParams(toolCalls[0], invoker),
      collectedToolCalls: toolCalls,
    };
  }

  /**
   * Tracks whether the calls' executions overlapped. The await yields one
   * microtask (no timers — TESTING.md determinism rules): under parallel
   * scheduling the second call starts while the first is parked on the
   * microtask (maxInFlight 2); under sequential scheduling the second call
   * only starts after the first fully resolves (maxInFlight 1).
   */
  function makeOverlapProbe() {
    let inFlight = 0;
    let maxInFlight = 0;
    const executeAnyTool = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return 'ok';
    });
    return { executeAnyTool, maxInFlight: () => maxInFlight };
  }

  // The scheduler classifies commands with the pure isReadOnlyCommand
  // classifier directly (NOT via toolInvoker.getAllTools()): the registry's
  // isConcurrencySafe predicate is a function and does not survive the
  // sidecar RPC boundary. These tests use real command strings so they pin
  // the actual classifier behavior on both planes.
  it('runs an all-read-only run_command batch in parallel', async () => {
    const probe = makeOverlapProbe();
    const calls = [
      { ...makeToolCall('run_command', { command: 'ls -la' }), id: 'tc-1' },
      { ...makeToolCall('run_command', { command: 'grep foo bar.txt' }), id: 'tc-2' },
    ];

    await executeToolBatch(makeBatchParams(calls, makeInvoker(probe.executeAnyTool)));

    expect(probe.executeAnyTool).toHaveBeenCalledTimes(2);
    expect(probe.maxInFlight()).toBe(2);
  });

  it('keeps the batch sequential when any command is not read-only', async () => {
    const probe = makeOverlapProbe();
    const calls = [
      { ...makeToolCall('run_command', { command: 'ls -la' }), id: 'tc-1' },
      { ...makeToolCall('run_command', { command: 'npm install' }), id: 'tc-2' },
    ];

    await executeToolBatch(makeBatchParams(calls, makeInvoker(probe.executeAnyTool)));

    expect(probe.executeAnyTool).toHaveBeenCalledTimes(2);
    expect(probe.maxInFlight()).toBe(1);
  });

  it('keeps the batch sequential when a command is missing from the input', async () => {
    const probe = makeOverlapProbe();
    const calls = [
      { ...makeToolCall('run_command', { command: 'ls' }), id: 'tc-1' },
      { ...makeToolCall('run_command', {}), id: 'tc-2' },
    ];

    await executeToolBatch(makeBatchParams(calls, makeInvoker(probe.executeAnyTool)));

    expect(probe.executeAnyTool).toHaveBeenCalledTimes(2);
    expect(probe.maxInFlight()).toBe(1);
  });
});
