/**
 * Task B2: `sendToExtension`'s abort handling — stop waiting for the
 * extension's response and tell it to stop working via a
 * `{type:'cancel', requestId}` message, without leaking the timeout timer or
 * the abort listener.
 *
 * No real sockets: per this repo's determinism rule (no real network in
 * tests), both `ws` and `node:http` are mocked with in-memory EventEmitters
 * standing in for the WebSocketServer and the discovery HTTP server. This
 * still drives the real `wsServer.ts` connection-handling code (the
 * `wss.on('connection', ...)` closure that sets the module's private
 * `extensionSocket`), just without opening an OS socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above this file's imports, so they can't
// close over an `import { EventEmitter } from 'node:events'` declared below
// them (that produced a "Cannot access before initialization" TDZ error).
// `vi.hoisted()` runs before the mocks too, so a tiny inline emitter defined
// there is safe to use from both the mock factories and the test bodies.
const { MiniEmitter, capturedWsServers, capturedHttpServers } = vi.hoisted(() => {
  class MiniEmitterImpl {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    on(event: string, fn: (...args: unknown[]) => void): this {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }
  }
  return {
    MiniEmitter: MiniEmitterImpl,
    capturedWsServers: [] as InstanceType<typeof MiniEmitterImpl>[],
    capturedHttpServers: [] as InstanceType<typeof MiniEmitterImpl>[],
  };
});

vi.mock('ws', () => {
  class FakeWebSocketServer extends MiniEmitter {
    constructor(_opts: unknown) {
      super();
      capturedWsServers.push(this);
      // Defer so the constructor's caller can attach .on('listening') etc.
      // first — emitting synchronously here would fire before any listener
      // is registered.
      queueMicrotask(() => this.emit('listening'));
    }
    close(): void {}
  }
  class FakeWebSocket {
    static readonly OPEN = 1;
  }
  return { WebSocketServer: FakeWebSocketServer, WebSocket: FakeWebSocket };
});

vi.mock('http', () => {
  class FakeHttpServer extends MiniEmitter {
    listen(_port: number, _host: string, cb?: () => void): this {
      cb?.();
      return this;
    }
    close(): void {}
  }
  return {
    createServer: (_handler: unknown) => {
      const server = new FakeHttpServer();
      capturedHttpServers.push(server);
      return server;
    },
  };
});

/** A fake extension WebSocket: an emitter with the methods wsServer.ts calls on it. */
function makeFakeSocket() {
  const socket = new MiniEmitter() as InstanceType<typeof MiniEmitter> & {
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
  };
  socket.readyState = 1; // WebSocket.OPEN
  socket.send = vi.fn();
  socket.close = vi.fn();
  socket.terminate = vi.fn();
  socket.ping = vi.fn();
  return socket;
}

describe('sendToExtension abort handling', () => {
  let fakeExtension: ReturnType<typeof makeFakeSocket>;

  beforeEach(async () => {
    capturedWsServers.length = 0;
    capturedHttpServers.length = 0;
    vi.resetModules();

    const { startWSServer } = await import('./wsServer.js');
    await startWSServer(9876);

    const wss = capturedWsServers[0];
    fakeExtension = makeFakeSocket();
    wss.emit('connection', fakeExtension, { headers: { origin: 'chrome-extension://fake' } });
  });

  afterEach(async () => {
    const { stopWSServer } = await import('./wsServer.js');
    stopWSServer();
  });

  it('sends the request once, with no cancel message, when nothing aborts', async () => {
    const { sendToExtension } = await import('./wsServer.js');
    const controller = new AbortController();

    const pending = sendToExtension('click', { tabId: 1 }, 5000, controller.signal);
    expect(fakeExtension.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fakeExtension.send.mock.calls[0][0] as string);
    expect(sent).toMatchObject({ action: 'click', payload: { tabId: 1 } });

    // Extension answers normally.
    fakeExtension.emit('message', JSON.stringify({ id: sent.id, success: true, data: 'ok' }));
    await expect(pending).resolves.toMatchObject({ success: true, data: 'ok' });

    // Aborting after the fact must be a no-op: the abort listener was
    // detached on resolve, so this must not send a stray cancel message.
    controller.abort();
    expect(fakeExtension.send).toHaveBeenCalledTimes(1);
  });

  it('stops waiting and sends {type:"cancel", requestId} when the signal aborts mid-flight', async () => {
    const { sendToExtension } = await import('./wsServer.js');
    const controller = new AbortController();

    const pending = sendToExtension('click', { tabId: 1 }, 30_000, controller.signal);
    expect(fakeExtension.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fakeExtension.send.mock.calls[0][0] as string);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakeExtension.send).toHaveBeenCalledTimes(2);
    const cancelMsg = JSON.parse(fakeExtension.send.mock.calls[1][0] as string);
    expect(cancelMsg).toEqual({ type: 'cancel', requestId: sent.id });
  });

  it('does not crash if the extension later answers a request that was already cancelled', async () => {
    const { sendToExtension } = await import('./wsServer.js');
    const controller = new AbortController();

    const pending = sendToExtension('click', { tabId: 1 }, 30_000, controller.signal);
    const sent = JSON.parse(fakeExtension.send.mock.calls[0][0] as string);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // A late response for the now-forgotten request id must be tolerated
    // (logged, not thrown) rather than resolving/rejecting anything.
    expect(() => {
      fakeExtension.emit('message', JSON.stringify({ id: sent.id, success: true, data: 'late' }));
    }).not.toThrow();
  });

  /**
   * An abort is NOT proof the run stopped: the MCP SDK cancels a request when
   * its own timeout fires, and that cancellation reaches this bridge as the
   * same handler abort. Releasing here would hand a still-running task's tab to
   * another conversation — silently, and only on the slow calls. So the abort
   * path cancels the request and releases nothing, whatever the abort meant.
   */
  it.each([
    ['the user stopped the run', { tabId: 1, ownerId: 'conversation-a', runId: 'sar-1' }, new Error('run stopped')],
    ['the request carried no runId', { tabId: 1, ownerId: 'conversation-a' }, new Error('run stopped')],
    ['the caller named no owner at all', { tabId: 1 }, new Error('run stopped')],
    [
      'the MCP request timed out while the run kept going',
      { tabId: 1, ownerId: 'conversation-a', runId: 'sar-1' },
      new Error('MCP error -32001: Request timed out'),
    ],
  ])('cancels but never releases tab claims when %s', async (_case, payload, reason) => {
    const { sendToExtension } = await import('./wsServer.js');
    const controller = new AbortController();

    const pending = sendToExtension('click', payload, 30_000, controller.signal);
    const sent = JSON.parse(fakeExtension.send.mock.calls[0][0] as string);

    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // Exactly two messages: the request, then the cancel. No release.
    expect(fakeExtension.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fakeExtension.send.mock.calls[1][0] as string))
      .toEqual({ type: 'cancel', requestId: sent.id });
  });

  it('rejects immediately without sending anything when the signal is already aborted', async () => {
    const { sendToExtension } = await import('./wsServer.js');
    const controller = new AbortController();
    controller.abort();

    await expect(
      sendToExtension('click', { tabId: 1 }, 5000, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakeExtension.send).not.toHaveBeenCalled();
  });
});

/**
 * The release seam itself. Nothing calls it yet — a run ending reaches this
 * bridge through no signal it can trust (see the abort note in `wsServer.ts`)
 * — so these pin the wire shape and, above all, the SCOPE rule the future
 * caller has to honour: a run's settlement releases that run, never the whole
 * conversation.
 */
describe('releaseExtensionTabs', () => {
  let fakeExtension: ReturnType<typeof makeFakeSocket>;

  beforeEach(async () => {
    capturedWsServers.length = 0;
    capturedHttpServers.length = 0;
    vi.resetModules();

    const { startWSServer } = await import('./wsServer.js');
    await startWSServer(9876);

    const wss = capturedWsServers[0];
    fakeExtension = makeFakeSocket();
    wss.emit('connection', fakeExtension, { headers: { origin: 'chrome-extension://fake' } });
  });

  afterEach(async () => {
    const { stopWSServer } = await import('./wsServer.js');
    stopWSServer();
  });

  it('releases one run when given its run key', async () => {
    const { releaseExtensionTabs } = await import('./wsServer.js');

    releaseExtensionTabs('conversation-a', 'sar-1');

    expect(JSON.parse(fakeExtension.send.mock.calls[0][0] as string))
      .toEqual({ type: 'release', ownerId: 'conversation-a', runId: 'sar-1' });
  });

  it('releases every run of the conversation when no run key is given', async () => {
    const { releaseExtensionTabs } = await import('./wsServer.js');

    releaseExtensionTabs('conversation-a');

    // The conversation-wide scope, reserved for a conversation-level dispose —
    // the same scope `browser_dispose_owner {conversationId}` has in the host.
    // A run-settlement caller must pass `runId ?? 'main'` instead.
    expect(JSON.parse(fakeExtension.send.mock.calls[0][0] as string))
      .toEqual({ type: 'release', ownerId: 'conversation-a' });
  });

  it('says nothing when there is no owner to release', async () => {
    const { releaseExtensionTabs } = await import('./wsServer.js');

    releaseExtensionTabs(undefined, 'sar-1');
    releaseExtensionTabs('', 'sar-1');
    releaseExtensionTabs(42, 'sar-1');

    // A legacy caller claims nothing, so there is nothing to release — and a
    // release with no owner would be unbounded.
    expect(fakeExtension.send).not.toHaveBeenCalled();
  });
});
