// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/ext-apps/app-bridge';
import { createAppBridgeSession, type AppBridgeSession } from './appBridgeSession';
import { buildHostContext } from './appHost';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * A stand-in for `iframe.contentWindow`: the host posts into `sent`, and
 * `fromApp` pushes messages back the way a real view would — a `message` event
 * on the host window whose `source` is this object (which is exactly what
 * `PostMessageTransport` filters on).
 */
class FakeFrameWindow {
  readonly sent: JsonRpcMessage[] = [];
  postMessage(message: JsonRpcMessage) {
    this.sent.push(message);
  }
  fromApp(message: JsonRpcMessage) {
    const event = new MessageEvent('message', { data: message });
    Object.defineProperty(event, 'source', { value: this });
    window.dispatchEvent(event);
  }
  methods(): string[] {
    return this.sent.filter((m) => m.method !== undefined).map((m) => m.method as string);
  }
  responseTo(id: number): JsonRpcMessage | undefined {
    return this.sent.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
  }
  /** Answer whatever request the host most recently sent (used for teardown). */
  ackLastRequest() {
    const request = [...this.sent].reverse().find((m) => m.id !== undefined && m.method !== undefined);
    if (request) this.fromApp({ jsonrpc: '2.0', id: request.id, result: {} });
  }
}

const HOST_CONTEXT = buildHostContext({
  isDark: false,
  locale: 'en-US',
  timeZone: 'UTC',
  appVersion: '9.9.9',
});

/** Let the SDK's promise chains (connect, request/response) settle. */
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function initialize(frame: FakeFrameWindow, id = 1) {
  frame.fromApp({
    jsonrpc: '2.0',
    id,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'test-app', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  });
  await flush();
}

describe('createAppBridgeSession', () => {
  let frame: FakeFrameWindow;
  let session: AppBridgeSession;

  beforeEach(async () => {
    frame = new FakeFrameWindow();
    session = createAppBridgeSession({
      frameWindow: frame as unknown as Window,
      hostContext: HOST_CONTEXT,
      appVersion: '9.9.9',
    });
    await flush();
  });

  afterEach(async () => {
    await session.teardown();
  });

  describe('handshake', () => {
    it('answers ui/initialize with the host info, capabilities and context', async () => {
      await initialize(frame);
      const response = frame.responseTo(1);
      expect(response?.error).toBeUndefined();
      const result = response?.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      expect(result.hostInfo).toMatchObject({ name: 'Abu', version: '9.9.9' });
      expect(result.hostContext).toMatchObject({ platform: 'desktop', displayMode: 'inline' });
    });

    it('advertises no server-tool or server-resource capability this batch', async () => {
      await initialize(frame);
      const caps = (frame.responseTo(1)?.result as { hostCapabilities?: Record<string, unknown> })
        ?.hostCapabilities ?? {};
      expect(caps.serverTools).toBeUndefined();
      expect(caps.serverResources).toBeUndefined();
      expect(caps.openLinks).toBeUndefined();
    });

    it('holds tool notifications until the app reports it is initialized', async () => {
      await initialize(frame);
      expect(session.isInitialized()).toBe(false);

      const pending = session.sendToolInput({ city: 'Beijing' });
      await flush();
      expect(frame.methods()).not.toContain('ui/notifications/tool-input');

      frame.fromApp({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      await flush();
      await pending;
      expect(session.isInitialized()).toBe(true);
      expect(frame.methods()).toContain('ui/notifications/tool-input');
    });
  });

  describe('tool lifecycle', () => {
    beforeEach(async () => {
      await initialize(frame);
      frame.fromApp({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      await flush();
    });

    it('pushes input, then result, in that order', async () => {
      await session.sendToolInput({ city: 'Beijing' });
      await session.sendToolResult({ content: [{ type: 'text', text: '25C' }] });
      await flush();

      expect(frame.methods()).toEqual([
        'ui/notifications/tool-input',
        'ui/notifications/tool-result',
      ]);
      const input = frame.sent.find((m) => m.method === 'ui/notifications/tool-input');
      expect(input?.params).toEqual({ arguments: { city: 'Beijing' } });
      const result = frame.sent.find((m) => m.method === 'ui/notifications/tool-result');
      expect(result?.params).toEqual({ content: [{ type: 'text', text: '25C' }] });
    });

    it('pushes a cancellation with its reason', async () => {
      await session.sendToolCancelled('aborted by user');
      await flush();
      const cancelled = frame.sent.find((m) => m.method === 'ui/notifications/tool-cancelled');
      expect(cancelled?.params).toEqual({ reason: 'aborted by user' });
    });

    it('pushes host context changes', async () => {
      await session.sendHostContextChange({ theme: 'dark' });
      await flush();
      const changed = frame.sent.find((m) => m.method === 'ui/notifications/host-context-changed');
      expect(changed?.params).toMatchObject({ theme: 'dark' });
    });
  });

  describe('default-deny handlers', () => {
    beforeEach(async () => {
      await initialize(frame);
      frame.fromApp({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      await flush();
    });

    const denied: Array<[string, Record<string, unknown>]> = [
      ['tools/call', { name: 'x', arguments: {} }],
      ['resources/read', { uri: 'ui://x/y' }],
      ['resources/list', {}],
      ['ui/open-link', { url: 'https://example.com' }],
      ['ui/message', { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ['ui/update-model-context', { content: [{ type: 'text', text: 'ctx' }] }],
      ['ui/request-display-mode', { mode: 'fullscreen' }],
    ];

    it.each(denied)('rejects %s with a JSON-RPC error', async (method, params) => {
      frame.fromApp({ jsonrpc: '2.0', id: 50, method, params });
      await flush();
      const response = frame.responseTo(50);
      expect(response?.result).toBeUndefined();
      expect(response?.error).toBeDefined();
      expect(response?.error?.message).toContain('not supported yet');
    });

    it('still answers ping', async () => {
      frame.fromApp({ jsonrpc: '2.0', id: 60, method: 'ping', params: {} });
      await flush();
      const response = frame.responseTo(60);
      expect(response?.error).toBeUndefined();
      expect(response?.result).toBeDefined();
    });
  });

  describe('teardown', () => {
    it('sends ui/resource-teardown and removes the window listener', async () => {
      await initialize(frame);
      frame.fromApp({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      await flush();

      const teardown = session.teardown();
      await flush();
      frame.ackLastRequest();
      await teardown;

      expect(frame.methods()).toContain('ui/resource-teardown');

      const before = frame.sent.length;
      frame.fromApp({ jsonrpc: '2.0', id: 99, method: 'ping', params: {} });
      await flush();
      expect(frame.sent.length).toBe(before);
    });

    it('is idempotent and unblocks a send that never got an initialized', async () => {
      const pending = session.sendToolInput({ a: 1 });
      await session.teardown();
      await session.teardown();
      await pending;
      expect(frame.methods()).not.toContain('ui/notifications/tool-input');
    });
  });
});
