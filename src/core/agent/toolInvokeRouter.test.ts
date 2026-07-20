/**
 * toolInvokeRouter.ts — the unified `tool.invoke` registration point shared
 * by subagentRunner.ts and agentLoopRunner.ts (P1-3B-3B). Verifies the
 * single-handler-per-method routing itself in isolation, independent of
 * either caller's own registry shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const onSidecarRequest = vi.fn();
class MockSidecarRequestError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
vi.mock('../sidecar/sidecarManager', () => ({
  onSidecarRequest: (...a: unknown[]) => onSidecarRequest(...a),
  SidecarRequestError: MockSidecarRequestError,
}));

async function importFresh() {
  vi.resetModules();
  return import('./toolInvokeRouter');
}

describe('toolInvokeRouter', () => {
  beforeEach(() => {
    onSidecarRequest.mockReset();
  });

  it('registers exactly one onSidecarRequest("tool.invoke", ...) handler no matter how many times ensureToolInvokeRouterRegistered() is called', async () => {
    const { ensureToolInvokeRouterRegistered } = await importFresh();
    ensureToolInvokeRouterRegistered();
    ensureToolInvokeRouterRegistered();
    ensureToolInvokeRouterRegistered();

    expect(onSidecarRequest).toHaveBeenCalledTimes(1);
    expect(onSidecarRequest).toHaveBeenCalledWith('tool.invoke', expect.any(Function));
  });

  it('routes to the source that owns the runId', async () => {
    const { registerToolInvokeSource, ensureToolInvokeRouterRegistered } = await importFresh();
    const sourceA = { has: (id: string) => id === 'a-1', handle: vi.fn().mockResolvedValue('from-a') };
    const sourceB = { has: (id: string) => id === 'b-1', handle: vi.fn().mockResolvedValue('from-b') };
    registerToolInvokeSource('sourceA', sourceA);
    registerToolInvokeSource('sourceB', sourceB);
    ensureToolInvokeRouterRegistered();

    const handler = onSidecarRequest.mock.calls[0][1] as (p: unknown) => Promise<unknown>;

    await expect(handler({ runId: 'a-1', toolName: 'x' })).resolves.toBe('from-a');
    expect(sourceA.handle).toHaveBeenCalledWith({ runId: 'a-1', toolName: 'x' });
    expect(sourceB.handle).not.toHaveBeenCalled();

    await expect(handler({ runId: 'b-1', toolName: 'y' })).resolves.toBe('from-b');
    expect(sourceB.handle).toHaveBeenCalledWith({ runId: 'b-1', toolName: 'y' });
  });

  it('two sources never cross-talk — a runId owned by one is never routed to the other, even after both are registered', async () => {
    const { registerToolInvokeSource, ensureToolInvokeRouterRegistered } = await importFresh();
    const subagentSource = { has: (id: string) => id.startsWith('sar-'), handle: vi.fn().mockResolvedValue('subagent-result') };
    const agentLoopSource = { has: (id: string) => id.startsWith('agl-'), handle: vi.fn().mockResolvedValue('agentloop-result') };
    registerToolInvokeSource('subagent', subagentSource);
    registerToolInvokeSource('agentLoop', agentLoopSource);
    ensureToolInvokeRouterRegistered();
    const handler = onSidecarRequest.mock.calls[0][1] as (p: unknown) => Promise<unknown>;

    await handler({ runId: 'sar-123', toolName: 'read_file' });
    expect(subagentSource.handle).toHaveBeenCalledTimes(1);
    expect(agentLoopSource.handle).not.toHaveBeenCalled();

    await handler({ runId: 'agl-456', toolName: 'write_file' });
    expect(agentLoopSource.handle).toHaveBeenCalledTimes(1);
    expect(subagentSource.handle).toHaveBeenCalledTimes(1); // unchanged
  });

  it('rejects with a fail-closed SidecarRequestError when no source owns the runId', async () => {
    const { registerToolInvokeSource, ensureToolInvokeRouterRegistered } = await importFresh();
    registerToolInvokeSource('subagent', { has: () => false, handle: vi.fn() });
    ensureToolInvokeRouterRegistered();
    const handler = onSidecarRequest.mock.calls[0][1] as (p: unknown) => Promise<unknown>;

    await expect(handler({ runId: 'unknown-1', toolName: 'x' })).rejects.toThrow(/unknown runId/);
  });

  it('rejects when runId is missing or not a string, without ever consulting a source', async () => {
    const { registerToolInvokeSource, ensureToolInvokeRouterRegistered } = await importFresh();
    const source = { has: vi.fn().mockReturnValue(true), handle: vi.fn() };
    registerToolInvokeSource('x', source);
    ensureToolInvokeRouterRegistered();
    const handler = onSidecarRequest.mock.calls[0][1] as (p: unknown) => Promise<unknown>;

    await expect(handler(null)).rejects.toThrow(/unknown runId/);
    await expect(handler({ runId: 123 })).rejects.toThrow(/unknown runId/);
    expect(source.has).not.toHaveBeenCalled();
  });

  it('a later-registered source under the SAME name replaces the earlier one (idempotent re-registration)', async () => {
    const { registerToolInvokeSource, ensureToolInvokeRouterRegistered } = await importFresh();
    const first = { has: () => true, handle: vi.fn().mockResolvedValue('first') };
    const second = { has: () => true, handle: vi.fn().mockResolvedValue('second') };
    registerToolInvokeSource('agentLoop', first);
    registerToolInvokeSource('agentLoop', second);
    ensureToolInvokeRouterRegistered();
    const handler = onSidecarRequest.mock.calls[0][1] as (p: unknown) => Promise<unknown>;

    await expect(handler({ runId: 'anything' })).resolves.toBe('second');
    expect(first.handle).not.toHaveBeenCalled();
  });
});
