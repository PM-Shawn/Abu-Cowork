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
vi.mock('@/core/observability/runtimeTrace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/observability/runtimeTrace')>()),
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
  waitForSidecarStatus,
  registerSidecarNotifyResync,
  sidecarHasCapability,
  SidecarRequestError,
  __resetForTests,
} from './sidecarManager';
import { APP_VERSION } from '@/utils/version';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { IPC_MAX_ARGS_BYTES, PayloadTooLargeError } from '@/core/ipc/payloadTooLarge';
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

/** Decode the JSON-RPC line of an mcp_write call in either wire form (#549). */
function sentMessage(call: unknown): string {
  const args = (call as unknown[] | undefined)?.[1];
  if (args instanceof Uint8Array) return new TextDecoder().decode(args);
  return (args as { message: string }).message;
}

const HANDSHAKE_OK = { protocolVersion: 2, sidecarVersion: 'test', capabilities: ['agent.start.history-from-ledger'] };

type InvokeImpl = (cmd: string, args: unknown) => unknown;

/**
 * Wrap an `invoke` implementation so the post-spawn `handshake` request is
 * answered the way a current sidecar answers it. `deliver` defaults to the
 * Tauri-style message event; a dedicated-channel test passes its own.
 */
function answeringHandshake(
  impl: InvokeImpl = () => Promise.resolve(undefined),
  result: unknown = HANDSHAKE_OK,
  deliver: (response: unknown) => void = emitMsg,
): InvokeImpl {
  return (cmd, args) => {
    const out = impl(cmd, args);
    if (cmd === 'mcp_write') {
      const line = JSON.parse(sentMessage([cmd, args])) as { id?: number; method?: string };
      if (line.method === 'handshake') {
        queueMicrotask(() => deliver({ jsonrpc: '2.0', id: line.id, result }));
      }
    }
    return out;
  };
}

/**
 * Wire up default happy-path mocks: spawn/kill/write all resolve, listen
 * captures callbacks, and the post-spawn handshake is answered. `deliver`
 * carries that answer to the shell; an Electron-shell test passes the
 * dedicated channel's own delivery in place of the Tauri message event.
 */
function mockHappyPath(deliver?: (response: unknown) => void): void {
  resolveResource.mockResolvedValue('/resources/sidecar/index.mjs');
  invoke.mockImplementation(answeringHandshake(undefined, HANDSHAKE_OK, deliver));
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
        .map((call) => JSON.parse(sentMessage(call)) as { method?: string; params?: unknown })
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
      invoke.mockImplementation(answeringHandshake((cmd: string) => {
        callOrder.push(`invoke:${cmd}`);
        return Promise.resolve(undefined);
      }));

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
      const sent = JSON.parse(sentMessage(writeCall)) as {
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

    it('#549: a timeout given as a function is handed the encoded byte length and bounds the request', async () => {
      mockHappyPath();
      await startSidecar();

      const callsBefore = invoke.mock.calls.length;
      const seen: number[] = [];
      const pending = request('agent.start', { runId: 'run-1', text: '中文' }, (encodedBytes) => {
        seen.push(encodedBytes);
        return 4_000;
      });
      const assertion = expect(pending).rejects.toThrow(/timed out after 4000ms/);

      const writeCall = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write');
      expect(seen).toEqual([new TextEncoder().encode(sentMessage(writeCall)).byteLength]);

      await vi.advanceTimersByTimeAsync(3_999);
      await vi.advanceTimersByTimeAsync(1);
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
      const sent = JSON.parse(sentMessage(writeCall)) as { id: number };
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
      const sent = JSON.parse(sentMessage(writeCall)) as { id: number };

      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      // A sidecar that eventually unwinds may still send the original result.
      // It must not resurrect or re-settle the cancelled transport request.
      expect(() => emitMsg({ jsonrpc: '2.0', id: sent.id, result: { reason: 'aborted' } })).not.toThrow();
    });

    it('#549 step 0: traces payloadBytes for measured methods only, with a numbers-only breakdown when large', async () => {
      mockHappyPath();
      await startSidecar();
      traceRuntimeEvent.mockClear();

      const callsBefore = invoke.mock.calls.length;
      void request('agent.start', { runId: 'run-1', userMessage: '中文' }, 1000).catch(() => {});
      void request('echo', { x: 1 }, 1000).catch(() => {});
      const big = 'x'.repeat(1024 * 1024);
      void request('agent.run', { runId: 'run-2', conversationSnapshot: { messages: [{ role: 'user', content: big }] } }, 1000).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      const sent = traceRuntimeEvent.mock.calls.filter((c) => c[0] === 'renderer.sidecar_rpc_sent');
      expect(sent).toHaveLength(2);
      const small = sent[0][1] as Record<string, unknown>;
      expect(small).toMatchObject({ method: 'agent.start', runId: 'run-1', outcome: 'success' });
      const startWrite = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write') as [string, { message: string }];
      expect(JSON.parse(startWrite[1].message)).toMatchObject({ id: Number(small.rpcId), method: 'agent.start' });
      expect(small.payloadBytes).toBe(new TextEncoder().encode(startWrite[1].message).byteLength);
      expect(small.fieldMessagesTextBytes).toBeUndefined();
      const large = sent[1][1] as Record<string, unknown>;
      expect(large).toMatchObject({ method: 'agent.run', runId: 'run-2', outcome: 'success' });
      expect(large.fieldMessagesTextBytes).toBe(1024 * 1024);
      expect(JSON.stringify(sent)).not.toContain('xxxx');
      await vi.advanceTimersByTimeAsync(1000);
    });

    it('#549 step 0: emits renderer.sidecar_rpc_sent only after the write settles, with the real outcome', async () => {
      mockHappyPath();
      await startSidecar();
      traceRuntimeEvent.mockClear();
      const sentEvents = () => traceRuntimeEvent.mock.calls.filter((c) => c[0] === 'renderer.sidecar_rpc_sent');

      let releaseWrite: () => void = () => {};
      invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseWrite = resolve; }));
      void request('llm.chat', { callId: 'c1' }, 1000).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(sentEvents()).toHaveLength(0);

      releaseWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0][1]).toMatchObject({ method: 'llm.chat', outcome: 'success' });

      invoke.mockImplementationOnce(() => Promise.reject(new TypeError('pipe closed: secret detail')));
      const failed = request('subagent.run', { runId: 'run-3', task: 'do' }, 1000);
      await expect(failed).rejects.toThrow(/pipe closed/);
      expect(sentEvents()).toHaveLength(2);
      const failure = sentEvents()[1][1] as Record<string, unknown>;
      expect(failure).toMatchObject({ method: 'subagent.run', runId: 'run-3', outcome: 'error', errorType: 'typeerror' });
      expect(typeof failure.payloadBytes).toBe('number');
      expect(JSON.stringify(failure)).not.toContain('secret detail');
      await vi.advanceTimersByTimeAsync(1000);
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
      const sent = JSON.parse(sentMessage(writeCall)) as {
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
      const sent = JSON.parse(sentMessage(writeCall)) as { id: number };
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
      const sent = JSON.parse(sentMessage(writeCall)) as {
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
        sentMessage(writesAfter(callsBefore)[0]),
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
        sentMessage(writesAfter(callsBefore)[0]),
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
        sentMessage(writesAfter(callsBefore)[0]),
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
        sentMessage(writesAfter(callsBefore)[0]),
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
        sentMessage(writesAfter(callsBefore)[0]),
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
        sentMessage(writesAfter(callsBefore)[0]),
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
        sentMessage(writesAfter(callsBefore)[0]),
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
      mockHappyPath((response) => dedicatedHandler?.({
        type: 'message', payload: JSON.stringify(response), sequence: 1, generation: 1,
      }));

      await startSidecar();
      expect(listen).not.toHaveBeenCalled();
      expect(dedicatedHandler).toBeTypeOf('function');

      const callsBefore = invoke.mock.calls.length;
      const pending = request('echo', { via: 'dedicated' }, 2_000);
      const writeCall = invoke.mock.calls.slice(callsBefore).find((call) => call[0] === 'mcp_write');
      const sent = JSON.parse(sentMessage(writeCall)) as { id: number };
      dedicatedHandler?.({
        type: 'message',
        payload: JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } }),
        sequence: 2,
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
      mockHappyPath((response) => dedicatedHandler?.({
        type: 'message', payload: JSON.stringify(response), sequence: 1, generation: 1,
      }));
      await startSidecar();

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] baseline', sequence: 2, generation: 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      const states: string[] = [];
      onSidecarConnectionState((event) => states.push(event.state));
      const callsBefore = invoke.mock.calls.length;
      const pending = request('echo', { via: 'replay' }, 2_000);
      const writeCall = invoke.mock.calls.slice(callsBefore).find((call) => call[0] === 'mcp_write');
      const sent = JSON.parse(sentMessage(writeCall)) as { id: number };
      getSidecarBridgeSnapshot.mockResolvedValue({
        version: 1,
        sidecarId: 'abu-sidecar',
        generation: 1,
        bridgeStatus: 'running',
        firstAvailableSequence: 2,
        lastSequence: 4,
        truncated: false,
        events: [
          {
            type: 'message',
            payload: JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { recovered: true } }),
            sequence: 3,
            generation: 1,
          },
          {
            type: 'error', payload: '[sidecar:test] [info] live', sequence: 4, generation: 1,
          },
        ],
        runs: [],
      });

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] live', sequence: 4, generation: 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(pending).resolves.toEqual({ recovered: true });
      expect(getSidecarBridgeSnapshot).toHaveBeenCalledWith(2);
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
      mockHappyPath((response) => dedicatedHandler?.({
        type: 'message', payload: JSON.stringify(response), sequence: 1, generation: 1,
      }));
      await startSidecar();

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] baseline', sequence: 2, generation: 1,
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
        firstAvailableSequence: 3,
        lastSequence: 4,
        truncated: true,
        events: [
          { type: 'message', payload: reverseRequest, sequence: 3, generation: 1 },
          { type: 'error', payload: '[sidecar:test] [info] live', sequence: 4, generation: 1 },
        ],
        runs: [],
      });

      dedicatedHandler?.({
        type: 'error', payload: '[sidecar:test] [info] live', sequence: 4, generation: 1,
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
            const msg = JSON.parse(sentMessage(c)) as { method?: string };
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

    type ShellEvent = { type: 'message' | 'error' | 'close' | 'hung'; payload: string; sequence: number; generation: number };
    type RawWrite = [string, Uint8Array, { headers: Record<string, string> }];

    /** Simulate the Electron renderer (preload marker) and capture the dedicated sidecar channel. */
    function enterElectronShell(): { deliver: (payload: unknown) => void } {
      let handler: ((event: ShellEvent) => void) | undefined;
      let sequence = 0;
      (window as Window & { __ABU_SHELL__?: unknown }).__ABU_SHELL__ = {
        mainSupervisesSidecar: true,
        subscribeSidecarEvents: (h: (event: ShellEvent) => void) => {
          handler = h;
          return () => {};
        },
      };
      return {
        deliver: (payload) => handler?.({
          type: 'message', payload: JSON.stringify(payload), sequence: ++sequence, generation: 1,
        }),
      };
    }

    function rawWritesAfter(callsBefore: number): RawWrite[] {
      return invoke.mock.calls.slice(callsBefore).filter((c) => c[0] === 'mcp_write') as RawWrite[];
    }

    it('#549: Electron sends requests as raw UTF-8 bytes with routing headers', async () => {
      const shell = enterElectronShell();
      mockHappyPath(shell.deliver);
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;
      const pending = request('agent.start', {
        runId: 'run-7', clientMessageId: 'msg-7', payloadDigest: 'd7', userMessage: '中',
      }, 1000);
      const [call] = rawWritesAfter(callsBefore);
      expect(call[1]).toBeInstanceOf(Uint8Array);
      expect(call[2]).toEqual({ headers: expect.any(Object) });
      const line = JSON.parse(sentMessage(call)) as { id: number; method: string; params: { userMessage: string } };
      expect(line).toMatchObject({ method: 'agent.start', params: { userMessage: '中' } });
      expect(call[2].headers).toEqual({
        id: 'abu-sidecar',
        method: 'agent.start',
        rpcId: String(line.id),
        runId: 'run-7',
        clientMessageId: 'msg-7',
        payloadDigest: 'd7',
      });
      shell.deliver({ jsonrpc: '2.0', id: line.id, result: { accepted: true } });
      await expect(pending).resolves.toEqual({ accepted: true });
    });

    it('#549: request() encodes the JSON-RPC line once and sends that same buffer', async () => {
      mockHappyPath(enterElectronShell().deliver);
      await startSidecar();
      traceRuntimeEvent.mockClear();
      const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode');
      try {
        const callsBefore = invoke.mock.calls.length;
        void request('agent.run', { runId: 'run-e', note: '中文' }, 1000).catch(() => {});
        expect(encodeSpy).toHaveBeenCalledTimes(1);
        const sentBuffer = encodeSpy.mock.results[0].value as Uint8Array;
        expect(rawWritesAfter(callsBefore)[0][1]).toBe(sentBuffer);
        await vi.advanceTimersByTimeAsync(0);
        const event = traceRuntimeEvent.mock.calls.find((c) => c[0] === 'renderer.sidecar_rpc_sent')?.[1] as Record<string, unknown>;
        expect(event.payloadBytes).toBe(sentBuffer.byteLength);
      } finally {
        encodeSpy.mockRestore();
      }
      await vi.advanceTimersByTimeAsync(1000);
    });

    it('#549: an oversize request rejects with PayloadTooLargeError and records a numbers-only breakdown', async () => {
      mockHappyPath(enterElectronShell().deliver);
      await startSidecar();
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'mcp_write') {
          throw new Error('payload_too_large {"code":"payload_too_large","bytes":500,"limit":400,"method":"mcp_write"}');
        }
        return undefined;
      });
      const err = await request(
        'agent.start',
        { runId: 'r', conversationSnapshot: { messages: [{ role: 'user', content: 'secret words' }] } },
        1000,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PayloadTooLargeError);
      expect(err).toMatchObject({ name: 'PayloadTooLargeError', method: 'agent.start', bytes: 500, limit: 400 });
      const event = traceRuntimeEvent.mock.calls.find((c) => c[0] === 'renderer.sidecar_rpc_payload_too_large')?.[1] as Record<string, unknown>;
      expect(event).toMatchObject({
        method: 'agent.start',
        runId: 'r',
        payloadBytes: 500,
        limitBytes: 400,
        outcome: 'error',
        errorType: 'payload_too_large',
        fieldMessagesTextBytes: 12,
      });
      expect(JSON.stringify(event)).not.toContain('secret');
      expect(JSON.stringify(traceRuntimeEvent.mock.calls)).not.toContain('secret');
    });

    it('#549: an over-limit request is refused before it reaches the IPC boundary', async () => {
      // Driven through the plain form's smaller 8 MiB ceiling on purpose: the
      // 128 MiB raw-body ceiling is pinned in rawBodyInvoke.contract.test.ts
      // (which passes a pre-encoded buffer), and allocating a 128 MiB string
      // here peaked at ~384 MiB for the same assertion.
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;
      const huge = 'x'.repeat(IPC_MAX_ARGS_BYTES);
      const err = await request('llm.chat', { callId: 'c', text: huge }, 0).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'PayloadTooLargeError', method: 'llm.chat', limit: IPC_MAX_ARGS_BYTES });
      expect(invoke.mock.calls.slice(callsBefore).filter((c) => c[0] === 'mcp_write')).toHaveLength(0);
    });

    it('#549: notifications and responses to sidecar requests use the raw form too', async () => {
      const shell = enterElectronShell();
      mockHappyPath(shell.deliver);
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;

      notifySidecar('llm.abort', { callId: 'c1' });
      onSidecarRequest('tool.invoke', async () => ({ ok: true, text: '中'.repeat(4) }));
      shell.deliver({ jsonrpc: '2.0', id: 'sq-9', method: 'tool.invoke', params: {} });
      await vi.advanceTimersByTimeAsync(0);

      const [notify, response] = rawWritesAfter(callsBefore);
      expect(notify[1]).toBeInstanceOf(Uint8Array);
      expect(notify[2].headers).toEqual({ id: 'abu-sidecar', method: 'llm.abort' });
      expect(JSON.parse(sentMessage(notify))).toEqual({ jsonrpc: '2.0', method: 'llm.abort', params: { callId: 'c1' } });
      expect(response[1]).toBeInstanceOf(Uint8Array);
      expect(response[2].headers).toEqual({ id: 'abu-sidecar' });
      expect(JSON.parse(sentMessage(response))).toEqual({ jsonrpc: '2.0', id: 'sq-9', result: { ok: true, text: '中中中中' } });
    });

    it('#549: a 9 MiB tool result is sent as one raw-body response in Electron', async () => {
      const shell = enterElectronShell();
      mockHappyPath(shell.deliver);
      await startSidecar();
      const big = 'r'.repeat(9 * 1024 * 1024);
      onSidecarRequest('tool.invoke', vi.fn().mockResolvedValue({ ok: true, toolResult: big }));
      const callsBefore = invoke.mock.calls.length;

      shell.deliver({ jsonrpc: '2.0', id: 'sq-big', method: 'tool.invoke', params: {} });
      await vi.advanceTimersByTimeAsync(0);

      const last = rawWritesAfter(callsBefore).at(-1)!;
      expect(last[1]).toBeInstanceOf(Uint8Array);
      expect(last[1].byteLength).toBeGreaterThan(9 * 1024 * 1024);
      expect(JSON.parse(sentMessage(last))).toMatchObject({ id: 'sq-big', result: { ok: true } });
      expect(traceRuntimeEvent.mock.calls.some((c) => c[0] === 'renderer.sidecar_response_write_failed')).toBe(false);
    });
  });

  describe('#549 channel failures are not swallowed', () => {
    const tooLarge = () => new Error('payload_too_large {"code":"payload_too_large","bytes":9,"limit":8,"method":"mcp_write"}');

    /** Every JSON-RPC line written since `callsBefore`, decoded. */
    function writtenLines(callsBefore: number): Array<Record<string, unknown>> {
      return invoke.mock.calls
        .slice(callsBefore)
        .filter((c) => c[0] === 'mcp_write')
        .map((c) => JSON.parse(sentMessage(c)) as Record<string, unknown>);
    }

    it('answers the sidecar with a small -32000 error when the real response is too large', async () => {
      mockHappyPath();
      await startSidecar();
      onSidecarRequest('tool.invoke', vi.fn().mockResolvedValue('x'.repeat(10)));
      const callsBefore = invoke.mock.calls.length;
      invoke.mockImplementation(async (cmd: string, args: unknown) => {
        if (cmd === 'mcp_write' && sentMessage([cmd, args]).includes('"result"')) throw tooLarge();
        return undefined;
      });

      emitMsg({ jsonrpc: '2.0', id: 'sq-9', method: 'tool.invoke', params: {} });
      await vi.advanceTimersByTimeAsync(0);

      const writes = writtenLines(callsBefore);
      expect(writes.at(-1)).toMatchObject({
        id: 'sq-9',
        error: { code: -32000, data: { code: 'payload_too_large', bytes: 9, limit: 8, method: 'tool.invoke' } },
      });
      // The fallback carries numbers and the method name only — never the result.
      expect(JSON.stringify(writes.at(-1))).not.toContain('xxx');
      expect(traceRuntimeEvent).toHaveBeenCalledWith('renderer.sidecar_response_write_failed', expect.objectContaining({
        method: 'tool.invoke', errorType: 'payload_too_large', payloadBytes: 9, limitBytes: 8,
      }));
    });

    it('answers response_write_failed for any other send failure', async () => {
      mockHappyPath();
      await startSidecar();
      onSidecarRequest('tool.list', vi.fn().mockResolvedValue([]));
      let first = true;
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'mcp_write' && first) { first = false; throw new Error('pipe closed'); }
        return undefined;
      });
      const callsBefore = invoke.mock.calls.length;
      emitMsg({ jsonrpc: '2.0', id: 'sq-10', method: 'tool.list', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(writtenLines(callsBefore).at(-1)).toMatchObject({
        id: 'sq-10',
        error: { code: -32000, data: { code: 'response_write_failed', method: 'tool.list' } },
      });
      expect(traceRuntimeEvent).toHaveBeenCalledWith('renderer.sidecar_response_write_failed', expect.objectContaining({
        method: 'tool.list', rpcId: 'sq-10', outcome: 'error', errorType: 'error',
      }));
    });

    it('answers with a small error when the handler-thrown error is itself too large to deliver', async () => {
      mockHappyPath();
      await startSidecar();
      // A handler error whose own message is oversize — the -32000 the shell
      // would normally send is refused by the boundary. The sidecar must still
      // get an answer: on the unbounded tool.invoke, nothing means a hang.
      const hugeMessage = 'h'.repeat(64);
      onSidecarRequest('tool.invoke', vi.fn().mockRejectedValue(new Error(hugeMessage)));
      const callsBefore = invoke.mock.calls.length;
      invoke.mockImplementation(async (cmd: string, args: unknown) => {
        // Stands in for the 128 MiB boundary with an injected small limit:
        // any line still carrying the handler's message is refused.
        if (cmd === 'mcp_write' && sentMessage([cmd, args]).includes(hugeMessage)) throw tooLarge();
        return undefined;
      });

      emitMsg({ jsonrpc: '2.0', id: 'sq-12', method: 'tool.invoke', params: {} });
      await vi.advanceTimersByTimeAsync(0);

      const writes = writtenLines(callsBefore);
      expect(writes.at(-1)).toMatchObject({
        id: 'sq-12',
        error: { code: -32000, data: { code: 'payload_too_large', bytes: 9, limit: 8, method: 'tool.invoke' } },
      });
      expect(JSON.stringify(writes.at(-1))).not.toContain(hugeMessage);
    });

    it('answers with a small error when an oversize -32601 cannot be delivered', async () => {
      mockHappyPath();
      await startSidecar();
      const callsBefore = invoke.mock.calls.length;
      invoke.mockImplementation(async (cmd: string, args: unknown) => {
        if (cmd === 'mcp_write' && sentMessage([cmd, args]).includes('Method not found')) throw tooLarge();
        return undefined;
      });

      emitMsg({ jsonrpc: '2.0', id: 'sq-13', method: 'never.registered', params: {} });
      await vi.advanceTimersByTimeAsync(0);

      expect(writtenLines(callsBefore).at(-1)).toMatchObject({
        id: 'sq-13',
        error: { code: -32000, data: { code: 'payload_too_large', method: 'never.registered' } },
      });
    });

    it('does not loop when the fallback error cannot be written either', async () => {
      mockHappyPath();
      await startSidecar();
      onSidecarRequest('tool.list', vi.fn().mockResolvedValue([]));
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'mcp_write') throw new Error('pipe closed');
        return undefined;
      });
      const callsBefore = invoke.mock.calls.length;
      emitMsg({ jsonrpc: '2.0', id: 'sq-11', method: 'tool.list', params: {} });
      await vi.advanceTimersByTimeAsync(0);
      // The real response, then exactly one fallback attempt. No recursion.
      expect(invoke.mock.calls.slice(callsBefore).filter((c) => c[0] === 'mcp_write')).toHaveLength(2);
      // Both writes are recorded, and the second says the sidecar got nothing.
      const stages = traceRuntimeEvent.mock.calls
        .filter((c) => c[0] === 'renderer.sidecar_response_write_failed')
        .map((c) => (c[1] as { stage?: string }).stage);
      expect(stages).toEqual(['response', 'fallback']);
    });

    it('records notify failures and re-pushes registered state on the next send', async () => {
      mockHappyPath();
      await startSidecar();
      const resync = vi.fn();
      registerSidecarNotifyResync('state.settings', resync);
      invoke.mockImplementationOnce(async () => { throw new Error('pipe closed'); });
      notifySidecar('state.settings', { settings: {}, revision: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(traceRuntimeEvent).toHaveBeenCalledWith('renderer.sidecar_notify_failed', expect.objectContaining({
        method: 'state.settings', outcome: 'error', errorType: 'error',
      }));
      expect(resync).not.toHaveBeenCalled();

      void request('echo', {}, 1000).catch(() => {});
      expect(resync).toHaveBeenCalledTimes(1);
      void request('echo', {}, 1000).catch(() => {});
      expect(resync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
    });

    it('does not schedule a resync for an oversize notify (it could never succeed)', async () => {
      mockHappyPath();
      await startSidecar();
      const resync = vi.fn();
      registerSidecarNotifyResync('state.settings', resync);
      invoke.mockImplementationOnce(async () => { throw tooLarge(); });
      notifySidecar('state.settings', {});
      await vi.advanceTimersByTimeAsync(0);
      expect(traceRuntimeEvent).toHaveBeenCalledWith('renderer.sidecar_notify_failed', expect.objectContaining({
        method: 'state.settings', errorType: 'payload_too_large', payloadBytes: 9, limitBytes: 8,
      }));
      notifySidecar('llm.abort', {});
      expect(resync).not.toHaveBeenCalled();
    });

    it('unregistering a resync stops it from running, and a throwing resync is contained', async () => {
      mockHappyPath();
      await startSidecar();
      const resync = vi.fn(() => { throw new Error('resync exploded'); });
      const unregister = registerSidecarNotifyResync('state.settings', resync);
      invoke.mockImplementationOnce(async () => { throw new Error('pipe closed'); });
      notifySidecar('state.settings', {});
      await vi.advanceTimersByTimeAsync(0);
      expect(() => notifySidecar('llm.abort', {})).not.toThrow();
      expect(resync).toHaveBeenCalledTimes(1);

      unregister();
      invoke.mockImplementationOnce(async () => { throw new Error('pipe closed'); });
      notifySidecar('state.settings', {});
      await vi.advanceTimersByTimeAsync(0);
      notifySidecar('llm.abort', {});
      expect(resync).toHaveBeenCalledTimes(1);
    });
  });

  describe('#549 tracer failures never strand a request', () => {
    it('a throwing tracer on the send-failure path still rejects an untimed llm.chat and clears it', async () => {
      mockHappyPath();
      await startSidecar();
      traceRuntimeEvent.mockImplementation((name: string) => {
        if (name === 'renderer.sidecar_rpc_sent') throw new Error('tracer exploded');
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'mcp_write') throw new Error('no live process');
        return undefined;
      });
      const pending = request('llm.chat', { callId: 'c-untimed' }, 0);
      await expect(pending).rejects.toThrow('no live process');
      // A late response for the (already rejected) id is ignored.
      expect(() => emitMsg({ jsonrpc: '2.0', id: 999, result: {} })).not.toThrow();
    });

    it('a throwing tracer on the success path neither rejects nor leaks an unhandled rejection', async () => {
      mockHappyPath();
      await startSidecar();
      traceRuntimeEvent.mockImplementation((name: string) => {
        if (name === 'renderer.sidecar_rpc_sent') throw new Error('tracer exploded');
      });
      const callsBefore = invoke.mock.calls.length;
      const pending = request('llm.chat', { callId: 'c-ok' }, 0);
      await vi.advanceTimersByTimeAsync(0);
      const writeCall = invoke.mock.calls.slice(callsBefore).find((c) => c[0] === 'mcp_write');
      const sent = JSON.parse(sentMessage(writeCall)) as { id: number };
      emitMsg({ jsonrpc: '2.0', id: sent.id, result: { done: true } });
      await expect(pending).resolves.toEqual({ done: true });
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
      // #549: a waiter must see the give-up immediately, not hang for 60s.
      await expect(waitForSidecarStatus(1)).resolves.toBe('failed');
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(
        traceRuntimeEvent.mock.calls.filter((call) => call[0] === 'renderer.sidecar_crash_loop'),
      ).toHaveLength(1);
    });
  });
  describe('#549 status waiters', () => {
    it('resolves running once a starting sidecar finishes spawning', async () => {
      mockHappyPath();
      let releaseSpawn!: () => void;
      invoke.mockImplementation(answeringHandshake((cmd: string) => cmd === 'mcp_spawn'
        ? new Promise<void>((resolve) => { releaseSpawn = resolve; })
        : Promise.resolve(undefined)));
      const start = startSidecar();
      await vi.advanceTimersByTimeAsync(0);
      expect(getSidecarStatus()).toBe('starting');
      const waited = waitForSidecarStatus(60_000);
      releaseSpawn();
      await expect(waited).resolves.toBe('running');
      await start;
      expect(getSidecarStatus()).toBe('running');
    });

    it('times out, reports failed on crash-loop give-up, and honours abort', async () => {
      mockHappyPath();
      invoke.mockImplementation((cmd: string) => cmd === 'mcp_spawn' ? new Promise(() => {}) : Promise.resolve(undefined));
      void startSidecar();
      await vi.advanceTimersByTimeAsync(0);
      const timedOut = waitForSidecarStatus(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(timedOut).resolves.toBe('timeout');

      const controller = new AbortController();
      const aborted = waitForSidecarStatus(60_000, controller.signal);
      controller.abort();
      await expect(aborted).resolves.toBe('aborted');
      await stopSidecar();
      await expect(waitForSidecarStatus(1)).resolves.toBe('failed');
    });

    it('wakes every pending waiter on one transition', async () => {
      mockHappyPath();
      invoke.mockImplementation((cmd: string) => cmd === 'mcp_spawn' ? new Promise(() => {}) : Promise.resolve(undefined));
      void startSidecar();
      await vi.advanceTimersByTimeAsync(0);
      const first = waitForSidecarStatus(60_000);
      const second = waitForSidecarStatus(60_000);
      await stopSidecar();
      await expect(first).resolves.toBe('failed');
      await expect(second).resolves.toBe('failed');
    });
  });

  describe('handshake (#549 P2a)', () => {
    /** Spawn succeeds and every write is accepted, but nobody answers. */
    function mockSilentSidecar(): void {
      resolveResource.mockResolvedValue('/resources/sidecar/index.mjs');
      invoke.mockResolvedValue(undefined);
      listen.mockImplementation((eventName: string, cb: EventCallback) => {
        listenCallbacks.set(eventName, cb);
        return Promise.resolve(() => {});
      });
    }

    function handshakeWrites(): { id: number; params: unknown }[] {
      return invoke.mock.calls
        .filter((call) => call[0] === 'mcp_write')
        .map((call) => JSON.parse(sentMessage(call)) as { id: number; method?: string; params: unknown })
        .filter((message) => message.method === 'handshake');
    }

    type ShellEvent = {
      type: 'message' | 'error' | 'close' | 'hung';
      payload: string;
      sequence: number;
      generation: number;
    };

    function restartEvents(): unknown[] {
      return traceRuntimeEvent.mock.calls
        .filter((call) => call[0] === 'renderer.sidecar_restart_scheduled')
        .map((call) => call[1]);
    }

    function restartReasons(): unknown[] {
      return restartEvents().map((event) => (event as { reason?: string }).reason);
    }

    /**
     * Let the spawn chain run up to the handshake write without moving the
     * clock — the handshake's own 30 s budget is what several of these tests
     * measure, so nothing here may spend part of it.
     */
    async function untilHandshakeSent(): Promise<void> {
      await vi.advanceTimersByTimeAsync(0);
      expect(handshakeWrites()).toHaveLength(1);
    }

    it('reports running only after the sidecar answered, and remembers its capabilities', async () => {
      mockSilentSidecar();
      const starting = startSidecar();
      await untilHandshakeSent();
      expect(getSidecarStatus()).toBe('starting');
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(false);
      expect(handshakeWrites()[0].params).toEqual({ protocolVersion: 2, shellVersion: APP_VERSION });

      emitMsg({ jsonrpc: '2.0', id: handshakeWrites()[0].id, result: HANDSHAKE_OK });
      await starting;

      expect(getSidecarStatus()).toBe('running');
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(true);
      expect(sidecarHasCapability('something.else')).toBe(false);
    });

    it('a sidecar that announces no capability is running, and the capability reads false', async () => {
      // What a sidecar started with ABU_AGENT_START_PROTOCOL=1 answers.
      mockSilentSidecar();
      invoke.mockImplementation(answeringHandshake(undefined, { ...HANDSHAKE_OK, capabilities: [] }));
      await startSidecar();
      expect(getSidecarStatus()).toBe('running');
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(false);
    });

    it.each([
      ['a sidecar without the method', { error: { code: -32601, message: 'Method not found' } }, 'handshake-unsupported'],
      ['another protocol version', { result: { ...HANDSHAKE_OK, protocolVersion: 3 } }, 'handshake-incompatible'],
      ['a malformed answer', { result: { protocolVersion: 2, sidecarVersion: 'v', capabilities: 'all' } }, 'handshake-malformed'],
    ])('%s is a spawn failure handled by the restart policy', async (_name, answer, reason) => {
      mockSilentSidecar();
      const starting = startSidecar();
      await untilHandshakeSent();
      const killsBefore = killCallCount();

      emitMsg({ jsonrpc: '2.0', id: handshakeWrites()[0].id, ...answer });
      await starting;

      expect(getSidecarStatus()).toBe('restarting');
      expect(restartReasons()).toEqual([reason]);
      expect(killCallCount()).toBe(killsBefore + 1);
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(false);
    });

    it('an unanswered handshake times out after 30 s and is a spawn failure', async () => {
      mockSilentSidecar();
      const starting = startSidecar();
      await untilHandshakeSent();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(getSidecarStatus()).toBe('starting');
      await vi.advanceTimersByTimeAsync(1);
      await starting;
      expect(getSidecarStatus()).toBe('restarting');
      expect(restartReasons()).toEqual(['handshake-failed']);
    });

    it('a sidecar that keeps timing out ends failed, though its failures are further apart than the crash-loop window', async () => {
      mockSilentSidecar();
      const starting = startSidecar();
      await untilHandshakeSent();

      // One 30 s budget plus the 500 ms backoff per attempt: only two of these
      // ever sit inside the 60 s window, so the window alone would restart for
      // ever.
      for (let attempt = 0; attempt < 4; attempt++) await vi.advanceTimersByTimeAsync(30_500);
      await starting;

      expect(getSidecarStatus()).toBe('failed');
      expect(spawnCallCount()).toBe(4);
      expect(restartReasons()).toEqual(['handshake-failed', 'handshake-failed', 'handshake-failed']);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        'sidecar_crash',
        'handshake-failed',
        undefined,
        undefined,
        'Sidecar crash-looped: 4 starts in a row whose handshake failed',
      );
    });

    it('a process that closes during the handshake counts as one failure, not two', async () => {
      mockSilentSidecar();
      const starting = startSidecar();
      await untilHandshakeSent();

      emitClose();
      await starting;

      expect(getSidecarStatus()).toBe('restarting');
      expect(restartEvents()).toEqual([{
        sidecarId: 'abu-sidecar',
        reason: 'handshake-failed',
        attemptCount: 1,
        stage: 'restarting',
        outcome: 'error',
      }]);
    });

    it('a handshake line that cannot be written is a spawn failure', async () => {
      mockSilentSidecar();
      invoke.mockImplementation((cmd: string) => cmd === 'mcp_write'
        ? Promise.reject(new Error('pipe closed'))
        : Promise.resolve(undefined));

      await startSidecar();

      expect(getSidecarStatus()).toBe('restarting');
      expect(restartEvents()).toEqual([{
        sidecarId: 'abu-sidecar',
        reason: 'handshake-failed',
        attemptCount: 1,
        stage: 'restarting',
        outcome: 'error',
      }]);
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(false);
    });

    it('a close that arrives in the same batch as the answer keeps the sidecar out of running', async () => {
      let dedicatedHandler: ((event: ShellEvent) => void) | undefined;
      const getSidecarBridgeSnapshot = vi.fn();
      (window as Window & { __ABU_SHELL__?: unknown }).__ABU_SHELL__ = {
        mainSupervisesSidecar: true,
        subscribeSidecarEvents: (handler: (event: ShellEvent) => void) => {
          dedicatedHandler = handler;
          return () => {};
        },
        getSidecarBridgeSnapshot,
      };
      mockSilentSidecar();
      const starting = startSidecar();
      await untilHandshakeSent();

      // A first event sets the cursor; the next one leaves a gap, so main's
      // replay hands both the answer and the close to one synchronous loop.
      dedicatedHandler?.({ type: 'error', payload: '[sidecar:test] [info] boot', sequence: 1, generation: 1 });
      await vi.advanceTimersByTimeAsync(0);
      getSidecarBridgeSnapshot.mockResolvedValue({
        version: 1,
        sidecarId: 'abu-sidecar',
        generation: 1,
        bridgeStatus: 'running',
        firstAvailableSequence: 2,
        lastSequence: 4,
        truncated: false,
        events: [
          {
            type: 'message',
            payload: JSON.stringify({ jsonrpc: '2.0', id: handshakeWrites()[0].id, result: HANDSHAKE_OK }),
            sequence: 2,
            generation: 1,
          },
          { type: 'close', payload: '', sequence: 3, generation: 1 },
        ],
        runs: [],
      });
      dedicatedHandler?.({ type: 'error', payload: '[sidecar:test] [info] live', sequence: 4, generation: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await starting;

      expect(getSidecarStatus()).toBe('restarting');
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(false);
      expect(restartReasons()).toEqual(['handshake-failed']);
    });

    it('a throwing tracer never holds a healthy sidecar short of running', async () => {
      mockHappyPath();
      traceRuntimeEvent.mockImplementation((name: string) => {
        if (name === 'renderer.sidecar_handshake_completed') throw new Error('tracer exploded');
      });

      await startSidecar();

      expect(getSidecarStatus()).toBe('running');
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(true);
    });

    it('a sidecar that never completes a handshake ends failed through the crash-loop policy', async () => {
      mockSilentSidecar();
      invoke.mockImplementation(answeringHandshake(undefined, { ...HANDSHAKE_OK, protocolVersion: 3 }));
      await startSidecar();
      // Three restarts are allowed inside the window; the fourth failure gives up.
      for (let attempt = 0; attempt < 3; attempt++) await vi.advanceTimersByTimeAsync(500);
      expect(getSidecarStatus()).toBe('failed');
      expect(spawnCallCount()).toBe(4);
    });

    it('forgets the capabilities when the process closes', async () => {
      mockHappyPath();
      await startSidecar();
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(true);
      emitClose();
      expect(sidecarHasCapability('agent.start.history-from-ledger')).toBe(false);
    });

    it('a stop during the handshake ends stopped, never running', async () => {
      mockSilentSidecar();
      const starting = startSidecar();
      await untilHandshakeSent();
      await stopSidecar();
      await starting;
      expect(getSidecarStatus()).toBe('stopped');
    });
  });
});
