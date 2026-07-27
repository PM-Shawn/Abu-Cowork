/**
 * hookBridge.ts — the neutral, shared `hook.emit`/`hook.notify` registration
 * used by BOTH subagentRunner.ts and agentLoopRunner.ts (P1-3b-4). Verifies
 * the idempotent single-registration and the stateless forward-to-emitHook
 * behavior in isolation, independent of either caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const onSidecarRequest = vi.fn();
const onSidecarNotification = vi.fn();
class MockSidecarRequestError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
vi.mock('../sidecar/sidecarManager', () => ({
  onSidecarRequest: (...a: unknown[]) => onSidecarRequest(...a),
  onSidecarNotification: (...a: unknown[]) => onSidecarNotification(...a),
  SidecarRequestError: MockSidecarRequestError,
}));

const emitHookMock = vi.fn();
vi.mock('./lifecycleHooks', () => ({
  emitHook: (...a: unknown[]) => emitHookMock(...a),
}));

async function importFresh() {
  vi.resetModules();
  return import('./hookBridge');
}

describe('hookBridge', () => {
  beforeEach(() => {
    onSidecarRequest.mockReset();
    onSidecarNotification.mockReset();
    emitHookMock.mockReset();
  });

  it('registers exactly one hook.emit + one hook.notify handler no matter how many times called', async () => {
    const { ensureHookBridgeRegistered } = await importFresh();
    ensureHookBridgeRegistered();
    ensureHookBridgeRegistered();
    ensureHookBridgeRegistered();

    expect(onSidecarRequest).toHaveBeenCalledTimes(1);
    expect(onSidecarRequest).toHaveBeenCalledWith('hook.emit', expect.any(Function));
    expect(onSidecarNotification).toHaveBeenCalledTimes(1);
    expect(onSidecarNotification).toHaveBeenCalledWith('hook.notify', expect.any(Function));
  });

  it('hook.emit handler forwards the event to emitHook and returns its (possibly mutated) result', async () => {
    const { ensureHookBridgeRegistered } = await importFresh();
    ensureHookBridgeRegistered();
    const handler = onSidecarRequest.mock.calls.find((c) => c[0] === 'hook.emit')![1] as (p: unknown) => Promise<unknown>;

    const event = { type: 'preToolCall', conversationId: 'c1', toolName: 'read_file', toolInput: {} };
    emitHookMock.mockResolvedValue({ ...event, blocked: true, modifiedInput: { x: 1 } });

    const result = await handler({ event });
    expect(emitHookMock).toHaveBeenCalledWith(event);
    expect(result).toMatchObject({ blocked: true, modifiedInput: { x: 1 } });
  });

  it('reattaches the live run AbortSignal for shell hooks without returning it over JSON-RPC', async () => {
    const { ensureHookBridgeRegistered, registerHookSignalSource } = await importFresh();
    const controller = new AbortController();
    registerHookSignalSource('test-runner', {
      getAbortSignal: (runId) => runId === 'run-1' ? controller.signal : undefined,
    });
    ensureHookBridgeRegistered();
    const handler = onSidecarRequest.mock.calls.find((c) => c[0] === 'hook.emit')![1] as (p: unknown) => Promise<unknown>;
    const event = { type: 'preToolCall', toolName: 'write_file', toolInput: {} };
    emitHookMock.mockImplementation(async (received) => received);

    const result = await handler({ runId: 'run-1', event });

    expect(emitHookMock).toHaveBeenCalledWith({
      ...event,
      abortSignal: controller.signal,
    });
    expect(result).toEqual(event);
  });

  it('hook.emit handler throws -32602 when event is missing', async () => {
    const { ensureHookBridgeRegistered } = await importFresh();
    ensureHookBridgeRegistered();
    const handler = onSidecarRequest.mock.calls.find((c) => c[0] === 'hook.emit')![1] as (p: unknown) => Promise<unknown>;

    await expect(handler({})).rejects.toMatchObject({ code: -32602 });
    await expect(handler(null)).rejects.toMatchObject({ code: -32602 });
    expect(emitHookMock).not.toHaveBeenCalled();
  });

  it('hook.notify handler forwards the event fire-and-forget (no throw on missing event)', async () => {
    const { ensureHookBridgeRegistered } = await importFresh();
    ensureHookBridgeRegistered();
    const handler = onSidecarNotification.mock.calls.find((c) => c[0] === 'hook.notify')![1] as (p: unknown) => void;

    const event = { type: 'postToolCall', conversationId: 'c1', toolName: 'read_file', toolInput: {}, result: 'ok', error: false };
    handler({ event });
    expect(emitHookMock).toHaveBeenCalledWith(event);

    emitHookMock.mockReset();
    expect(() => handler({})).not.toThrow();
    expect(() => handler(null)).not.toThrow();
    expect(emitHookMock).not.toHaveBeenCalled();
  });

  it('__resetHookBridgeForTests re-arms registration', async () => {
    const mod = await importFresh();
    mod.ensureHookBridgeRegistered();
    expect(onSidecarRequest).toHaveBeenCalledTimes(1);
    mod.__resetHookBridgeForTests();
    mod.ensureHookBridgeRegistered();
    expect(onSidecarRequest).toHaveBeenCalledTimes(2);
  });
});
