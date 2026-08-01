/**
 * Tests for `defaultWorkspaceRun.ts` (P1-3d A-write) — the sidecar-local
 * `bindWorkspaceFromWrite` shim, resolved from a throwing stub (P1-3d-4)
 * into a real fire-and-forget NOTIFICATION forward now that `write_file`
 * runs locally (`localTools/index.ts`). Same mocking pattern as
 * `lifecycleHooksRun.test.ts` — mock `../rpcClient` and drive the real
 * `agentRunContext` AsyncLocalStorage scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import * as rpcClient from '../rpcClient';
import { bindWorkspaceFromWrite } from './defaultWorkspaceRun';

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
    resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false },
    locale: 'en-US',
    pushFrame: () => {},
    ...overrides,
  };
}

describe('defaultWorkspaceRun shim', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards as a NOTIFICATION (fire-and-forget, no response awaited) with the ambient runId', async () => {
    const notifySpy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
    const requestSpy = vi.spyOn(rpcClient, 'sendRequest');
    await agentRunContext.run(makeCtx({ runId: 'run-1' }), () =>
      bindWorkspaceFromWrite('conv-1', '/Users/x/Abu/report/out.html'),
    );
    expect(notifySpy).toHaveBeenCalledWith('workspace.bindFromWrite', {
      runId: 'run-1',
      conversationId: 'conv-1',
      path: '/Users/x/Abu/report/out.html',
    });
    // Never sendRequest — this must stay fire-and-forget, matching the real
    // call site's `void bindWorkspaceFromWrite(...)` (never awaited).
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('forwards conversationId: undefined unchanged (writeFileTool may call this with no conversation context)', async () => {
    const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
    await agentRunContext.run(makeCtx({ runId: 'run-1' }), () =>
      bindWorkspaceFromWrite(undefined, '/tmp/out.txt'),
    );
    expect(spy).toHaveBeenCalledWith('workspace.bindFromWrite', {
      runId: 'run-1',
      conversationId: undefined,
      path: '/tmp/out.txt',
    });
  });

  it('throws a clear wiring-bug error when called outside an active agentRunContext scope', async () => {
    await expect(bindWorkspaceFromWrite('conv-1', '/tmp/x')).rejects.toThrow(/agent run context accessed outside/);
  });
});
