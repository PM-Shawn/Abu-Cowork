// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Local proxies let each test control invoke/listen/resolveResource
// independently, mirroring the pattern in petVisibility.test.ts /
// nodeRuntime.test.ts (global setup.ts mocks don't cover resolveResource).
const invoke = vi.fn();
const listen = vi.fn();
const resolveResource = vi.fn();
const traceRuntimeEvent = vi.fn();
const reportError = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));
vi.mock('@tauri-apps/api/path', () => ({ resolveResource: (...a: unknown[]) => resolveResource(...a) }));
vi.mock('@/core/observability/runtimeTrace', () => ({
  traceRuntimeEvent: (...a: unknown[]) => traceRuntimeEvent(...a),
}));
vi.mock('@/utils/consoleError', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import {
  startSidecar,
  stopSidecar,
  getSidecarStatus,
  request,
  notifySidecar,
  onSidecarNotification,
  onSidecarRequest,
  onSidecarConnectionState,
  SidecarRequestError,
  __resetForTests,
} from './sidecarManager';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import type { EnterpriseBinding } from '@/core/enterprise/types';

type EventPayload = { payload: string };
type EventCallback = (event: EventPayload) => void;

/** eventName -> the callback most recently registered via listen(eventName, cb) */
let listenCallbacks: Map<string, EventCallback>;

const enterpriseBinding: EnterpriseBinding = {
  serverUrl: 'https://enterprise.example', orgId: 'org-1', orgName: 'Org',
  userId: 'user-1', userName: 'User', userEmail: 'user@example.com',
  deptId: null, roleId: null, accessToken: 'token', boundAt: '2026-08-05T00:00:00Z',
  llmEndpoint: null, llmVirtualKey: null, llmKeyExpiresAt: null,
};

function emitClose(): void {
  listenCallbacks.get('mcp-close-abu-sidecar')?.({ payload: '' });
}

/** Simulate electron/mcpBridge.cjs's main-process heartbeat monitor emitting a hang signal (F1). */
function emitHung(): void {
  listenCallbacks.get('mcp-hung-abu-sidecar')?.({ payload: '' });
}

function emitMsg(payload: unknown): void {
  listenCallbacks.get('mcp-msg-abu-sidecar')?.({ payload: JSON.stringify(payload) });
}

function spawnCallCount(): number {
  return invoke.mock.calls.filter((c) => c[0] === 'mcp_spawn').length;
}

function killCallCount(): number {
  return invoke.mock.calls.filter((c) => c[0] === 'mcp_kill').length;
}

/** Wire up default happy-path mocks: spawn/kill/write all resolve, listen captures callbacks. */
function mockHappyPath(): void {
  resolveResource.mockResolvedValue('/resources/sidecar/index.mjs');
  invoke.mockResolvedValue(undefined);
  listen.mockImplementation((eventName: string, cb: EventCallback) => {
    listenCallbacks.set(eventName, cb);
    // Deliberately does NOT remove from listenCallbacks on unlisten — lets
    // tests simulate "late" events arriving after stopSidecar() to verify
    // the deliberatelyStopped guard itself, not just listener teardown.
    return Promise.resolve(() => {});
  });
}

describe('sidecarManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    listen.mockReset();
    resolveResource.mockReset();
    traceRuntimeEvent.mockReset();
    reportError.mockReset();
    listenCallbacks = new Map();
    __resetForTests();
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    // Simulate running inside the Tauri webview (see utils/tauriEnv.ts) —
    // happy-dom has no __TAURI_INTERNALS__ by default, so the gated no-op
    // test below explicitly deletes it instead.
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    // Default host gate state: __ABU_SHELL__ absent = Tauri path (renderer
    // heartbeat runs) — matches production Tauri (electron/preload.cjs is
    // the only place that ever sets this). The "host gate" describe block
    // below explicitly sets it to simulate Electron.
    delete (window as Window & { __ABU_SHELL__?: unknown }).__ABU_SHELL__;
  });

  afterEach(() => {
    __resetForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (window as Window & { __ABU_SHELL__?: unknown }).__ABU_SHELL__;
  });

  describe('startSidecar', () => {
    it('seeds and live-pushes the fail-closed enterprise entitlement mirror', async () => {
      mockHappyPath();
      await startSidecar();

      const entitlementWrites = () => invoke.mock.calls
        .filter((call) => call[0] === 'mcp_write')
        .map((call) => JSON.parse((call as [string, { message: string }])[1].message) as { method?: string; params?: unknown })
        .filter((message) => message.method === 'state.enterpriseEntitlement');

      expect(entitlementWrites()).toContainEqual(expect.objectContaining({
        params: { entitlement: { mode: 'personal', licenseStatus: null, licenseExpiresAt: null, modules: [] } },
      }));

      useEnterpriseStore.setState({
        mode: {
          kind: 'enterprise',
          binding: enterpriseBinding,
          config: {
            brand: { name: 'Org', logoUrl: null, primaryColor: null },
            defaultSoul: null,
            policyDefaults: {},
            modules: ['skills'],
            licenseStatus: 'valid',
            licenseExpiresAt: '2099-01-01T00:00:00Z',
            serverTime: '2026-08-05T00:00:00Z',
            fetchedAt: 1_700_000_000_000, // filler (TESTING.md §3) — not asserted on
          },
        },
      });

      const expectedEntitlement = __ENTERPRISE_BUILD__
        ? {
            mode: 'enterprise', licenseStatus: 'valid',
            licenseExpiresAt: '2099-01-01T00:00:00Z', modules: ['skills'],
          }
        : { mode: 'personal', licenseStatus: null, licenseExpiresAt: null, modules: [] };
      expect(entitlementWrites()).toContainEqual(expect.objectContaining({
        params: { entitlement: expectedEntitlement },
      }));
    });

    it('spawns node with the resolved entry path and registers listeners before spawning', async () => {
      const callOrder: string[] = [];
      resolveResource.mockResolvedValue('/resources/sidecar/index.mjs');
      listen.mockImplementation((eventName: string, cb: EventCallback) => {
        callOrder.push(`listen:${eventName}`);
        listenCallbacks.set(eventName, cb);
        return Promise.resolve(() => {});
      });
      invoke.mockImplementation((cmd: string) => {
        callOrder.push(`invoke:${cmd}`);
        return Promise.resolve(undefined);
      });

      await startSidecar();

      expect(resolveResource).toHaveBeenCalledWith('sidecar/index.mjs');
      expect(invoke).toHaveBeenCalledWith('mcp_spawn', {
        id: 'abu-sidecar',
        command: 'node',
        args: ['/resources/sidecar/index.mjs'],
        env: {},
        heartbeat: true,
      });
      expect(getSidecarStatus()).toBe('running');

      const firstListenIdx = callOrder.findIndex((c) => c.startsWith('listen:'));
      const spawnIdx = callOrder.indexOf('invoke:mcp_spawn');
      expect(firstListenIdx).toBeGreaterThanOrEqual(0);
      expect(firstListenIdx).toBeLessThan(spawnIdx);
    });

    it('is idempotent — concurrent calls only spawn once', async () => {
      mockHappyPath();

      await Promise.all([startSidecar(), startSidecar(), startSidecar()]);

      expect(spawnCallCount()).toBe(1);
      expect(getSidecarStatus()).toBe('running');

      // Calling again once already running is also a no-op.
      await startSidecar();
      expect(spawnCallCount()).toBe(1);
    });

    it('is a fail-soft no-op outside the Tauri webview', async () => {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      mockHappyPath();

      await expect(startSidecar()).resolves.toBeUndefined();

      expect(invoke).not.toHaveBeenCalled();
      expect(getSidecarStatus()).toBe('stopped');
    });

    it('never throws on spawn failure and gives up (failed) after exhausting retries', async () => {
      resolveResource.mockResolvedValue('/resources/sidecar/index.mjs');
      listen.mockImplementation((eventName: string, cb: EventCallback) => {
        listenCallbacks.set(eventName, cb);
        return Promise.resolve(() => {});
      });
      invoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_spawn') return Promise.reject(new Error('spawn ENOENT'));
        return Promise.resolve(undefined);
      });

      await expect(startSidecar()).resolves.toBeUndefined();

      // Exhaust the 3 backoff-scheduled retries within the crash-loop window
      // (each retry waits RESTART_BACKOFF_MS=500ms before trying again).
      await vi.advanceTimersByTimeAsync(4 * 600 + 2000);

      expect(getSidecarStatus()).toBe('failed');
      // initial attempt + 3 retries, then the supervisor gives up.
      expect(spawnCallCount()).toBe(4);
    });
  });

  describe('request/response correlation', () => {
    it('resolves a request when a matching mcp-msg event arrives', async () => {
      mockHappyPath();
      await startSidecar();

      const callsBefore = invoke.mock.calls.length;
      const pending = request('echo', { hello: 'world' }, 2000);

      const writeCall = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write');
      expect(writeCall).toBeDefined();
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as {
        id: number;
        method: string;
      };
      expect(sent.method).toBe('echo');

      emitMsg({ jsonrpc: '2.0', id: sent.id, result: { hello: 'world' } });

      await expect(pending).resolves.toEqual({ hello: 'world' });
    });

    it('rejects a request that times out with no response', async () => {
      mockHappyPath();
      await startSidecar();

      const pending = request('ping', undefined, 1000);
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    });

    it('timeoutMs: 0 means no timeout — the request stays pending indefinitely until a response arrives', async () => {
      mockHappyPath();
      await startSidecar();

      const callsBefore = invoke.mock.calls.length;
      const pending = request('llm.chat', { callId: 'c1' }, 0);
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });

      // Advance far past any normal timeout (default is 5s) — still pending.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(settled).toBe(false);

      const writeCall = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write');
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as { id: number };
      emitMsg({ jsonrpc: '2.0', id: sent.id, result: { ok: true } });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    it('timeoutMs: 0 requests still reject when the sidecar process closes mid-request', async () => {
      mockHappyPath();
      await startSidecar();

      const pending = request('llm.chat', { callId: 'c1' }, 0);
      const assertion = expect(pending).rejects.toThrow(/closed/);
      emitClose();
      await assertion;
    });

    it('an AbortSignal rejects a no-timeout request and ignores its late response', async () => {
      mockHappyPath();
      await startSidecar();

      const callsBefore = invoke.mock.calls.length;
      const controller = new AbortController();
      const pending = request('agent.run', { runId: 'run-1' }, 0, controller.signal);
      const writeCall = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write');
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as { id: number };

      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      // A sidecar that eventually unwinds may still send the original result.
      // It must not resurrect or re-settle the cancelled transport request.
      expect(() => emitMsg({ jsonrpc: '2.0', id: sent.id, result: { reason: 'aborted' } })).not.toThrow();
    });
  });

  describe('notifySidecar', () => {
    it('sends a JSON-RPC notification (no id) via mcp_write', async () => {
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;

      notifySidecar('llm.abort', { callId: 'c1' });
      await Promise.resolve();

      const writeCall = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write');
      expect(writeCall).toBeDefined();
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as {
        id?: number;
        method: string;
        params: unknown;
      };
      expect(sent.id).toBeUndefined();
      expect(sent.method).toBe('llm.abort');
      expect(sent.params).toEqual({ callId: 'c1' });
    });
  });

  describe('onSidecarNotification', () => {
    it('dispatches an incoming notification (method + no id) to a registered handler', async () => {
      mockHappyPath();
      await startSidecar();

      const received: unknown[] = [];
      onSidecarNotification('llm.event', (params) => received.push(params));

      emitMsg({ jsonrpc: '2.0', method: 'llm.event', params: { callId: 'c1', seq: 0 } });

      expect(received).toEqual([{ callId: 'c1', seq: 0 }]);
    });

    it('supports multiple handlers for the same method', async () => {
      mockHappyPath();
      await startSidecar();

      const a: unknown[] = [];
      const b: unknown[] = [];
      onSidecarNotification('llm.event', (p) => a.push(p));
      onSidecarNotification('llm.event', (p) => b.push(p));

      emitMsg({ jsonrpc: '2.0', method: 'llm.event', params: { x: 1 } });

      expect(a).toEqual([{ x: 1 }]);
      expect(b).toEqual([{ x: 1 }]);
    });

    it('unsubscribe stops further dispatch to that handler', async () => {
      mockHappyPath();
      await startSidecar();

      const received: unknown[] = [];
      const unsubscribe = onSidecarNotification('llm.event', (p) => received.push(p));

      emitMsg({ jsonrpc: '2.0', method: 'llm.event', params: { n: 1 } });
      unsubscribe();
      emitMsg({ jsonrpc: '2.0', method: 'llm.event', params: { n: 2 } });

      expect(received).toEqual([{ n: 1 }]);
    });

    it('a notification for a method with no registered handler is silently dropped', async () => {
      mockHappyPath();
      await startSidecar();

      expect(() => emitMsg({ jsonrpc: '2.0', method: 'llm.chatMeta', params: {} })).not.toThrow();
    });

    it('a handler that throws does not prevent other handlers for the same notification from running', async () => {
      mockHappyPath();
      await startSidecar();

      const received: unknown[] = [];
      onSidecarNotification('llm.event', () => { throw new Error('handler bug'); });
      onSidecarNotification('llm.event', (p) => received.push(p));

      expect(() => emitMsg({ jsonrpc: '2.0', method: 'llm.event', params: { ok: true } })).not.toThrow();
      expect(received).toEqual([{ ok: true }]);
    });

    it('does NOT dispatch a message that has both a method and a numeric id (a request/response, not a notification)', async () => {
      mockHappyPath();
      await startSidecar();

      const received: unknown[] = [];
      onSidecarNotification('echo', (p) => received.push(p));

      // A response carries `result`, not `method` — this asserts the inverse:
      // response handling (matched by pendingRequests id) still works
      // unaffected by the new notification-dispatch branch added above it.
      // startSidecar() already fired its own internal self-test 'echo'
      // request during startup, so scope the write-call lookup to calls
      // made AFTER this specific request() to avoid matching that one.
      const callsBefore = invoke.mock.calls.length;
      const pending = request('echo', { a: 1 }, 2000);
      const writeCall = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write');
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as { id: number };
      emitMsg({ jsonrpc: '2.0', id: sent.id, result: { a: 1 } });

      await expect(pending).resolves.toEqual({ a: 1 });
      expect(received).toEqual([]); // the notification handler was never invoked
    });
  });

  describe('onSidecarRequest (P1-3a symmetric RPC — incoming requests from the sidecar)', () => {
    /** Scope write-call lookups to calls made AFTER startSidecar()'s own internal self-test 'echo' request. */
    function writesAfter(callsBefore: number): unknown[] {
      return invoke.mock.calls.slice(callsBefore).filter((c) => c[0] === 'mcp_write');
    }

    it('dispatches an incoming request (method + STRING id) to the registered handler and writes back the result', async () => {
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;

      const handler = vi.fn().mockResolvedValue({ ok: true, toolResult: 'done' });
      onSidecarRequest('tool.invoke', handler);

      emitMsg({ jsonrpc: '2.0', id: 'sq-1', method: 'tool.invoke', params: { toolName: 'read_file' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesAfter(callsBefore).length).toBeGreaterThan(0);

      expect(handler).toHaveBeenCalledWith({ toolName: 'read_file' });
      const writeCall = writesAfter(callsBefore)[0];
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as {
        jsonrpc: string;
        id: string;
        result: unknown;
      };
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.id).toBe('sq-1');
      expect(sent.result).toEqual({ ok: true, toolResult: 'done' });
    });

    it('dispatches an incoming request with a NUMERIC id too (method presence — not id type — decides "incoming request")', async () => {
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;

      const handler = vi.fn().mockResolvedValue('numeric-id-result');
      onSidecarRequest('some.method', handler);

      emitMsg({ jsonrpc: '2.0', id: 42, method: 'some.method', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesAfter(callsBefore).length).toBeGreaterThan(0);

      expect(handler).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(
        (writesAfter(callsBefore)[0] as [string, { message: string }])[1].message,
      ) as { id: number; result: unknown };
      expect(sent.id).toBe(42);
      expect(sent.result).toBe('numeric-id-result');
    });

    it('unknown method → -32601 error response', async () => {
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;

      emitMsg({ jsonrpc: '2.0', id: 'sq-2', method: 'no.such.method', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesAfter(callsBefore).length).toBeGreaterThan(0);

      const sent = JSON.parse(
        (writesAfter(callsBefore)[0] as [string, { message: string }])[1].message,
      ) as { id: string; error: { code: number; message: string } };
      expect(sent.id).toBe('sq-2');
      expect(sent.error.code).toBe(-32601);
      expect(sent.error.message).toContain('no.such.method');
    });

    it('handler throwing a plain Error → -32000 with just a message (no data)', async () => {
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;

      onSidecarRequest('boom', async () => { throw new Error('handler bug'); });
      emitMsg({ jsonrpc: '2.0', id: 'sq-3', method: 'boom', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesAfter(callsBefore).length).toBeGreaterThan(0);

      const sent = JSON.parse(
        (writesAfter(callsBefore)[0] as [string, { message: string }])[1].message,
      ) as { id: string; error: { code: number; message: string; data?: unknown } };
      expect(sent.error.code).toBe(-32000);
      expect(sent.error.message).toBe('handler bug');
      expect(sent.error.data).toBeUndefined();
    });

    it('handler throwing a SidecarRequestError → carries the custom code + data through', async () => {
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;

      onSidecarRequest('picky', async () => {
        throw new SidecarRequestError(-32001, 'bad input', { field: 'toolName' });
      });
      emitMsg({ jsonrpc: '2.0', id: 'sq-4', method: 'picky', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesAfter(callsBefore).length).toBeGreaterThan(0);

      const sent = JSON.parse(
        (writesAfter(callsBefore)[0] as [string, { message: string }])[1].message,
      ) as { id: string; error: { code: number; message: string; data?: unknown } };
      expect(sent.error.code).toBe(-32001);
      expect(sent.error.message).toBe('bad input');
      expect(sent.error.data).toEqual({ field: 'toolName' });
    });

    it('unsubscribe removes the handler — a subsequent call for that method becomes "method not found"', async () => {
      mockHappyPath();
      await startSidecar();

      const handler = vi.fn().mockResolvedValue('ok');
      const unsubscribe = onSidecarRequest('tool.invoke', handler);
      unsubscribe();

      const callsBefore = invoke.mock.calls.length;
      emitMsg({ jsonrpc: '2.0', id: 'sq-5', method: 'tool.invoke', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesAfter(callsBefore).length).toBeGreaterThan(0);

      expect(handler).not.toHaveBeenCalled();
      const sent = JSON.parse(
        (writesAfter(callsBefore)[0] as [string, { message: string }])[1].message,
      ) as { error: { code: number } };
      expect(sent.error.code).toBe(-32601);
    });

    it('a stale unsubscribe (after a second registration replaced the handler) does not remove the NEW handler', async () => {
      mockHappyPath();
      await startSidecar();

      const first = vi.fn().mockResolvedValue('first');
      const second = vi.fn().mockResolvedValue('second');
      const unsubscribeFirst = onSidecarRequest('tool.invoke', first);
      onSidecarRequest('tool.invoke', second); // replaces `first` as the registered handler
      unsubscribeFirst(); // must be a no-op — `first` is no longer the current handler

      const callsBefore = invoke.mock.calls.length;
      emitMsg({ jsonrpc: '2.0', id: 'sq-6', method: 'tool.invoke', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesAfter(callsBefore).length).toBeGreaterThan(0);

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(
        (writesAfter(callsBefore)[0] as [string, { message: string }])[1].message,
      ) as { result: unknown };
      expect(sent.result).toBe('second');
    });

    it('string-id incoming requests never collide with numeric-id responses to our own outbound requests (disjoint id spaces)', async () => {
      mockHappyPath();
      await startSidecar();

      const requestHandler = vi.fn().mockResolvedValue('handled');
      onSidecarRequest('tool.invoke', requestHandler);

      const callsBefore = invoke.mock.calls.length;
      // Our own outbound request mints a NUMERIC id.
      const pending = request('echo', { x: 1 }, 2000);
      const sent = JSON.parse(
        (writesAfter(callsBefore)[0] as [string, { message: string }])[1].message,
      ) as { id: number };
      expect(typeof sent.id).toBe('number');

      // A sidecar-initiated incoming request uses a STRING id ('sq-N' scheme) —
      // simulate one arriving interleaved with our still-pending outbound request.
      emitMsg({ jsonrpc: '2.0', id: 'sq-7', method: 'tool.invoke', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestHandler).toHaveBeenCalledTimes(1);

      // Our outbound request is still pending, unaffected by the incoming one.
      emitMsg({ jsonrpc: '2.0', id: sent.id, result: { x: 1 } });
      await expect(pending).resolves.toEqual({ x: 1 });
    });
  });

  describe('main-process heartbeat hang signal (F1 — mcp-hung-abu-sidecar)', () => {
    // The ping/pong liveness loop itself now runs in electron/mcpBridge.cjs
    // (main process), not here — see sidecarManager.ts's module JSDoc "F1".
    // This module's own responsibility is just: subscribe to the event, and
    // react by force-restarting (mirroring the old runHeartbeat() threshold
    // branch), guarded so it only acts while actually 'running'.

    it('forces a restart when a mcp-hung event arrives while running', async () => {
      mockHappyPath();
      await startSidecar();
      expect(getSidecarStatus()).toBe('running');

      const spawnsBefore = spawnCallCount();
      const killsBefore = killCallCount();

      emitHung();
      // forceRestartOnHang() awaits mcp_kill before scheduling the respawn —
      // let that microtask chain (and the RESTART_BACKOFF_MS timer it sets up
      // via scheduleRestartOrGiveUp) run to completion.
      await vi.advanceTimersByTimeAsync(0);
      expect(getSidecarStatus()).toBe('restarting');
      expect(killCallCount()).toBeGreaterThan(killsBefore);

      await vi.advanceTimersByTimeAsync(1000);

      expect(spawnCallCount()).toBe(spawnsBefore + 1);
      expect(getSidecarStatus()).toBe('running');
    });

    it('a hung event while NOT running (e.g. mid-restart already, or stopped) is ignored', async () => {
      mockHappyPath();
      await startSidecar();
      await stopSidecar();
      expect(getSidecarStatus()).toBe('stopped');

      const spawnsBefore = spawnCallCount();
      const killsBefore = killCallCount();

      // A stray/late hung event after a deliberate stop must not resurrect
      // the sidecar — forceRestartOnHang()'s `status !== 'running'` guard.
      emitHung();
      await vi.advanceTimersByTimeAsync(2000);

      expect(getSidecarStatus()).toBe('stopped');
      expect(spawnCallCount()).toBe(spawnsBefore);
      expect(killCallCount()).toBe(killsBefore);
    });

    it('a second hung event that arrives while the first is still restarting does not pile on an extra restart', async () => {
      mockHappyPath();
      await startSidecar();
      expect(getSidecarStatus()).toBe('running');

      const spawnsBefore = spawnCallCount();

      emitHung();
      await vi.advanceTimersByTimeAsync(0);
      expect(getSidecarStatus()).toBe('restarting');

      // Fires again before the first restart's respawn has landed — the
      // status !== 'running' guard should make this a no-op.
      emitHung();
      await vi.advanceTimersByTimeAsync(1000);

      expect(getSidecarStatus()).toBe('running');
      expect(spawnCallCount()).toBe(spawnsBefore + 1); // exactly one respawn, not two
    });
  });

  describe('heartbeat (Tauri path — window.__ABU_SHELL__ absent, gate off)', () => {
    it('forces a restart after 3 consecutive ping timeouts', async () => {
      mockHappyPath(); // mcp_write always "succeeds" but nothing ever responds -> pings time out

      await startSidecar();
      expect(getSidecarStatus()).toBe('running');

      const spawnsBefore = spawnCallCount();

      // 3 heartbeat cycles (10s apart), each ping timing out after 5s, plus
      // the 500ms restart backoff for the resulting respawn attempt.
      await vi.advanceTimersByTimeAsync(3 * 10_000 + 5_000 + 1_000);

      expect(spawnCallCount()).toBe(spawnsBefore + 1);
      expect(killCallCount()).toBeGreaterThanOrEqual(2); // initial defensive kill + heartbeat-forced kill
      expect(getSidecarStatus()).toBe('running');
    });
  });

  describe('heartbeat renderer-jank guard (runHeartbeat() elapsed-time check)', () => {
    // Mirror the constants in sidecarManager.ts (not exported, so duplicated
    // here — see that file's HEARTBEAT_TIMEOUT_MS / HEARTBEAT_INTERVAL_MS /
    // HEARTBEAT_JANK_MARGIN_MS and the runHeartbeat() JSDoc for the
    // jank-margin rationale this describe block exercises).
    const HEARTBEAT_INTERVAL = 10_000;
    const HEARTBEAT_TIMEOUT = 5_000;
    const HEARTBEAT_JANK_MARGIN = 5_000;
    const RESTART_BACKOFF = 500;

    /**
     * Spy on performance.now() so a test can inflate what runHeartbeat()
     * observes between capturing `start` and computing `elapsed` — production
     * measures elapsed via the monotonic clock (performance.now()), NOT
     * Date.now() (see runHeartbeat()'s JSDoc: a wall-clock forward step must
     * not be misread as elapsed time). This is independent of the fake-timer
     * clock that actually governs *when* the ping's internal setTimeout
     * fires — that bookkeeping still uses Date.now()/the fake clock (via
     * vi.advanceTimersByTimeAsync). Injecting the offset here reproduces a
     * stalled renderer event loop precisely: real elapsed time
     * (performance.now()) keeps advancing while the loop is stalled, but the
     * timer schedule itself isn't otherwise touched. Must be restored after
     * use (no global restoreMocks in this project's vitest config).
     */
    function spyOnPerfNowWithOffset(): { setOffset: (ms: number) => void; restore: () => void } {
      const realNow = performance.now.bind(performance);
      let offset = 0;
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
      return {
        setOffset: (ms: number) => {
          offset = ms;
        },
        restore: () => spy.mockRestore(),
      };
    }

    it('a late ping timeout caused by a stalled renderer event loop is inconclusive — not counted, no restart after 3 cycles', async () => {
      mockHappyPath(); // pings never get a response -> each rejects via request()'s own internal timeout

      await startSidecar();
      expect(getSidecarStatus()).toBe('running');

      const spawnsBefore = spawnCallCount();
      const killsBefore = killCallCount();

      // vi.useFakeTimers() is active (outer beforeEach) — Date.now() reads the fake,
      // advancing clock, not real wall-clock time.
      // eslint-disable-next-line no-restricted-syntax -- fake timers active, see comment above
      const baseNow = Date.now();
      const perfNow = spyOnPerfNowWithOffset();
      let nextIntervalAt = baseNow + HEARTBEAT_INTERVAL;

      try {
        for (let i = 0; i < 3; i++) {
          perfNow.setOffset(0);
          // Re-read the fake clock's current (advanced) value each iteration —
          // this drives the next vi.advanceTimersByTimeAsync() delta below, so it
          // cannot be a fixed constant.
          // eslint-disable-next-line no-restricted-syntax -- fake timers active, see comment above
          const now = Date.now();
          // Advance exactly to the next heartbeat interval firing — this is
          // where runHeartbeat() captures `start` via performance.now()
          // (offset 0, so it reads the real — effectively unmoving — clock).
          await vi.advanceTimersByTimeAsync(nextIntervalAt - now);

          // Before the ping's own HEARTBEAT_TIMEOUT-ms setTimeout fires,
          // inflate performance.now() well past the jank margin — simulating
          // the renderer stalling for that long before it can even process
          // the timer callback that rejects the pending ping.
          perfNow.setOffset(HEARTBEAT_TIMEOUT + HEARTBEAT_JANK_MARGIN + 1_000);
          await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT); // fires the ping's own (now "late") timeout

          nextIntervalAt += HEARTBEAT_INTERVAL;
        }
      } finally {
        perfNow.restore();
      }

      // None of the 3 cycles should have counted as a real heartbeat failure.
      expect(spawnCallCount()).toBe(spawnsBefore);
      expect(killCallCount()).toBe(killsBefore);
      expect(getSidecarStatus()).toBe('running');
    });

    it('an on-time ping timeout (healthy loop, timer on schedule) still counts as a real failure and forces a restart after 3 cycles', async () => {
      mockHappyPath();

      await startSidecar();
      expect(getSidecarStatus()).toBe('running');

      const spawnsBefore = spawnCallCount();
      const killsBefore = killCallCount();

      // 3 heartbeat cycles, each ping rejecting right at HEARTBEAT_TIMEOUT —
      // no renderer stall injected, so elapsed ≈ HEARTBEAT_TIMEOUT, nowhere
      // near HEARTBEAT_TIMEOUT + HEARTBEAT_JANK_MARGIN. Every cycle counts,
      // and the resulting forced restart's respawn fires after the 500ms
      // RESTART_BACKOFF_MS (the trailing +1_000 covers that).
      await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT + 1_000);

      expect(spawnCallCount()).toBe(spawnsBefore + 1);
      expect(killCallCount()).toBeGreaterThan(killsBefore);
      expect(getSidecarStatus()).toBe('running');
    });

    it('an inconclusive/jank cycle resets the consecutive-failure streak — it cannot combine with an earlier real failure and a later real failure to trip a spurious restart', async () => {
      mockHappyPath(); // pings never get a response -> each rejects via request()'s own internal timeout

      await startSidecar();
      expect(getSidecarStatus()).toBe('running');

      const spawnsBefore = spawnCallCount();
      const killsBefore = killCallCount();

      // vi.useFakeTimers() is active (outer beforeEach) — Date.now() reads the fake,
      // advancing clock, not real wall-clock time.
      // eslint-disable-next-line no-restricted-syntax -- fake timers active, see comment above
      const baseNow = Date.now();
      const perfNow = spyOnPerfNowWithOffset();
      let nextIntervalAt = baseNow + HEARTBEAT_INTERVAL;

      // Cycle 1: on-time failure  -> heartbeatFailures: 0 -> 1
      // Cycle 2: on-time failure  -> heartbeatFailures: 1 -> 2 (still below the
      //          HEARTBEAT_FAILURE_THRESHOLD of 3 — no restart yet)
      // Cycle 3: inconclusive/jank -> heartbeatFailures RESET to 0 (this is the
      //          F3 fix under test: without the reset, this cycle used to be a
      //          silent no-op that left the streak at 2)
      // Cycle 4: on-time failure  -> heartbeatFailures: 0 -> 1 (NOT 3 — the jank
      //          cycle broke the streak, so this can't combine with cycles 1-2
      //          to trip a restart)
      const cycles: Array<'on-time' | 'jank'> = ['on-time', 'on-time', 'jank', 'on-time'];

      try {
        for (const kind of cycles) {
          perfNow.setOffset(0);
          // Re-read the fake clock's current (advanced) value each iteration —
          // this drives the next vi.advanceTimersByTimeAsync() delta below, so it
          // cannot be a fixed constant.
          // eslint-disable-next-line no-restricted-syntax -- fake timers active, see comment above
          const now = Date.now();
          // Advance exactly to the next heartbeat interval firing — this is
          // where runHeartbeat() captures `start` via performance.now()
          // (offset 0, so it reads the real — effectively unmoving — clock).
          await vi.advanceTimersByTimeAsync(nextIntervalAt - now);

          if (kind === 'jank') {
            // Inflate performance.now() well past the jank margin before the
            // ping's own timeout fires, simulating a stalled renderer event
            // loop — this cycle is inconclusive, not a real failure.
            perfNow.setOffset(HEARTBEAT_TIMEOUT + HEARTBEAT_JANK_MARGIN + 1_000);
          } else {
            perfNow.setOffset(0);
          }
          await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT); // fires the ping's own timeout

          nextIntervalAt += HEARTBEAT_INTERVAL;
        }

        // Drain any restart that WOULD have been scheduled (respawn fires
        // RESTART_BACKOFF_MS after a forced kill) — without the F3 reset, cycle
        // 4 above would have been the 3rd counted failure and tripped exactly
        // this path. Draining it here makes the assertions below fail loudly
        // (spawnCallCount/killCallCount both increment) against the old,
        // un-reset behavior, rather than merely deferring the restart past the
        // end of the test.
        await vi.advanceTimersByTimeAsync(RESTART_BACKOFF + 1_000);
      } finally {
        perfNow.restore();
      }

      // 2 real failures + 1 reset + 1 real failure = a streak of 1, nowhere
      // near the threshold of 3 — no restart should ever have been triggered.
      expect(spawnCallCount()).toBe(spawnsBefore);
      expect(killCallCount()).toBe(killsBefore);
      expect(getSidecarStatus()).toBe('running');
    });
  });

  describe('host gate (window.__ABU_SHELL__.mainSupervisesSidecar)', () => {
    it('uses the dedicated Electron sidecar channel instead of Tauri event subscriptions', async () => {
      let dedicatedHandler: ((event: {
        type: 'message' | 'error' | 'close' | 'hung';
        payload: string;
        sequence: number;
        generation: number;
      }) => void) | undefined;
      const unsubscribe = vi.fn();
      (window as Window & {
        __ABU_SHELL__?: {
          mainSupervisesSidecar: boolean;
          subscribeSidecarEvents: (handler: (event: {
            type: 'message' | 'error' | 'close' | 'hung';
            payload: string;
            sequence: number;
            generation: number;
          }) => void) => () => void;
        };
      }).__ABU_SHELL__ = {
        mainSupervisesSidecar: true,
        subscribeSidecarEvents: (handler) => {
          dedicatedHandler = handler;
          return unsubscribe;
        },
      };
      mockHappyPath();

      await startSidecar();
      expect(listen).not.toHaveBeenCalled();
      expect(dedicatedHandler).toBeTypeOf('function');

      const callsBefore = invoke.mock.calls.length;
      const pending = request('echo', { via: 'dedicated' }, 2_000);
      const writeCall = invoke.mock.calls.slice(callsBefore).find((call) => call[0] === 'mcp_write');
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as { id: number };
      dedicatedHandler?.({
        type: 'message',
        payload: JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } }),
        sequence: 1,
        generation: 1,
      });
      await expect(pending).resolves.toEqual({ ok: true });

      await stopSidecar();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('detects a dedicated-channel sequence gap and replays the missing response from main', async () => {
      let dedicatedHandler: ((event: {
        type: 'message' | 'error' | 'close' | 'hung';
        payload: string;
        sequence: number;
        generation: number;
      }) => void) | undefined;
      const getSidecarBridgeSnapshot = vi.fn();
      (window as Window & {
        __ABU_SHELL__?: {
          mainSupervisesSidecar: boolean;
          subscribeSidecarEvents: (handler: NonNullable<typeof dedicatedHandler>) => () => void;
          getSidecarBridgeSnapshot: typeof getSidecarBridgeSnapshot;
        };
      }).__ABU_SHELL__ = {
        mainSupervisesSidecar: true,
        subscribeSidecarEvents: (handler) => {
          dedicatedHandler = handler;
          return () => {};
        },
        getSidecarBridgeSnapshot,
      };
      mockHappyPath();
      await startSidecar();

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] baseline', sequence: 1, generation: 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      const states: string[] = [];
      onSidecarConnectionState((event) => states.push(event.state));
      const callsBefore = invoke.mock.calls.length;
      const pending = request('echo', { via: 'replay' }, 2_000);
      const writeCall = invoke.mock.calls.slice(callsBefore).find((call) => call[0] === 'mcp_write');
      const sent = JSON.parse((writeCall as [string, { message: string }])[1].message) as { id: number };
      getSidecarBridgeSnapshot.mockResolvedValue({
        version: 1,
        sidecarId: 'abu-sidecar',
        generation: 1,
        bridgeStatus: 'running',
        firstAvailableSequence: 1,
        lastSequence: 3,
        truncated: false,
        events: [
          {
            type: 'message',
            payload: JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { recovered: true } }),
            sequence: 2,
            generation: 1,
          },
          {
            type: 'error', payload: '[sidecar:test] [info] live', sequence: 3, generation: 1,
          },
        ],
        runs: [],
      });

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] live', sequence: 3, generation: 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(pending).resolves.toEqual({ recovered: true });
      expect(getSidecarBridgeSnapshot).toHaveBeenCalledWith(1);
      expect(states).toContain('recovering');
      expect(states.at(-1)).toBe('connected');
    });

    it('does not execute reverse RPC requests from a truncated replay window', async () => {
      let dedicatedHandler: ((event: {
        type: 'message' | 'error' | 'close' | 'hung';
        payload: string;
        sequence: number;
        generation: number;
      }) => void) | undefined;
      const getSidecarBridgeSnapshot = vi.fn();
      (window as Window & {
        __ABU_SHELL__?: {
          mainSupervisesSidecar: boolean;
          subscribeSidecarEvents: (handler: NonNullable<typeof dedicatedHandler>) => () => void;
          getSidecarBridgeSnapshot: typeof getSidecarBridgeSnapshot;
        };
      }).__ABU_SHELL__ = {
        mainSupervisesSidecar: true,
        subscribeSidecarEvents: (handler) => {
          dedicatedHandler = handler;
          return () => {};
        },
        getSidecarBridgeSnapshot,
      };
      mockHappyPath();
      await startSidecar();

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] baseline', sequence: 1, generation: 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      const toolHandler = vi.fn().mockResolvedValue({ ok: true });
      onSidecarRequest('tool.invoke', toolHandler);
      const states: string[] = [];
      onSidecarConnectionState((connection) => states.push(connection.state));
      const reverseRequest = JSON.stringify({
        jsonrpc: '2.0', id: 'sidecar-tool-1', method: 'tool.invoke',
        params: { toolName: 'write_file', input: { path: '/tmp/should-not-run' } },
      });
      getSidecarBridgeSnapshot.mockResolvedValue({
        version: 1,
        sidecarId: 'abu-sidecar',
        generation: 1,
        bridgeStatus: 'running',
        firstAvailableSequence: 2,
        lastSequence: 3,
        truncated: true,
        events: [
          { type: 'message', payload: reverseRequest, sequence: 2, generation: 1 },
          { type: 'error', payload: '[sidecar:test] [info] live', sequence: 3, generation: 1 },
        ],
        runs: [],
      });

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] live', sequence: 3, generation: 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(toolHandler).not.toHaveBeenCalled();
      expect(states).toContain('recovering');
      expect(states.at(-1)).toBe('failed');
    });

    it('when mainSupervisesSidecar is true, startSidecar() does NOT start a renderer heartbeat, but the mcp-hung listener still forces a restart', async () => {
      (window as Window & { __ABU_SHELL__?: { mainSupervisesSidecar: boolean } }).__ABU_SHELL__ = {
        mainSupervisesSidecar: true,
      };
      mockHappyPath(); // if a renderer heartbeat ping were sent, it would never get a response

      await startSidecar();
      expect(getSidecarStatus()).toBe('running');

      const spawnsBefore = spawnCallCount();
      const writeCallsBefore = invoke.mock.calls.filter((c) => c[0] === 'mcp_write').length;

      // Advance well past 3 renderer-heartbeat cycles. If the gate failed to
      // suppress startHeartbeat(), this would issue 'ping' writes and, after
      // 3 consecutive timeouts, force a restart — neither should happen here.
      await vi.advanceTimersByTimeAsync(3 * 10_000 + 5_000 + 1_000);

      const pingWrites = invoke.mock.calls
        .filter((c) => c[0] === 'mcp_write')
        .slice(writeCallsBefore)
        .filter((c) => {
          try {
            const msg = JSON.parse((c[1] as { message: string }).message) as { method?: string };
            return msg.method === 'ping';
          } catch {
            return false;
          }
        });
      expect(pingWrites.length).toBe(0); // no renderer heartbeat ping was ever sent
      expect(spawnCallCount()).toBe(spawnsBefore); // no heartbeat-triggered restart
      expect(getSidecarStatus()).toBe('running');

      // The mcp-hung listener (Electron's main-process path) still works —
      // registered unconditionally regardless of the gate.
      emitHung();
      await vi.advanceTimersByTimeAsync(1000);

      expect(spawnCallCount()).toBe(spawnsBefore + 1);
      expect(getSidecarStatus()).toBe('running');
    });
  });

  describe('exit supervision', () => {
    it('auto-restarts on an unexpected close event', async () => {
      mockHappyPath();
      await startSidecar();

      const spawnsBefore = spawnCallCount();
      emitClose();
      expect(getSidecarStatus()).toBe('restarting');

      await vi.advanceTimersByTimeAsync(1000);

      expect(spawnCallCount()).toBe(spawnsBefore + 1);
      expect(getSidecarStatus()).toBe('running');
    });

    it('does not restart after a deliberate stopSidecar()', async () => {
      mockHappyPath();
      await startSidecar();
      await stopSidecar();

      expect(getSidecarStatus()).toBe('stopped');
      const spawnsBefore = spawnCallCount();

      // Simulate a late/stray close event arriving after the deliberate stop.
      emitClose();
      await vi.advanceTimersByTimeAsync(2000);

      expect(getSidecarStatus()).toBe('stopped');
      expect(spawnCallCount()).toBe(spawnsBefore);
    });
  });

  describe('crash-loop guard', () => {
    it('gives up after more than 3 restarts within a 60s window', async () => {
      mockHappyPath();
      await startSidecar(); // initial spawn — not itself counted as a "restart"

      for (let i = 0; i < 3; i++) {
        emitClose();
        await vi.advanceTimersByTimeAsync(600); // past RESTART_BACKOFF_MS
        expect(getSidecarStatus()).toBe('running');
      }

      const spawnsBeforeFourth = spawnCallCount();

      // 4th close within the same 60s window trips the guard.
      emitClose();
      await vi.advanceTimersByTimeAsync(2000);

      expect(getSidecarStatus()).toBe('failed');
      expect(spawnCallCount()).toBe(spawnsBeforeFourth); // no further spawn calls
    });

    it('records every restart locally but only reports the breaker remotely', async () => {
      mockHappyPath();
      await startSidecar();

      emitClose();
      await vi.advanceTimersByTimeAsync(600);

      expect(traceRuntimeEvent).toHaveBeenCalledWith('renderer.sidecar_restart_scheduled', {
        sidecarId: 'abu-sidecar',
        reason: 'close',
        attemptCount: 1,
        stage: 'restarting',
        outcome: 'error',
      });
      // A single recovered restart is routine — nothing leaves the machine.
      expect(reportError).not.toHaveBeenCalled();

      for (let i = 0; i < 3; i++) {
        emitClose();
        await vi.advanceTimersByTimeAsync(600);
      }

      expect(traceRuntimeEvent).toHaveBeenCalledWith('renderer.sidecar_crash_loop', {
        sidecarId: 'abu-sidecar',
        reason: 'close',
        attemptCount: 4,
        outcome: 'error',
        errorType: 'sidecar_crash_loop',
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        'sidecar_crash',
        'close',
        undefined,
        undefined,
        'Sidecar crash-looped: 4 restarts within 60000ms',
      );
    });

    it('reports the crash-loop only once even if failures keep arriving', async () => {
      mockHappyPath();
      await startSidecar();

      for (let i = 0; i < 6; i++) {
        emitClose();
        await vi.advanceTimersByTimeAsync(600);
      }

      expect(getSidecarStatus()).toBe('failed');
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(
        traceRuntimeEvent.mock.calls.filter((call) => call[0] === 'renderer.sidecar_crash_loop'),
      ).toHaveLength(1);
    });
  });
});
