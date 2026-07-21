/**
 * Tests for `aiEditSnapshotsRun.ts` (P1-3d A-write) — the sidecar-local
 * `snapshotBeforeAiEdit` shim, resolved from a throwing stub (P1-3d-4) into
 * a real AWAITED REQUEST forward now that `write_file`/`edit_file` run
 * locally (`localTools/index.ts`). Same mocking pattern as
 * `lifecycleHooksRun.test.ts` — mock `../rpcClient` and drive the real
 * `agentRunContext` AsyncLocalStorage scope.
 *
 * SAFETY-RELEVANT contract under test: the real `snapshotBeforeAiEdit`
 * (`src/utils/aiEditSnapshots.ts`) NEVER throws (fail-open — a snapshot
 * failure must never block the write/edit itself). This shim must preserve
 * that exact contract at the RPC boundary — a transport failure degrades to
 * "no snapshot this turn", never a rejection the caller (write_file/
 * edit_file's `await snapshotBeforeAiEdit(...)`) would see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import * as rpcClient from '../rpcClient';
import { snapshotBeforeAiEdit } from './aiEditSnapshotsRun';

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

describe('aiEditSnapshotsRun shim', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('forwards as an AWAITED REQUEST with the ambient runId, path, and opts', async () => {
    const spy = vi.spyOn(rpcClient, 'sendRequest').mockResolvedValue(null);
    await agentRunContext.run(makeCtx({ runId: 'run-1' }), () =>
      snapshotBeforeAiEdit('/tmp/x.txt', { loopId: 'loop-1', conversationId: 'conv-1', knownContent: 'hello' }),
    );
    expect(spy).toHaveBeenCalledWith('snapshot.beforeAiEdit', {
      runId: 'run-1',
      path: '/tmp/x.txt',
      opts: { loopId: 'loop-1', conversationId: 'conv-1', knownContent: 'hello' },
    });
  });

  it('awaits the request before resolving — the caller (write_file/edit_file) can rely on the round trip having settled', async () => {
    let resolveRequest: (() => void) | undefined;
    const pending = new Promise<null>((resolve) => {
      resolveRequest = () => resolve(null);
    });
    vi.spyOn(rpcClient, 'sendRequest').mockReturnValue(pending as Promise<unknown>);

    let settled = false;
    const call = agentRunContext.run(makeCtx({ runId: 'run-1' }), () =>
      snapshotBeforeAiEdit('/tmp/x.txt', {}).then(() => {
        settled = true;
      }),
    );

    // Not settled yet — the request hasn't resolved.
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveRequest?.();
    await call;
    expect(settled).toBe(true);
  });

  it('FAIL-OPEN: a rejected request is swallowed, never re-thrown — matches the real function\'s never-throws contract', async () => {
    vi.spyOn(rpcClient, 'sendRequest').mockRejectedValue(new Error('shell disconnected'));
    await expect(
      agentRunContext.run(makeCtx({ runId: 'run-1' }), () => snapshotBeforeAiEdit('/tmp/x.txt', {})),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('snapshot.beforeAiEdit request failed'),
      '/tmp/x.txt',
      expect.any(Error),
    );
  });

  it('throws a clear wiring-bug error when called outside an active agentRunContext scope', async () => {
    await expect(snapshotBeforeAiEdit('/tmp/x.txt', {})).rejects.toThrow(/agent run context accessed outside/);
  });
});
