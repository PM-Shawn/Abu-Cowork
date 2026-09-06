// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useMCPStore } from '@/stores/mcpStore';
import { useChatStore } from '@/stores/chatStore';
import { mergeComposerAppend } from './ChatInput';
import type { McpAppResource } from '@/core/mcp/appResources';
import type { AppBridgeSession } from '@/core/mcp/appBridgeSession';
import {
  MAX_AUDIT_ROWS,
  MODEL_CONTEXT_PERSIST_INTERVAL_MS,
  type AppBridgeHandlers,
} from '@/core/mcp/appBridgeHandlers';
import McpAppBlock, { resetMcpAppSlots, toCallToolResult, type McpAppBlockProps } from './McpAppBlock';

const APP_HTML = '<html><head><title>App</title></head><body><h1>hi</h1></body></html>';

function appResource(over: Partial<McpAppResource> = {}): McpAppResource {
  return { mimeType: 'text/html;profile=mcp-app', text: APP_HTML, isMcpApp: true, ...over };
}

function makeSession() {
  const calls: string[] = [];
  const session: AppBridgeSession & { calls: string[] } = {
    calls,
    bridge: {} as AppBridgeSession['bridge'],
    isInitialized: () => true,
    whenInitialized: async () => true,
    sendToolInput: async (args) => { calls.push(`input:${JSON.stringify(args)}`); },
    sendToolResult: async (r) => { calls.push(`result:${JSON.stringify(r)}`); },
    sendToolCancelled: async () => { calls.push('cancelled'); },
    sendHostContextChange: async () => { calls.push('host-context'); },
    teardown: async () => { calls.push('teardown'); },
  };
  return session;
}

interface SessionSink {
  session?: ReturnType<typeof makeSession>;
  /** The REAL handlers the block wired — tests drive them like the app would. */
  handlers?: Partial<AppBridgeHandlers>;
  sessions?: ReturnType<typeof makeSession>[];
}

function renderBlock(
  over: Partial<McpAppBlockProps> = {},
  sessionSink: SessionSink = {},
  options: { strict?: boolean } = {},
) {
  const defaultDeps: McpAppBlockProps['deps'] = {
    readResource: async () => appResource(),
    isConnected: () => true,
    handshakeTimeoutMs: 0,
    isDark: () => false,
    createSession: (options) => {
      const s = makeSession();
      sessionSink.session = s;
      sessionSink.handlers = options.handlers;
      (sessionSink.sessions ??= []).push(s);
      return s;
    },
  };
  const props: McpAppBlockProps = {
    toolCallId: 'tc-1',
    server: 'weather',
    resourceUri: 'ui://weather/view.html',
    input: { city: 'Beijing' },
    result: '25C',
    conversationId: 'conv-1',
    ...over,
    deps: { ...defaultDeps, ...over.deps },
  };
  return render(<McpAppBlock {...props} />, options.strict ? { wrapper: StrictMode } : undefined);
}

/**
 * Count every write to an iframe's `srcdoc` DOM property.
 *
 * React sets the initial value as an attribute, so what this sees is exactly
 * the host's own re-navigations — one per bridge session is the property under
 * test. Returns a restore function; the descriptor is patched on the prototype
 * because the block owns its iframe and never hands the element out before the
 * effect that reassigns it has already run.
 */
function trackSrcdocWrites(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const proto = HTMLIFrameElement.prototype as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
  Object.defineProperty(proto, 'srcdoc', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return original?.get ? original.get.call(this) : this.getAttribute('srcdoc');
    },
    set(this: HTMLIFrameElement, value: string) {
      writes.push(String(value));
      if (original?.set) original.set.call(this, value);
      else this.setAttribute('srcdoc', String(value));
    },
  });
  return {
    writes,
    restore: () => {
      if (original) Object.defineProperty(proto, 'srcdoc', original);
      else delete proto['srcdoc'];
    },
  };
}

/** Let the resource promise + the effects it unblocks settle. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** Put one server into the MCP store with the given status. */
function setServerStatus(name: string, status: 'connected' | 'disconnected' | 'error') {
  useMCPStore.setState({
    servers: { [name]: { config: { name }, status, tools: [] } },
  });
}

describe('McpAppBlock', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetMcpAppSlots();
    useMCPStore.setState({ servers: {} });
  });
  afterEach(() => {
    cleanup();
    resetMcpAppSlots();
    useMCPStore.setState({ servers: {} });
    vi.restoreAllMocks();
  });

  describe('happy path', () => {
    it('shows a loading line, then mounts the sandboxed iframe', async () => {
      renderBlock();
      expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('界面加载中');

      await settle();

      const frame = screen.getByTestId('mcp-app-frame');
      expect(frame.tagName).toBe('IFRAME');
      expect(screen.queryByTestId('mcp-app-status')).toBeNull();
    });

    it('locks the iframe down: allow-scripts only, no allow, no referrer', async () => {
      renderBlock();
      await settle();
      const frame = screen.getByTestId('mcp-app-frame');

      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      for (const forbidden of [
        'allow-same-origin', 'allow-popups', 'allow-downloads', 'allow-forms', 'allow-top-navigation',
      ]) {
        expect(frame.getAttribute('sandbox')).not.toContain(forbidden);
      }
      expect(frame.getAttribute('allow')).toBe('');
      expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('injects the host CSP into the srcdoc ahead of the app content', async () => {
      renderBlock();
      await settle();
      const srcdoc = screen.getByTestId('mcp-app-frame').getAttribute('srcdoc') ?? '';

      expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
      expect(srcdoc).toContain("default-src 'none'");
      expect(srcdoc).toContain("frame-src 'none'");
      expect(srcdoc).toContain("form-action 'none'");
      expect(srcdoc).toContain("base-uri 'none'");
      expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<title>'));
    });

    it('pushes tool input and then the result to the bridge', async () => {
      const sink: { session?: ReturnType<typeof makeSession> } = {};
      renderBlock({}, sink);
      await settle();

      expect(sink.session?.calls[0]).toBe('input:{"city":"Beijing"}');
      expect(sink.session?.calls.some((c) => c.startsWith('result:'))).toBe(true);
      const result = sink.session?.calls.find((c) => c.startsWith('result:')) ?? '';
      expect(result).toContain('"text":"25C"');
    });

    it('sends input only while the step is still executing', async () => {
      const sink: { session?: ReturnType<typeof makeSession> } = {};
      renderBlock({ result: undefined, isExecuting: true }, sink);
      await settle();
      expect(sink.session?.calls).toEqual(['input:{"city":"Beijing"}']);
    });

    it('discloses ignored domain/permission requests', async () => {
      renderBlock({
        deps: {
          readResource: async () => appResource({ meta: { domain: 'https://apps.example.com', permissions: { camera: {} } } }),
        },
      });
      await settle();
      expect(screen.getByTestId('mcp-app-unsupported')).toBeInTheDocument();
    });

    it('names the origins the interface IS allowed to load assets from', async () => {
      renderBlock({
        deps: {
          readResource: async () => appResource({
            meta: {
              csp: {
                resourceDomains: ['https://cdn.a.example.com', 'https://cdn.b.example.com'],
                connectDomains: ['https://api.c.example.com', 'https://api.d.example.com'],
              },
            },
          }),
        },
      });
      await settle();

      const note = screen.getByTestId('mcp-app-unsupported');
      expect(note).toHaveTextContent('允许加载资源自');
      expect(note).toHaveTextContent('https://cdn.a.example.com');
      // Capped at three, so the fourth accepted origin is summarised, not spelled out.
      expect(note).toHaveTextContent('等');
      expect(note.textContent).not.toContain('api.d.example.com');
    });

    it('says nothing about allowed origins when the app declared none', async () => {
      renderBlock();
      await settle();
      expect(screen.queryByTestId('mcp-app-unsupported')).toBeNull();
    });

    it('names the domains the CSP builder threw away, capped at three', async () => {
      renderBlock({
        deps: {
          readResource: async () => appResource({
            meta: {
              csp: {
                connectDomains: [
                  '*',
                  'http://a.example.com',
                  'https://b.example.com;frame-src',
                  'https://c.example.com,https://evil.example.com',
                ],
              },
            },
          }),
        },
      });
      await settle();

      const note = screen.getByTestId('mcp-app-unsupported');
      expect(note).toHaveTextContent('已忽略无效域名');
      expect(note).toHaveTextContent('http://a.example.com');
      expect(note).toHaveTextContent('等');
      // Capped: the fourth rejected entry is not spelled out.
      expect(note.textContent).not.toContain('c.example.com');
      // Nothing was smuggled into the policy either.
      expect(screen.getByTestId('mcp-app-frame').getAttribute('srcdoc') ?? '')
        .not.toContain('evil.example.com');
    });

    it('tears the bridge down on unmount', async () => {
      const sink: { session?: ReturnType<typeof makeSession> } = {};
      const view = renderBlock({}, sink);
      await settle();
      view.unmount();
      expect(sink.session?.calls).toContain('teardown');
    });
  });

  describe('failure paths', () => {
    it('falls back to a muted line when the resource read fails', async () => {
      renderBlock({ deps: { readResource: async () => { throw new Error('boom'); } } });
      await settle();
      expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('界面加载失败');
      expect(screen.queryByTestId('mcp-app-frame')).toBeNull();
    });

    it('refuses to run a resource that is not an MCP App', async () => {
      renderBlock({ deps: { readResource: async () => appResource({ isMcpApp: false, mimeType: 'text/html' }) } });
      await settle();
      expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('界面加载失败');
    });

    it('names the server when the connector is offline', async () => {
      renderBlock({ deps: { isConnected: () => false } });
      await settle();
      expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('连接 weather 以显示界面');
      expect(screen.queryByTestId('mcp-app-frame')).toBeNull();
    });

    it('gives up when the handshake never completes', async () => {
      vi.useFakeTimers();
      try {
        const sink: { session?: ReturnType<typeof makeSession> } = {};
        renderBlock({
          deps: {
            handshakeTimeoutMs: 10_000,
            createSession: () => {
              const s = makeSession();
              s.isInitialized = () => false;
              sink.session = s;
              return s;
            },
          },
        }, sink);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(screen.getByTestId('mcp-app-frame')).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('界面加载失败');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('server disconnect', () => {
    it('tears the app down and offers to reconnect when the server drops', async () => {
      const sink: { session?: ReturnType<typeof makeSession> } = {};
      setServerStatus('weather', 'connected');
      renderBlock({}, sink);
      await settle();
      expect(screen.getByTestId('mcp-app-frame')).toBeInTheDocument();

      await act(async () => { setServerStatus('weather', 'disconnected'); });
      await settle();

      expect(sink.session?.calls).toContain('teardown');
      expect(screen.queryByTestId('mcp-app-frame')).toBeNull();
      expect(screen.getByTestId('mcp-app-status')).toHaveTextContent('连接 weather 以显示界面');
    });

    it('re-mounts with a fresh fetch when the server comes back', async () => {
      let reads = 0;
      setServerStatus('weather', 'connected');
      renderBlock({ deps: { readResource: async () => { reads += 1; return appResource(); } } });
      await settle();
      expect(reads).toBe(1);

      await act(async () => { setServerStatus('weather', 'disconnected'); });
      await settle();
      expect(screen.queryByTestId('mcp-app-frame')).toBeNull();

      await act(async () => { setServerStatus('weather', 'connected'); });
      await settle();
      expect(screen.getByTestId('mcp-app-frame')).toBeInTheDocument();
      expect(reads).toBe(2);
    });
  });

  describe('concurrency cap', () => {
    it('collapses the oldest blocks past the cap into a click-to-load placeholder', async () => {
      const blocks = Array.from({ length: 7 }, (_, i) => i);
      const sessions = new Map<string, ReturnType<typeof makeSession>>();
      const view = render(
        <>
          {blocks.map((i) => (
            <McpAppBlock
              key={i}
              toolCallId={`tc-${i}`}
              server="weather"
              resourceUri="ui://weather/view.html"
              input={{}}
              result="ok"
              conversationId="conv-cap"
              deps={{
                readResource: async () => appResource(),
                isConnected: () => true,
                handshakeTimeoutMs: 0,
                isDark: () => false,
                createSession: () => {
                  const s = makeSession();
                  sessions.set(`tc-${i}`, s);
                  return s;
                },
              }}
            />
          ))}
        </>,
      );
      await settle();

      expect(screen.getAllByTestId('mcp-app-frame')).toHaveLength(6);
      const placeholders = screen.getAllByTestId('mcp-app-placeholder');
      expect(placeholders).toHaveLength(1);
      // The block evicted before it ever rendered never built a bridge.
      expect(sessions.has('tc-0')).toBe(false);
      expect(sessions.get('tc-1')?.calls).not.toContain('teardown');

      await act(async () => { fireEvent.click(placeholders[0]); });
      await settle();
      // Re-activating the evicted block pushes the next-oldest out instead.
      expect(screen.getAllByTestId('mcp-app-frame')).toHaveLength(6);
      expect(screen.getAllByTestId('mcp-app-placeholder')).toHaveLength(1);
      // …and eviction runs the same teardown as an unmount, so the evicted
      // block's bridge (and its window message listener) is gone.
      expect(sessions.get('tc-1')?.calls).toContain('teardown');
      expect(sessions.has('tc-0')).toBe(true);
      view.unmount();
    });
  });

  describe('toCallToolResult', () => {
    it('wraps a plain display result as a text block', () => {
      expect(toCallToolResult('done', undefined, undefined)).toEqual({
        content: [{ type: 'text', text: 'done' }],
      });
    });

    it('maps persisted content blocks and keeps the error flag', () => {
      expect(toCallToolResult('x', [
        { type: 'text', text: 'a' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ], true)).toEqual({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'AAA', mimeType: 'image/png' },
        ],
        isError: true,
      });
    });
  });
  // ── Task 3: interaction (spec §4.3) ───────────────────────────────────────

  describe('bridge lifecycle', () => {
    /**
     * 🔴 A rebuilt bridge over a still-running document is a dead bridge: the
     * app's `ui/initialize` retry loop stops after its first success, so the
     * new session would wait forever for a handshake and the interface goes
     * silently deaf. StrictMode's mount → unmount → mount is the cheapest
     * faithful reproduction (it is also what dev builds do on every mount).
     */
    it('re-navigates the frame once per bridge session', async () => {
      const tracker = trackSrcdocWrites();
      try {
        const sink: SessionSink = {};
        // StrictMode is the shape the real double-invoke arrives in. React runs
        // in its production build under vitest, so it may mount only once here;
        // the assertion is therefore "one host re-navigation per session", which
        // is the invariant either way (and was ZERO before this fix).
        const view = renderBlock({}, sink, { strict: true });
        await settle();
        expect(tracker.writes).toHaveLength(sink.sessions!.length);

        // A second session over the same block — a different interface resource
        // rebuilds the bridge — must get its own fresh document.
        const sessionsBefore = sink.sessions!.length;
        await act(async () => {
          view.rerender(
            <StrictMode>
              <McpAppBlock
                toolCallId="tc-1"
                server="weather"
                resourceUri="ui://weather/other.html"
                input={{ city: 'Beijing' }}
                result="25C"
                conversationId="conv-1"
                deps={{
                  readResource: async () => appResource(),
                  isConnected: () => true,
                  handshakeTimeoutMs: 0,
                  isDark: () => false,
                  createSession: () => {
                    const s = makeSession();
                    sink.session = s;
                    (sink.sessions ??= []).push(s);
                    return s;
                  },
                }}
              />
            </StrictMode>,
          );
        });
        await settle();

        expect(sink.sessions!.length).toBeGreaterThan(sessionsBefore);
        expect(tracker.writes).toHaveLength(sink.sessions!.length);
        for (const written of tracker.writes) expect(written).toContain('Content-Security-Policy');
      } finally {
        tracker.restore();
      }
    });

    it('re-navigates on a plain single mount too, so the first session also gets a fresh document', async () => {
      const tracker = trackSrcdocWrites();
      try {
        const sink: SessionSink = {};
        renderBlock({}, sink);
        await settle();
        expect(sink.sessions).toHaveLength(1);
        expect(tracker.writes).toHaveLength(1);
      } finally {
        tracker.restore();
      }
    });

    it('still buffers tool input/result behind the handshake after a re-navigation', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink, { strict: true });
      await settle();
      // The surviving session is the one that must carry the payload: it gets
      // both messages, and the session itself is what holds them until the app
      // reports `initialized` (appBridgeSession.test.ts pins that queueing).
      const last = sink.sessions![sink.sessions!.length - 1];
      expect(last.calls.some((c) => c.startsWith('input:'))).toBe(true);
      expect(last.calls.some((c) => c.startsWith('result:'))).toBe(true);
    });
  });

  describe('display mode', () => {
    it('goes fullscreen without rebuilding the iframe or the bridge', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();

      const frameBefore = screen.getByTestId('mcp-app-frame');
      const sessionBefore = sink.session;
      expect(screen.queryByTestId('mcp-app-fullscreen')).toBeNull();

      await act(async () => {
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
      });

      expect(screen.getByTestId('mcp-app-fullscreen')).toBeInTheDocument();
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'fullscreen');
      // Same DOM node, same session object: no remount, so the app keeps its state.
      expect(screen.getByTestId('mcp-app-frame')).toBe(frameBefore);
      expect(sink.session).toBe(sessionBefore);
      expect(sink.sessions).toHaveLength(1);
    });

    it('answers the app with the mode it actually got', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      let answer: unknown;
      await act(async () => {
        answer = await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
      });
      expect(answer).toEqual({ mode: 'fullscreen' });
    });

    it('pushes host-context-changed on the way in and on the way back', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      const before = sink.session!.calls.filter((c) => c === 'host-context').length;

      await act(async () => {
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
      });
      const afterEnter = sink.session!.calls.filter((c) => c === 'host-context').length;
      expect(afterEnter).toBeGreaterThan(before);

      await act(async () => { fireEvent.click(screen.getByTestId('mcp-app-fullscreen-exit')); });
      expect(sink.session!.calls.filter((c) => c === 'host-context').length).toBeGreaterThan(afterEnter);
    });

    it('returns to inline from the close button, keeping the same iframe', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      await act(async () => {
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
      });
      const frame = screen.getByTestId('mcp-app-frame');

      await act(async () => { fireEvent.click(screen.getByTestId('mcp-app-fullscreen-exit')); });

      expect(screen.queryByTestId('mcp-app-fullscreen')).toBeNull();
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
      expect(screen.getByTestId('mcp-app-frame')).toBe(frame);
      expect(sink.sessions).toHaveLength(1);
    });

    it('closes on a backdrop click — the backdrop is reachable, not buried', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      await act(async () => {
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
      });

      // The frame container covers the viewport in fullscreen; it must be
      // click-through so the backdrop under it can receive the click.
      expect(screen.getByTestId('mcp-app-block').className).toContain('pointer-events-none');

      await act(async () => { fireEvent.click(screen.getByTestId('mcp-app-fullscreen-backdrop')); });
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
      expect(screen.queryByTestId('mcp-app-fullscreen-backdrop')).toBeNull();
      expect(sink.sessions).toHaveLength(1);
    });

    it('refuses to be re-opened right after the user closed it', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      await act(async () => {
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
      });
      await act(async () => { fireEvent.click(screen.getByTestId('mcp-app-fullscreen-exit')); });

      // The hostage loop: the app asks again the moment the overlay closes.
      await expect(
        sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never),
      ).rejects.toThrow(/user gesture/);
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
      expect(screen.queryByTestId('mcp-app-fullscreen')).toBeNull();
    });

    it('honours a fullscreen request that follows a real gesture inside the block', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      // Burn the one-shot "the app just loaded" grace, then let the APP put
      // itself back inline — that is not a user refusal, so no cool-down.
      await act(async () => {
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'inline' } as never);
      });
      await expect(
        sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never),
      ).rejects.toThrow(/user gesture/);

      // A pointerdown on the block wrapper is the evidence the host CAN see —
      // a gesture inside the sandboxed iframe never crosses the boundary.
      await act(async () => { fireEvent.pointerDown(screen.getByTestId('mcp-app-block')); });
      await act(async () => {
        await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
      });
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'fullscreen');
    });

    it('refuses pip and stays inline', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      await expect(
        sink.handlers!.onrequestdisplaymode!({ mode: 'pip' } as never),
      ).rejects.toThrow(/not supported/);
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
    });
  });

  describe('app-initiated tool calls', () => {
    const searchTool = {
      name: 'weather__search',
      description: 'search',
      inputSchema: { type: 'object' as const, properties: { q: { type: 'string', description: 'q' } }, required: ['q'] },
      execute: async () => 'unused',
    };

    it('runs the shared gate, then executes, then leaves an audit row', async () => {
      const sink: SessionSink = {};
      const checkApproval = vi.fn(async () => ({ decision: 'allow' as const }));
      const callTool = vi.fn(async () => 'two results');
      renderBlock({ deps: { findTool: () => searchTool, checkApproval, callTool } }, sink);
      await settle();

      await act(async () => {
        await sink.handlers?.oncalltool?.({ name: 'search', arguments: { q: 'abu' } } as never);
      });

      expect(checkApproval).toHaveBeenCalledWith('weather__search', { q: 'abu' });
      expect(callTool).toHaveBeenCalledWith('weather', 'search', { q: 'abu' });
      const row = screen.getByTestId('mcp-app-audit-row');
      expect(row).toHaveTextContent('界面调用了 search');
      // Collapsed by default — the arguments only appear once expanded.
      expect(row).not.toHaveTextContent('abu');
      await act(async () => { fireEvent.click(row.querySelector('button')!); });
      expect(row).toHaveTextContent('abu');
      expect(row).toHaveTextContent('two results');
    });

    it('surfaces a denial as an audit row and never executes', async () => {
      const sink: SessionSink = {};
      const callTool = vi.fn(async () => 'never');
      renderBlock({
        deps: {
          findTool: () => searchTool,
          checkApproval: async () => ({ decision: 'deny' as const, reason: 'Error: 用户已取消' }),
          callTool,
        },
      }, sink);
      await settle();

      await expect(
        sink.handlers!.oncalltool!({ name: 'search', arguments: { q: 'abu' } } as never),
      ).rejects.toThrow('用户已取消');
      expect(callTool).not.toHaveBeenCalled();
      await act(async () => {});
      expect(screen.getByTestId('mcp-app-audit-row')).toBeInTheDocument();
    });

    it('shows one status line once the app burns its per-minute budget', async () => {
      const sink: SessionSink = {};
      renderBlock({
        deps: { findTool: () => searchTool, checkApproval: async () => ({ decision: 'allow' as const }), callTool: async () => 'ok' },
      }, sink);
      await settle();

      await act(async () => {
        for (let i = 0; i < 20; i++) {
          await sink.handlers?.oncalltool?.({ name: 'search', arguments: { q: `q${i}` } } as never);
        }
      });
      expect(screen.queryByTestId('mcp-app-rate-limited')).toBeNull();

      await expect(
        sink.handlers!.oncalltool!({ name: 'search', arguments: { q: 'over' } } as never),
      ).rejects.toThrow(/per minute/);
      await act(async () => {});
      expect(screen.getByTestId('mcp-app-rate-limited')).toBeInTheDocument();
    });

    it('prefers the raw server result over the converted one, and hands it over once', async () => {
      const sink: SessionSink = {};
      const raw = { content: [{ type: 'text', text: 'raw' }], structuredContent: { rows: 2 } };
      const takeRawAppResult = vi.fn().mockReturnValueOnce(raw).mockReturnValue(undefined);
      renderBlock({
        deps: {
          findTool: () => searchTool,
          checkApproval: async () => ({ decision: 'allow' as const }),
          callTool: async () => 'converted',
          takeRawAppResult,
        },
      }, sink);
      await settle();

      let first: unknown;
      let second: unknown;
      await act(async () => {
        first = await sink.handlers?.oncalltool?.({ name: 'search', arguments: { q: 'a' } } as never);
        second = await sink.handlers?.oncalltool?.({ name: 'search', arguments: { q: 'b' } } as never);
      });
      expect(first).toEqual(raw);
      expect(second).toEqual({ content: [{ type: 'text', text: 'converted' }] });
    });
  });

  describe('tool result replay', () => {
    it('replays the raw server result when the LRU still has it', async () => {
      const sink: SessionSink = {};
      const raw = { content: [{ type: 'text', text: '25C' }], structuredContent: { c: 25 } };
      renderBlock({
        toolName: 'weather__forecast',
        deps: { takeRawAppResult: () => raw },
      }, sink);
      await settle();
      expect(sink.session!.calls).toContain(`result:${JSON.stringify(raw)}`);
    });

    it('falls back to the converted content when the LRU is empty (after a reload)', async () => {
      const sink: SessionSink = {};
      renderBlock({
        toolName: 'weather__forecast',
        deps: { takeRawAppResult: () => undefined },
      }, sink);
      await settle();
      expect(sink.session!.calls).toContain(`result:${JSON.stringify(toCallToolResult('25C', undefined, undefined))}`);
    });
  });

  describe('ui/message', () => {
    it('appends to the composer draft and never sends', async () => {
      const sink: SessionSink = {};
      const appendComposerDraft = vi.fn();
      renderBlock({ deps: { appendComposerDraft } }, sink);
      await settle();

      await act(async () => {
        await sink.handlers?.onmessage?.({ role: 'user', content: [{ type: 'text', text: '订这一班' }] } as never);
      });
      expect(appendComposerDraft).toHaveBeenCalledWith('订这一班');
    });

    it('lands in the APPEND buffer of the real store, not the replace one', async () => {
      // `pendingInputAppend` is the buffer ChatInput drains with
      // `mergeComposerAppend` (newline-separated append, never a clobber);
      // `pendingInput` REPLACES the draft, which an app must never be able to
      // do. Nothing here starts a run — the send path is a user gesture on
      // ChatInput's own button, unreachable from the bridge.
      const sink: SessionSink = {};
      useChatStore.setState({ pendingInput: null, pendingInputAppend: null });
      renderBlock({}, sink);
      await settle();

      await act(async () => {
        await sink.handlers?.onmessage?.({ role: 'user', content: [{ type: 'text', text: '订这一班' }] } as never);
      });

      expect(useChatStore.getState().pendingInputAppend).toBe('订这一班');
      expect(useChatStore.getState().pendingInput).toBeNull();
      expect(mergeComposerAppend('我在写的草稿', '订这一班')).toBe('我在写的草稿\n订这一班');
    });
  });

  describe('ui/update-model-context', () => {
    it('shows the value immediately but persists it only after the throttle window', async () => {
      vi.useFakeTimers();
      try {
        const sink: SessionSink = {};
        const persistModelContext = vi.fn();
        renderBlock({ deps: { persistModelContext } }, sink);
        await settle();
        expect(screen.queryByTestId('mcp-app-context')).toBeNull();

        await act(async () => {
          await sink.handlers?.onupdatemodelcontext?.({ content: [{ type: 'text', text: '第一版' }] } as never);
          await sink.handlers?.onupdatemodelcontext?.({ content: [{ type: 'text', text: '用户选了第 4 行' }] } as never);
        });

        // Live expander is current; the write-through has not fired yet.
        expect(persistModelContext).not.toHaveBeenCalled();
        const expander = screen.getByTestId('mcp-app-context');
        expect(expander).not.toHaveTextContent('第 4 行');
        await act(async () => { fireEvent.click(expander.querySelector('button')!); });
        expect(expander).toHaveTextContent('用户选了第 4 行');

        await act(async () => { vi.advanceTimersByTime(MODEL_CONTEXT_PERSIST_INTERVAL_MS); });
        expect(persistModelContext).toHaveBeenCalledTimes(1);
        expect(persistModelContext).toHaveBeenCalledWith('用户选了第 4 行');
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders the persisted value on replay without any app traffic', async () => {
      renderBlock({ modelContext: '来自上一次会话' });
      await settle();
      const expander = screen.getByTestId('mcp-app-context');
      await act(async () => { fireEvent.click(expander.querySelector('button')!); });
      expect(expander).toHaveTextContent('来自上一次会话');
    });
  });

  describe('ui/open-link', () => {
    /**
     * Start the call and let the consent dialog mount, without settling it.
     * Wrapped in an object on purpose: returning the bare promise from an async
     * helper would make `await askToOpen(...)` wait for the call to finish,
     * which is exactly what this helper exists NOT to do.
     */
    async function askToOpen(sink: SessionSink, url: string): Promise<{ promise: Promise<unknown> }> {
      let promise!: Promise<unknown>;
      await act(async () => {
        promise = sink.handlers!.onopenlink!({ url } as never);
        await Promise.resolve();
      });
      // Swallow the rejection until the test awaits it, so a declined prompt
      // does not surface as an unhandled rejection.
      promise.catch(() => {});
      return { promise };
    }

    it('asks first and does NOT touch the widget link path before the user confirms', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const { promise } = await askToOpen(sink, 'https://example.com/a?b=1');
      // The whole point: nothing has been opened yet.
      expect(openLink).not.toHaveBeenCalled();
      expect(screen.getByTestId('mcp-app-open-link-url')).toHaveTextContent('https://example.com/a?b=1');

      await act(async () => {
        fireEvent.click(screen.getByText('打开'));
        await promise;
      });
      expect(openLink).toHaveBeenCalledWith('https://example.com/a?b=1');
      expect(screen.getByTestId('mcp-app-audit-row')).toBeInTheDocument();
    });

    it('answers -32000 "user declined" when the user cancels, and never opens', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const { promise } = await askToOpen(sink, 'https://example.com');
      await act(async () => { fireEvent.click(screen.getByText('取消')); });
      await expect(promise).rejects.toThrow('user declined');
      expect(openLink).not.toHaveBeenCalled();
      await act(async () => {});
      const row = screen.getByTestId('mcp-app-audit-row');
      await act(async () => { fireEvent.click(row.querySelector('button')!); });
      expect(row).toHaveTextContent('已拒绝打开');
    });

    it('keeps the full URL in a title attribute when it is too long to print', async () => {
      const sink: SessionSink = {};
      const url = `https://example.com/?q=${'x'.repeat(700)}`;
      renderBlock({}, sink);
      await settle();
      const { promise } = await askToOpen(sink, url);
      const shown = screen.getByTestId('mcp-app-open-link-url');
      expect(shown).toHaveAttribute('title', url);
      expect(shown.textContent!.length).toBeLessThan(url.length);
      await act(async () => { fireEvent.click(screen.getByText('取消')); });
      await expect(promise).rejects.toThrow();
    });

    it('refuses a file: url without ever prompting', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();
      await expect(sink.handlers!.onopenlink!({ url: 'file:///etc/passwd' } as never)).rejects.toThrow();
      expect(openLink).not.toHaveBeenCalled();
      expect(screen.queryByTestId('mcp-app-open-link-url')).toBeNull();
      await act(async () => {});
      const row = screen.getByTestId('mcp-app-audit-row');
      await act(async () => { fireEvent.click(row.querySelector('button')!); });
      expect(row).toHaveTextContent('已被拦截');
    });
  });

  describe('audit trail limits', () => {
    it('keeps only the newest rows once the cap is reached', async () => {
      const sink: SessionSink = {};
      const tool = {
        name: 'weather__ping',
        description: 'ping',
        inputSchema: { type: 'object' as const, properties: {} },
        execute: async () => 'unused',
      };
      renderBlock({
        deps: {
          findTool: () => tool,
          checkApproval: async () => ({ decision: 'allow' as const }),
          callTool: async () => 'ok',
        },
      }, sink);
      await settle();

      // The per-minute budget is smaller than the row cap, so the overflow rows
      // are rate-limit refusals — still attempts, still audited.
      await act(async () => {
        for (let i = 0; i < MAX_AUDIT_ROWS + 5; i++) {
          await sink.handlers!.oncalltool!({ name: 'ping', arguments: { i } } as never).catch(() => {});
        }
      });
      expect(screen.getAllByTestId('mcp-app-audit-row')).toHaveLength(MAX_AUDIT_ROWS);
    });

    it('caps the rendered arguments the way it caps the result summary', async () => {
      const sink: SessionSink = {};
      const tool = {
        name: 'weather__ping',
        description: 'ping',
        inputSchema: { type: 'object' as const, properties: { q: { type: 'string', description: 'q' } } },
        execute: async () => 'unused',
      };
      renderBlock({
        deps: {
          findTool: () => tool,
          checkApproval: async () => ({ decision: 'allow' as const }),
          callTool: async () => 'ok',
        },
      }, sink);
      await settle();
      await act(async () => {
        await sink.handlers!.oncalltool!({ name: 'ping', arguments: { q: 'z'.repeat(5000) } } as never);
      });
      const row = screen.getByTestId('mcp-app-audit-row');
      await act(async () => { fireEvent.click(row.querySelector('button')!); });
      const argsBlock = row.querySelectorAll('pre')[0];
      expect(argsBlock.textContent!.length).toBeLessThan(600);
      expect(argsBlock.textContent).toContain('…');
    });
  });
});
