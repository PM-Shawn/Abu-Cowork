import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolDefinition, ToolExecutionContext } from '@/types';
import type { EventRouter } from './eventRouter';
import type { ToolInvoker } from './ports/toolInvoker';

const mocks = vi.hoisted(() => ({
  updateToolCall: vi.fn(),
  checkpointToolCallMetadata: vi.fn(),
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
    checkpointToolCallMetadata: mocks.checkpointToolCallMetadata,
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
import { READ_ONLY_TOOL_ALLOWLIST } from '../permissions/readOnlyToolPolicy';

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

  // The fail-closed check has to be authoritative for exactly what
  // resolveTools (agentLoop.ts) hid from the model — including a whole
  // namespace blocked via a `server__*` pattern (e.g. read_tools triggers
  // blocking every browser-automation tool), not just an exact tool name.
  it('fails closed on a tool matched only by a wildcard pattern on the per-run denylist', async () => {
    const executeAnyTool = vi.fn();
    const toolCall = makeToolCall('abu-browser__click');

    const result = await executeToolBatch(
      makeParams(toolCall, makeInvoker(executeAnyTool), ['abu-browser__*']),
    );

    expect(executeAnyTool).not.toHaveBeenCalled();
    expect(result).toEqual({
      mcpChanged: false,
      requiresUserRecovery: false,
      observations: [{
        name: 'abu-browser__click',
        input: {},
        result: 'Error: tool "abu-browser__click" is blocked for this agent run',
        error: true,
      }],
    });
  });

  // RB-02: the read-only tier's ceiling has to hold at the execution
  // boundary, not just in the tool list the model was shown. This is the
  // audit's exact repro input — `touch marker`, which `commandSafety`
  // classifies `safe` and the standard strategy therefore resolves to
  // 'allow' outright, skipping the tier's deny callback entirely.
  it('fails closed on run_command under the unattended read-only roster', async () => {
    const executeAnyTool = vi.fn();
    const toolCall = makeToolCall('run_command', { command: 'touch marker', cwd: '/tmp/ws' });

    const result = await executeToolBatch(
      makeParams(toolCall, makeInvoker(executeAnyTool), undefined, [...READ_ONLY_TOOL_ALLOWLIST]),
    );

    expect(executeAnyTool).not.toHaveBeenCalled();
    expect(result.observations).toEqual([{
      name: 'run_command',
      input: { command: 'touch marker', cwd: '/tmp/ws' },
      result: 'Error: tool "run_command" is not allowed for this agent run',
      error: true,
    }]);
  });

  it.each([
    ['write_file', { path: '/tmp/ws/a.txt', content: 'x' }],
    ['edit_file', { path: '/tmp/ws/a.txt' }],
    ['delete_file', { path: '/tmp/ws/a.txt' }],
    ['http_fetch', { url: 'https://example.com', method: 'POST' }],
    ['update_memory', { content: 'x' }],
    ['manage_mcp_server', { action: 'add' }],
  ])('fails closed on %s under the unattended read-only roster', async (name, input) => {
    const executeAnyTool = vi.fn();

    const result = await executeToolBatch(
      makeParams(makeToolCall(name, input), makeInvoker(executeAnyTool), undefined, [...READ_ONLY_TOOL_ALLOWLIST]),
    );

    expect(executeAnyTool).not.toHaveBeenCalled();
    expect(result.observations[0]?.error).toBe(true);
  });

  // The ceiling must not be so tight that the tier stops being useful — the
  // reads it advertises still have to run.
  it('still executes a read tool under the unattended read-only roster', async () => {
    const executeAnyTool = vi.fn().mockResolvedValue('file contents');

    await executeToolBatch(
      makeParams(
        makeToolCall('read_file', { path: '/tmp/ws/a.txt' }),
        makeInvoker(executeAnyTool),
        undefined,
        [...READ_ONLY_TOOL_ALLOWLIST],
      ),
    );

    expect(executeAnyTool).toHaveBeenCalled();
  });

  it('installs the frozen parent settings reader for nested delegate tools', async () => {
    const executeAnyTool = vi.fn().mockResolvedValue('ok');
    const imContext = { platform: 'dchat' as const, workspacePath: '/im/workspace' };
    const params = {
      ...makeParams(makeToolCall('delegate_to_agent'), makeInvoker(executeAnyTool)),
      imContext,
    };

    await executeToolBatch(params);

    expect(mocks.setLoopContext).toHaveBeenCalledWith(
      'loop-1',
      expect.objectContaining({
        conversationId: 'conv-1',
        settingsReader: params.settingsReader,
        imContext,
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

  it('persists structured subagent failure metadata and routes the delegate step as an error', async () => {
    const executeAnyTool = vi.fn(async (
      _name: string,
      _input: Record<string, unknown>,
      _confirm: unknown,
      _filePermission: unknown,
      context?: ToolExecutionContext,
    ) => {
      context?.reportMetadata?.({ subagentStopReason: 'max_turns' });
      return 'partial report without an Error prefix';
    });
    const toolCall = makeToolCall('delegate_to_agent');
    const params = makeParams(toolCall, makeInvoker(executeAnyTool));
    params.toolCallToStepId.set(toolCall.id, 'step-1');

    const result = await executeToolBatch(params);

    expect(mocks.updateToolCall).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      toolCall.id,
      'partial report without an Error prefix',
      undefined,
      true,
      undefined,
      { subagentStopReason: 'max_turns' },
    );
    expect(mocks.route).toHaveBeenCalledWith({
      type: 'step-error',
      loopId: 'loop-1',
      stepId: 'step-1',
      error: 'partial report without an Error prefix',
    });
    expect(result.observations[0]).toEqual(expect.objectContaining({ error: true }));
  });

  it('treats a non-success batch terminal summary as a tool execution error even without a coarse failure reason', async () => {
    const toolCall = makeToolCall('run_agent_batch');
    const summary = {
      version: 1 as const,
      batch: { conversationId: 'conv-1', batchToolCallId: toolCall.id },
      taskCount: 1,
      counts: { succeeded: 0, failed: 1, stopped: 0, incomplete: 0 },
      tasks: [{ taskIndex: 0, status: 'failed' as const, terminalReason: 'invalid_structured' as const }],
    };
    const executeAnyTool = vi.fn(async (
      _name: string,
      _input: Record<string, unknown>,
      _confirm: unknown,
      _filePermission: unknown,
      context?: ToolExecutionContext,
    ) => {
      context?.reportMetadata?.({ batchTerminalSummary: summary });
      context?.reportMetadata?.({ subagentStopReason: 'completed' });
      return 'schema-invalid aggregate';
    });
    const params = makeParams(toolCall, makeInvoker(executeAnyTool));
    params.toolCallToStepId.set(toolCall.id, 'step-1');

    const result = await executeToolBatch(params);

    expect(mocks.updateToolCall).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      toolCall.id,
      'schema-invalid aggregate',
      undefined,
      true,
      undefined,
      { batchTerminalSummary: summary, subagentStopReason: 'completed' },
    );
    expect(mocks.route).toHaveBeenCalledWith({
      type: 'step-error',
      loopId: 'loop-1',
      stepId: 'step-1',
      error: 'schema-invalid aggregate',
    });
    expect(result.observations[0]).toEqual(expect.objectContaining({ error: true }));
  });

  it('routes a completed delegate through step-end even when its report starts with Error:', async () => {
    const executeAnyTool = vi.fn(async (
      _name: string,
      _input: Record<string, unknown>,
      _confirm: unknown,
      _filePermission: unknown,
      context?: ToolExecutionContext,
    ) => {
      context?.reportMetadata?.({ subagentStopReason: 'completed' });
      return 'Error: quoted heading from the completed report';
    });
    const toolCall = makeToolCall('delegate_to_agent');
    const params = makeParams(toolCall, makeInvoker(executeAnyTool));
    params.toolCallToStepId.set(toolCall.id, 'step-1');

    const result = await executeToolBatch(params);

    expect(mocks.updateToolCall).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      toolCall.id,
      'Error: quoted heading from the completed report',
      undefined,
      false,
      undefined,
      { subagentStopReason: 'completed' },
    );
    expect(mocks.route).toHaveBeenCalledWith({
      type: 'step-end',
      loopId: 'loop-1',
      stepId: 'step-1',
      result: 'Error: quoted heading from the completed report',
      resultContent: undefined,
    });
    expect(result.observations[0]).toEqual(expect.objectContaining({ error: false }));
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

// This second describe block covers the OTHER scheduling layer — the
// generic (non-run_command-only) batch fallback in toolExecutor.ts's `else`
// branch, which groups by each call's registry-declared `isConcurrencySafe`
// (see toolConcurrency.ts). The run_command-only fast path above bypasses
// this entirely by calling isReadOnlyCommand directly (registry functions
// don't survive the sidecar RPC boundary — see that describe block's
// comment), so these two layers are independently tested, not duplicates.
describe('executeToolBatch · concurrency-aware scheduling (isConcurrencySafe)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitHook.mockResolvedValue({ blocked: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs consecutive concurrency-safe calls in parallel while isolating an unsafe call as a serial boundary', async () => {
    vi.useFakeTimers();

    const readTool: ToolDefinition = {
      name: 'read_file',
      description: 'reads a file',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '',
      isConcurrencySafe: true,
    };
    const writeTool: ToolDefinition = {
      name: 'write_file',
      description: 'writes a file',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '',
      isConcurrencySafe: false,
    };

    const order: string[] = [];
    const executeAnyTool = vi.fn(async (_name: string, input: Record<string, unknown>) => {
      const id = String(input.id);
      order.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${id}`);
      return 'ok';
    });

    const invoker: ToolInvoker = {
      getAllTools: () => [readTool, writeTool],
      executeAnyTool,
      toolResultToString: (result) => String(result),
    };

    const read1: ToolCall = { id: 'read1', name: 'read_file', input: { id: 'read1' } };
    const write1: ToolCall = { id: 'write1', name: 'write_file', input: { id: 'write1' } };
    const read2: ToolCall = { id: 'read2', name: 'read_file', input: { id: 'read2' } };
    const read3: ToolCall = { id: 'read3', name: 'read_file', input: { id: 'read3' } };

    const params = makeParams(read1, invoker);
    params.collectedToolCalls = [read1, write1, read2, read3];

    const runPromise = executeToolBatch(params);
    await vi.advanceTimersByTimeAsync(10); // read1 (isolated safe batch) resolves
    await vi.advanceTimersByTimeAsync(10); // write1 (serial boundary) resolves
    await vi.advanceTimersByTimeAsync(10); // read2 + read3 resolve together
    await runPromise;

    expect(order).toEqual([
      'start:read1', 'end:read1',
      'start:write1', 'end:write1',
      'start:read2', 'start:read3', 'end:read2', 'end:read3',
    ]);

    // Result matching still lines up by original call order/id despite regrouping.
    expect(mocks.updateToolCall).toHaveBeenCalledTimes(4);
    const calledIds = mocks.updateToolCall.mock.calls.map((call) => call[2]);
    expect(calledIds).toEqual(['read1', 'write1', 'read2', 'read3']);
  });

  it('treats a tool with no definition (unresolvable isConcurrencySafe) as unsafe and runs it serially', async () => {
    const knownSafe: ToolDefinition = {
      name: 'read_file',
      description: 'reads a file',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '',
      isConcurrencySafe: true,
    };
    const executeAnyTool = vi.fn().mockResolvedValue('ok');
    const invoker: ToolInvoker = {
      // 'mystery_tool' is intentionally absent from getAllTools()
      getAllTools: () => [knownSafe],
      executeAnyTool,
      toolResultToString: (result) => String(result),
    };

    const read1: ToolCall = { id: 'read1', name: 'read_file', input: {} };
    const mystery: ToolCall = { id: 'mystery1', name: 'mystery_tool', input: {} };

    const params = makeParams(read1, invoker);
    params.collectedToolCalls = [read1, mystery];

    const result = await executeToolBatch(params);

    expect(executeAnyTool).toHaveBeenCalledTimes(2);
    expect(result.observations.map((o) => o.name)).toEqual(['read_file', 'mystery_tool']);
  });

  it('checkpoints trusted metadata even when it arrives after parent abort wins the race', async () => {
    vi.useFakeTimers();
    const toolCall = makeToolCall('run_agent_batch');
    const params = makeParams(
      toolCall,
      makeInvoker(async (_name, _input, _confirm, _filePerm, context) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        context?.reportMetadata?.({
          batchTerminalSummary: {
            version: 1,
            batch: { conversationId: 'conv-1', batchToolCallId: toolCall.id },
            taskCount: 1,
            counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
            tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
          },
        });
        return 'late response';
      }),
    );

    const run = executeToolBatch(params);
    await Promise.resolve();
    params.abortController.abort();
    await run;
    await vi.advanceTimersByTimeAsync(10);

    expect(mocks.checkpointToolCallMetadata).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
      toolCall.id,
      {
        batchTerminalSummary: {
          version: 1,
          batch: { conversationId: 'conv-1', batchToolCallId: toolCall.id },
          taskCount: 1,
          counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
          tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
        },
      },
    );
  });
});
