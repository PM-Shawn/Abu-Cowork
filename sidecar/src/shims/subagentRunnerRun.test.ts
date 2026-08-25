import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentLoopOptions } from '@/core/agent/subagentLoop';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';

const { runSubagentLoopMock } = vi.hoisted(() => ({
  runSubagentLoopMock: vi.fn(),
}));

vi.mock('@/core/agent/subagentLoop', () => ({
  runSubagentLoop: (...args: Parameters<typeof import('@/core/agent/subagentLoop').runSubagentLoop>) => runSubagentLoopMock(...args),
}));

import { runSubagent } from './subagentRunnerRun';

const agent = {
  name: 'nested-test',
  description: 'nested test agent',
  systemPrompt: 'test',
  filePath: '__preset__',
};

function makeContext(): AgentRunContext {
  return {
    runId: 'parent-run',
    conversationId: 'conversation-1',
    chatDelta: {} as AgentRunContext['chatDelta'],
    conversationReader: {} as AgentRunContext['conversationReader'],
    executionPort: {} as AgentRunContext['executionPort'],
    abortRegistry: {} as AgentRunContext['abortRegistry'],
    scratchpadPort: {} as AgentRunContext['scratchpadPort'],
    capsPort: {} as AgentRunContext['capsPort'],
    workspaceReader: {} as AgentRunContext['workspaceReader'],
    toolInvoker: {} as AgentRunContext['toolInvoker'],
    resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false },
    locale: 'en-US',
    pushFrame: () => {},
  };
}

describe('subagentRunnerRun shim', () => {
  beforeEach(() => {
    runSubagentLoopMock.mockReset();
    runSubagentLoopMock.mockImplementation(async (options: SubagentLoopOptions) => {
      options.onProgress?.({
        type: 'tool-start',
        id: 'call_1',
        toolName: 'read_file',
        toolInput: {},
      });
      return {
        text: 'done',
        toolCallCount: 1,
        turnCount: 1,
        tokenUsage: { input: 0, output: 0 },
        duration: 1,
        stopReason: 'completed',
      };
    });
  });

  it('gives two nested runs independent parent-visible ids for the same raw call_1', async () => {
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const settingsReader = { getSnapshot: () => ({}) } as SubagentLoopOptions['settingsReader'];

    await agentRunContext.run(makeContext(), async () => {
      await Promise.all([
        runSubagent({ agent, task: 'first', settingsReader, onProgress: firstProgress }),
        runSubagent({ agent, task: 'second', settingsReader, onProgress: secondProgress }),
      ]);
    });

    const firstId = firstProgress.mock.calls[0][0].id as string;
    const secondId = secondProgress.mock.calls[0][0].id as string;
    expect(firstId).toMatch(/^subagent-v1:sar-.*:call_1$/);
    expect(secondId).toMatch(/^subagent-v1:sar-.*:call_1$/);
    expect(firstId).not.toBe(secondId);
  });

  it('aborts the run-owned signal after a scoped run succeeds', async () => {
    const parentController = new AbortController();
    let loopSignal: AbortSignal | undefined;
    runSubagentLoopMock.mockImplementationOnce(async (options: SubagentLoopOptions) => {
      loopSignal = options.signal;
      return {
        text: 'done',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 0, output: 0 },
        duration: 1,
        stopReason: 'completed',
      };
    });

    await agentRunContext.run(makeContext(), () => runSubagent({
      agent,
      task: 'scoped success',
      signal: parentController.signal,
      authorizationScopeId: 'scope-success',
    }));

    expect(loopSignal).toBeDefined();
    expect(loopSignal).not.toBe(parentController.signal);
    expect(loopSignal?.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(false);
  });

  it('aborts the run-owned signal after a scoped run throws', async () => {
    const parentController = new AbortController();
    let loopSignal: AbortSignal | undefined;
    runSubagentLoopMock.mockImplementationOnce(async (options: SubagentLoopOptions) => {
      loopSignal = options.signal;
      throw new Error('loop failed');
    });

    await expect(agentRunContext.run(makeContext(), () => runSubagent({
      agent,
      task: 'scoped failure',
      signal: parentController.signal,
      authorizationScopeId: 'scope-error',
    }))).rejects.toThrow('loop failed');

    expect(loopSignal).toBeDefined();
    expect(loopSignal).not.toBe(parentController.signal);
    expect(loopSignal?.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(false);
  });

  it('cascades parent abort into the scoped run-owned signal', async () => {
    const parentController = new AbortController();
    const parentReason = new Error('parent stopped');
    let loopSignal: AbortSignal | undefined;
    runSubagentLoopMock.mockImplementationOnce((options: SubagentLoopOptions) => {
      loopSignal = options.signal;
      return new Promise((resolve) => {
        options.signal?.addEventListener('abort', () => resolve({
          text: 'cancelled',
          toolCallCount: 0,
          turnCount: 1,
          tokenUsage: { input: 0, output: 0 },
          duration: 1,
          stopReason: 'aborted',
        }), { once: true });
      });
    });

    await agentRunContext.run(makeContext(), async () => {
      const pending = runSubagent({
        agent,
        task: 'cascade abort',
        signal: parentController.signal,
        authorizationScopeId: 'scope-abort',
      });
      expect(loopSignal?.aborted).toBe(false);

      parentController.abort(parentReason);
      await pending;
    });

    expect(loopSignal?.aborted).toBe(true);
    expect(loopSignal?.reason).toBe(parentReason);
  });

  it('forwards the original signal without terminating it when no scope exists', async () => {
    const parentController = new AbortController();
    let loopSignal: AbortSignal | undefined;
    runSubagentLoopMock.mockImplementationOnce(async (options: SubagentLoopOptions) => {
      loopSignal = options.signal;
      return {
        text: 'done',
        toolCallCount: 0,
        turnCount: 1,
        tokenUsage: { input: 0, output: 0 },
        duration: 1,
        stopReason: 'completed',
      };
    });

    await agentRunContext.run(makeContext(), () => runSubagent({
      agent,
      task: 'unscoped success',
      signal: parentController.signal,
    }));

    expect(loopSignal).toBe(parentController.signal);
    expect(loopSignal?.aborted).toBe(false);
  });
});
