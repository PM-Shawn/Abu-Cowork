/**
 * Tests for `authorizedPathsReaderRun.ts` (P1-3d-5 slice 2a) — the sidecar
 * reverse-RPC reader behind `run_command`'s sandbox authorized-paths query.
 * Same mocking pattern as `aiEditSnapshotsRun.test.ts` (mock `../rpcClient`).
 *
 * SAFETY-RELEVANT contract under test (2026-07-26 review remediation): the
 * reader must fail CLOSED on a malformed (resolved but non-array) RPC result
 * — coercing to [] would silently under-authorize the OS sandbox, the exact
 * outcome `localTools/index.ts`'s fail-closed doc block rules out. A rejected
 * RPC already fails closed by propagating the rejection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as rpcClient from '../rpcClient';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import { getAuthorizedPathsReader, setAuthorizedPathsReader } from './authorizedPathsReaderRun';

vi.mock('../rpcClient', () => ({
  sendRequest: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(rpcClient.sendRequest).mockReset();
});

function makeCtx(overrides?: Partial<AgentRunContext>): AgentRunContext {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    chatDelta: {} as AgentRunContext['chatDelta'],
    conversationReader: {} as AgentRunContext['conversationReader'],
    executionPort: {} as AgentRunContext['executionPort'],
    abortRegistry: {} as AgentRunContext['abortRegistry'],
    scratchpadPort: {} as AgentRunContext['scratchpadPort'],
    capsPort: {} as AgentRunContext['capsPort'],
    workspaceReader: {} as AgentRunContext['workspaceReader'],
    toolInvoker: {} as AgentRunContext['toolInvoker'],
    pushFrame: vi.fn(),
    resolvedCreds: { apiKey: 'sk', baseUrl: undefined, forceOpenAiCompatible: false },
    locale: 'zh-CN',
    ...overrides,
  };
}

describe('authorizedPathsReaderRun shim', () => {
  it('returns the array result from workspace.authorizedWritablePaths', async () => {
    vi.mocked(rpcClient.sendRequest).mockResolvedValue(['/a', '/b']);
    const result = await agentRunContext.run(makeCtx({ runId: 'run-scoped' }), () =>
      getAuthorizedPathsReader().getAuthorizedWritablePaths(),
    );
    expect(result).toEqual(['/a', '/b']);
    expect(rpcClient.sendRequest).toHaveBeenCalledWith('workspace.authorizedWritablePaths', {
      runId: 'run-scoped',
    });
  });

  it('fails closed (throws) on a malformed non-array result instead of coercing to []', async () => {
    vi.mocked(rpcClient.sendRequest).mockResolvedValue(undefined);
    await expect(
      agentRunContext.run(makeCtx(), () => getAuthorizedPathsReader().getAuthorizedWritablePaths()),
    ).rejects.toThrow(/non-array/);
  });

  it('fails closed when called outside an agent run context', async () => {
    await expect(getAuthorizedPathsReader().getAuthorizedWritablePaths()).rejects.toThrow(
      /outside agentLoopHost/,
    );
  });

  it('propagates a rejected RPC (fail closed, no swallow)', async () => {
    vi.mocked(rpcClient.sendRequest).mockRejectedValue(new Error('transport down'));
    await expect(
      agentRunContext.run(makeCtx(), () => getAuthorizedPathsReader().getAuthorizedWritablePaths()),
    ).rejects.toThrow('transport down');
  });

  it('setAuthorizedPathsReader throws (wiring-bug guard, mirrors workspaceReaderRun)', () => {
    expect(() =>
      setAuthorizedPathsReader({ getAuthorizedWritablePaths: async () => [] }),
    ).toThrow(/wiring bug/);
  });
});
