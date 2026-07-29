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
  setLoopContext: vi.fn(),
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

function makeToolCall(name: string): ToolCall {
  return {
    id: `tc-${name}`,
    name,
    input: {},
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
    confirmCb: async () => true,
    filePermCb: async () => true,
    toolContext: {} as ToolExecutionContext,
    toolInvoker: invoker,
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
    });
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
    });
  });
});
