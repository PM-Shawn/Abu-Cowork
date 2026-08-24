import { beforeEach, describe, expect, it, vi } from 'vitest';

const runSubagentLoopMock = vi.hoisted(() => vi.fn());
vi.mock('@/core/agent/subagentLoop', () => ({
  runSubagentLoop: (...args: unknown[]) => runSubagentLoopMock(...args),
}));

const parentPorts = vi.hoisted(() => ({
  toolInvoker: { getAllTools: vi.fn(), executeAnyTool: vi.fn(), toolResultToString: vi.fn() },
  capsPort: { get: vi.fn() },
  workspaceReader: { getCurrentPath: vi.fn(() => '/workspace') },
}));
vi.mock('../agentRunContext', () => ({
  getCurrentAgentRunContext: () => parentPorts,
}));

const settingsReader = vi.hoisted(() => ({ getSnapshot: vi.fn(() => ({})) }));
vi.mock('../settingsMirror', () => ({
  getSettingsMirrorReader: () => settingsReader,
}));

import { runSubagent } from './subagentRunnerRun';

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      name: 'nested-agent',
      description: 'test',
      systemPrompt: 'test',
      filePath: '/tmp/agent.md',
    },
    task: 'do work',
    ...overrides,
  } as never;
}

describe('sidecar nested subagent scoped signal parity', () => {
  beforeEach(() => {
    runSubagentLoopMock.mockReset();
    runSubagentLoopMock.mockResolvedValue({ text: 'done' });
  });

  it('aborts a scoped run-owned signal after the nested subagent settles', async () => {
    const parentController = new AbortController();
    let observedSignal: AbortSignal | undefined;
    runSubagentLoopMock.mockImplementationOnce(async (options: { signal?: AbortSignal }) => {
      observedSignal = options.signal;
      expect(observedSignal).not.toBe(parentController.signal);
      expect(observedSignal?.aborted).toBe(false);
      return { text: 'done' };
    });

    await runSubagent(makeOptions({
      authorizationScopeId: 'scope-parent',
      signal: parentController.signal,
    }));

    expect(observedSignal?.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(false);
  });
});
