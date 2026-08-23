import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../types';

const runSubagentMock = vi.fn().mockResolvedValue({
  text: 'done',
  toolCallCount: 0,
  turnCount: 1,
  tokenUsage: { input: 0, output: 0 },
  duration: 1,
});

vi.mock('../../agent/subagentRunner', () => ({
  getSubagentRunInheritance: (
    loopCtx: { conversationId?: string; settingsReader?: unknown; authorizationScopeId?: string } | null | undefined,
    authorizationScopeId?: string,
    workspacePath?: string | null,
  ) => ({
    parentConversationId: loopCtx?.conversationId,
    settingsReader: loopCtx?.settingsReader,
    authorizationScopeId: authorizationScopeId ?? loopCtx?.authorizationScopeId,
    workspaceReader: { getCurrentPath: () => workspacePath ?? null },
  }),
  runSubagent: (...args: unknown[]) => runSubagentMock(...args),
}));

vi.mock('../../agent/permissionBridge', () => ({
  getCurrentLoopContext: vi.fn(() => ({
    authorizationScopeId: undefined,
    allowedTools: ['read_file'],
    blockedTools: [],
    signal: undefined,
    conversationId: 'conv-1',
  })),
  getLoopContext: vi.fn(),
}));

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: vi.fn(() => ({
      activeConversationId: 'conv-1',
      conversations: { 'conv-1': { messages: [] } },
    })),
  },
}));

vi.mock('../../../stores/batchProgressStore', () => ({
  useBatchProgressStore: {
    getState: vi.fn(() => ({
      initBatch: vi.fn(),
      batches: {},
      setTaskRunning: vi.fn(),
      setTaskActivity: vi.fn(),
    })),
  },
}));

let runAgentBatchTool: ToolDefinition;

beforeAll(async () => {
  ({ runAgentBatchTool } = await import('./orchestrationTools'));
});

describe('runAgentBatchTool scope inheritance', () => {
  it('prefers the shell-owned tool execution authorization scope for nested batch subagents', async () => {
    await runAgentBatchTool.execute(
      { tasks: [{ type: 'research', task: 'look something up' }], concurrency: 1 },
      { authorizationScopeId: 'scope-from-tool-context', workspacePath: null, toolCallId: 'tool-1' } as never,
    );

    expect(runSubagentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationScopeId: 'scope-from-tool-context',
        workspaceReader: expect.any(Object),
      }),
    );
    const call = runSubagentMock.mock.calls.at(-1)?.[0] as { workspaceReader?: { getCurrentPath: () => string | null } };
    expect(call.workspaceReader?.getCurrentPath()).toBeNull();
  });
});
