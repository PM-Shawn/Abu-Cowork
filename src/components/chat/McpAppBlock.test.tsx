// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import CloseDialog from '@/components/common/CloseDialog';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Dialog } from '@/components/ds/dialog';
import { Menu, MenuItem } from '@/components/ds/menu';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextField } from '@/components/ds/text-field';
import { APPROVAL_TITLE, approvalProbe, windowBox } from '@/test/dsWindows';
import { initLanguage } from '@/i18n';
import { buildAppStyleVariables } from '@/core/mcp/appHost';
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
  // Every `host-context-changed` patch, kept whole: `calls` only records THAT
  // one was sent, and the theme/palette pairing is a property of its contents.
  const hostContextPatches: Partial<McpUiHostContext>[] = [];
  const session: AppBridgeSession & {
    calls: string[];
    hostContextPatches: Partial<McpUiHostContext>[];
  } = {
    calls,
    hostContextPatches,
    bridge: {} as AppBridgeSession['bridge'],
    isInitialized: () => true,
    whenInitialized: async () => true,
    sendToolInput: async (args) => { calls.push(`input:${JSON.stringify(args)}`); },
    sendToolResult: async (r) => { calls.push(`result:${JSON.stringify(r)}`); },
    sendToolCancelled: async () => { calls.push('cancelled'); },
    sendHostContextChange: async (patch) => {
      calls.push('host-context');
      hostContextPatches.push(patch);
    },
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
  // `beside` is drawn next to the block, inside the same providers (another window, an approval).
  options: { strict?: boolean; beside?: ReactNode } = {},
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
  return render(<><McpAppBlock {...props} />{options.beside}</>, { wrapper: options.strict ? StrictProviders : DesignSystemProvider });
}

// The open-link question is a design-system window, which needs the provider the app mounts at its root.
function StrictProviders({ children }: { children: ReactNode }) {
  return <StrictMode><DesignSystemProvider>{children}</DesignSystemProvider></StrictMode>;
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

/** The app asks for fullscreen, as it does after a press inside its frame. */
async function goFullscreen(sink: SessionSink) {
  await act(async () => {
    await sink.handlers?.onrequestdisplaymode?.({ mode: 'fullscreen' } as never);
  });
}

/** The element that covers the window while the app is fullscreen: the block's parent. */
const fullscreenSurface = () => screen.getByTestId('mcp-app-block').parentElement as HTMLElement;

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

    it('draws the status line and the inline frame with design-system classes', async () => {
      renderBlock();
      const status = screen.getByTestId('mcp-app-status');
      expect(status).toHaveClass('text-caption');
      expect(status).toHaveClass('text-label-tertiary');
      await settle();
      expect(screen.getByTestId('mcp-app-frame')).toHaveClass('rounded-panel');
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
        { wrapper: DesignSystemProvider },
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

  describe('theme changes', () => {
    /**
     * Flip Abu's own theme the way `App.tsx` does — the `dark` class on
     * `<html>` — and let the block's MutationObserver deliver.
     */
    async function flipTheme(dark: boolean) {
      await act(async () => {
        document.documentElement.classList.toggle('dark', dark);
        // happy-dom delivers mutation records on a microtask.
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    /** Read the host palette off the real theme, not a copied hex. */
    const textPrimary = (dark: boolean) =>
      buildAppStyleVariables(dark)['--color-text-primary'];

    function renderThemeBlock(sink: SessionSink) {
      renderBlock(
        { deps: { isDark: () => document.documentElement.classList.contains('dark') } },
        sink,
      );
    }

    /** Only the patches that announce a theme — the size/display-mode ones
     *  deliberately carry no palette. */
    function themePatches(sink: SessionSink) {
      return sink.session!.hostContextPatches.filter((p) => p.theme !== undefined);
    }

    afterEach(() => {
      document.documentElement.classList.remove('dark');
    });

    /**
     * 🔴 REGRESSION: the theme patch used to be `{ theme }` alone. The iframe
     * is not re-navigated on a theme switch, so that patch was the app's only
     * chance to learn the new colours — an app that adopted
     * `hostContext.styles.variables` at handshake time kept painting the OLD
     * theme's palette (dark text on Abu's dark surface). The demo fixture only
     * survived it by dropping the stale palette and falling back to its own
     * `light-dark()` colours; a spec-conformant app that trusts the host does
     * not have that escape hatch.
     */
    it('sends the DARK palette along with the dark theme', async () => {
      const sink: SessionSink = {};
      renderThemeBlock(sink);
      await settle();

      await flipTheme(true);

      const patch = themePatches(sink).at(-1);
      expect(patch?.theme).toBe('dark');
      expect(patch?.styles?.variables?.['--color-text-primary']).toBe(textPrimary(true));
      expect(patch?.styles?.variables?.['--color-background-primary'])
        .toBe(buildAppStyleVariables(true)['--color-background-primary']);
    });

    it('sends the LIGHT palette on the way back', async () => {
      const sink: SessionSink = {};
      renderThemeBlock(sink);
      await settle();

      await flipTheme(true);
      await flipTheme(false);

      const patch = themePatches(sink).at(-1);
      expect(patch?.theme).toBe('light');
      expect(patch?.styles?.variables?.['--color-text-primary']).toBe(textPrimary(false));
      // The two directions must actually differ — a palette that never moved
      // would satisfy both assertions above on its own.
      expect(textPrimary(true)).not.toBe(textPrimary(false));
    });

    it('leaves the palette out of a container-resize patch', async () => {
      const sink: SessionSink = {};
      renderThemeBlock(sink);
      await settle();
      // Whatever the block sent for size/display-mode carries no colours: only
      // a theme change invalidates the palette.
      const sizeOnly = sink.session!.hostContextPatches.filter((p) => p.theme === undefined);
      sizeOnly.forEach((patch) => expect(patch.styles).toBeUndefined());
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

      // The surface covers the window and lies over its scrim: its own box lets a press through
      // to the scrim, and the block, which fills the surface inside its padding, takes its own.
      const surface = fullscreenSurface();
      expect(surface).toHaveClass('pointer-events-none');
      expect(surface).toHaveClass('p-6');
      expect(screen.getByTestId('mcp-app-block').parentElement).toBe(surface);
      expect(screen.getByTestId('mcp-app-block')).not.toHaveClass('pointer-events-none');
      expect(screen.getByTestId('mcp-app-fullscreen-backdrop')).toHaveClass('bg-scrim');

      await act(async () => { fireEvent.click(screen.getByTestId('mcp-app-fullscreen-backdrop')); });
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
      expect(screen.queryByTestId('mcp-app-fullscreen-backdrop')).toBeNull();
      expect(sink.sessions).toHaveLength(1);
    });

    it('is a dialog to the keyboard and to screen readers while fullscreen, and no dialog inline', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      expect(screen.queryByRole('dialog')).toBeNull();
      const frame = screen.getByTestId('mcp-app-frame');

      await goFullscreen(sink);

      const surface = screen.getByRole('dialog', { name: 'weather' });
      expect(surface).toBe(fullscreenSurface());
      expect(surface).toHaveAttribute('aria-modal', 'true');
      expect(surface).toHaveAttribute('data-ds-layer');
      expect(surface).toHaveAttribute('data-electron-no-drag');
      expect(surface).toHaveClass('z-dialog');
      // It opens on its way out, never in the app's frame: a frame that has the focus keeps every key.
      const exit = screen.getByRole('button', { name: '退出全屏' });
      expect(exit).toBe(screen.getByTestId('mcp-app-fullscreen-exit'));
      expect(exit).toHaveClass('rounded-control');
      expect(exit).toHaveFocus();
      expect(frame).not.toHaveFocus();
      expect(screen.getByTestId('mcp-app-frame')).toBe(frame);

      await act(async () => { fireEvent.click(exit); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('mcp-app-block').parentElement).toHaveClass('contents');
      expect(screen.getByTestId('mcp-app-frame')).toBe(frame);
    });

    it('keeps Tab inside the fullscreen surface', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink, { beside: <Button>Outside the app</Button> });
      await settle();
      await goFullscreen(sink);
      const surface = fullscreenSurface();
      const exit = screen.getByTestId('mcp-app-fullscreen-exit');
      expect(exit).toHaveFocus();

      // Backwards from the first control: the last one inside, not the page behind.
      fireEvent.keyDown(exit, { key: 'Tab', shiftKey: true });
      expect(surface.contains(document.activeElement)).toBe(true);
      // Forwards from the last control: the first one again.
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      expect(exit).toHaveFocus();
    });

    it('leaves fullscreen on Escape, with the same iframe and the cool-down of a user exit', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();
      await goFullscreen(sink);
      const frame = screen.getByTestId('mcp-app-frame');

      await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });

      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('mcp-app-frame')).toBe(frame);
      expect(sink.sessions).toHaveLength(1);
      expect(sink.session!.hostContextPatches.at(-1)).toEqual({ displayMode: 'inline' });
      await expect(
        sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never),
      ).rejects.toThrow(/user gesture/);
    });

    it('leaves fullscreen when another window opens, keeping the iframe', async () => {
      function Other() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <Button onClick={() => setOpen(true)}>open settings</Button>
            <Dialog open={open} onOpenChange={setOpen} title="Settings" closeButton />
          </>
        );
      }
      const sink: SessionSink = {};
      renderBlock({}, sink, { beside: <Other /> });
      await settle();
      await goFullscreen(sink);
      const frame = screen.getByTestId('mcp-app-frame');

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'open settings', hidden: true })); });

      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
      expect(screen.queryByTestId('mcp-app-fullscreen-backdrop')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
      expect(screen.getByTestId('mcp-app-frame')).toBe(frame);
      expect(sink.sessions).toHaveLength(1);
    });

    // The interface asks by itself: nothing in the block was pressed. It is not the user's
    // content, so it never takes the place of what the user has open, and never moves the focus.
    describe('a fullscreen request while the user has something open', () => {
      const REFUSAL = /while a window, a question or an approval is open/;
      async function expectRefused(sink: SessionSink) {
        await expect(
          sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never),
        ).rejects.toThrow(REFUSAL);
        await act(async () => {});
        expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
        expect(screen.queryByTestId('mcp-app-fullscreen-backdrop')).toBeNull();
        expect(screen.queryByTestId('mcp-app-fullscreen-exit')).toBeNull();
        // The app was never told it is fullscreen.
        expect(sink.session!.hostContextPatches.some((patch) => patch.displayMode === 'fullscreen')).toBe(false);
      }
      // The refusal spent nothing: with the page free again, the same unprompted request is honoured.
      async function expectGraceStillThere(sink: SessionSink) {
        let answer: unknown;
        await act(async () => {
          answer = await sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never);
        });
        expect(answer).toEqual({ mode: 'fullscreen' });
        expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'fullscreen');
        expect(screen.getByTestId('mcp-app-fullscreen-exit')).toHaveFocus();
      }

      it.each([
        ['a plain window', {}],
        ['a window whose work would be cancelled', { busy: true }],
        ['a window with unsaved input', { dirty: true }],
      ] as const)('leaves %s open, with the focus in its field, and asks nothing', async (_name, windowProps) => {
        const changes: boolean[] = [];
        function Window() {
          const [open, setOpen] = useState(true);
          return (
            <>
              <Button onClick={() => setOpen(false)}>the owner closes the window</Button>
              <Dialog open={open} onOpenChange={(next) => { changes.push(next); setOpen(next); }} title="Settings" closeButton {...windowProps}>
                <TextField aria-label="Name" />
              </Dialog>
            </>
          );
        }
        const sink: SessionSink = {};
        renderBlock({}, sink, { beside: <Window /> });
        await settle();
        const field = screen.getByRole('textbox', { name: 'Name' });
        act(() => { field.focus(); });
        const frame = screen.getByTestId('mcp-app-frame', { exact: true });

        await expectRefused(sink);

        expect(changes).toEqual([]);
        expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
        expect(windowBox('Settings')).not.toHaveAttribute('hidden');
        // No question about unsaved input was put to the user.
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(field).toHaveFocus();
        expect(screen.getByTestId('mcp-app-frame')).toBe(frame);

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'the owner closes the window', hidden: true })); });
        await act(async () => {});
        await expectGraceStillThere(sink);
      });

      it('leaves a question unanswered', async () => {
        const answers: boolean[] = [];
        function Asker() {
          const confirm = useConfirm();
          return (
            <Button onClick={() => { void confirm({ title: 'Delete this file?', confirmLabel: 'Delete', tone: 'danger' }).then((answer) => answers.push(answer)); }}>
              ask to delete
            </Button>
          );
        }
        const sink: SessionSink = {};
        renderBlock({}, sink, { beside: <Asker /> });
        await settle();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ask to delete' })); });
        const question = screen.getByRole('alertdialog', { name: 'Delete this file?' });
        const focused = document.activeElement;
        expect(question.contains(focused)).toBe(true);

        await expectRefused(sink);

        expect(answers).toEqual([]);
        expect(screen.getByRole('alertdialog', { name: 'Delete this file?' })).toBe(question);
        expect(document.activeElement).toBe(focused);

        // The user answers; only then is the page free.
        await act(async () => { fireEvent.click(focused as HTMLElement); });
        await act(async () => {});
        expect(answers).toEqual([false]);
        await expectGraceStillThere(sink);
      });

      it('leaves the close-window question alone: nothing quits, minimizes or cancels', async () => {
        const answered = { quit: vi.fn(), minimize: vi.fn(), cancel: vi.fn(), remember: vi.fn() };
        const sink: SessionSink = {};
        renderBlock({}, sink, {
          beside: (
            <CloseDialog
              open
              hasRunningAgent={false}
              onQuit={answered.quit}
              onMinimize={answered.minimize}
              onCancel={answered.cancel}
              onCloseActionChange={answered.remember}
            />
          ),
        });
        await settle();
        const question = screen.getByRole('alertdialog');
        const focused = document.activeElement;
        expect(question.contains(focused)).toBe(true);

        await expectRefused(sink);

        for (const answer of Object.values(answered)) expect(answer).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog')).toBe(question);
        expect(document.activeElement).toBe(focused);
      });

      it('still goes fullscreen with a menu open: a menu is nothing the user would lose', async () => {
        const sink: SessionSink = {};
        renderBlock({}, sink, {
          beside: <Menu trigger={<Button>More</Button>} defaultOpen><MenuItem>Reload</MenuItem></Menu>,
        });
        await settle();
        expect(screen.getByRole('menu')).toBeInTheDocument();

        await expectGraceStillThere(sink);
      });

      it('answers a repeated request while it is the fullscreen surface itself as before', async () => {
        const sink: SessionSink = {};
        renderBlock({}, sink);
        await settle();
        await goFullscreen(sink);
        // A press on the block, then the app asks again: it is fullscreen already.
        await act(async () => { fireEvent.pointerDown(screen.getByTestId('mcp-app-block')); });
        let answer: unknown;
        await act(async () => {
          answer = await sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never);
        });
        expect(answer).toEqual({ mode: 'fullscreen' });
        expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'fullscreen');
      });
    });

    describe('with an approval', () => {
      const approvalAnswers: boolean[] = [];
      function Approval() {
        const [shown, setShown] = useState(false);
        return (
          <>
            <Button onClick={() => setShown(true)}>an approval arrives</Button>
            <Button onClick={() => setShown(false)}>the approval is answered</Button>
            {approvalProbe(shown, (open) => approvalAnswers.push(open))}
          </>
        );
      }
      beforeEach(() => { approvalAnswers.length = 0; });

      it('leaves fullscreen for an approval that arrives; the approval is not answered and has the focus', async () => {
        const sink: SessionSink = {};
        renderBlock({}, sink, { beside: <Approval /> });
        await settle();
        await goFullscreen(sink);
        const frame = screen.getByTestId('mcp-app-frame');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'an approval arrives', hidden: true })); });

        expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
        expect(screen.queryByTestId('mcp-app-fullscreen-backdrop')).toBeNull();
        const approval = windowBox(APPROVAL_TITLE)!;
        expect(approval).not.toHaveAttribute('hidden');
        await act(async () => {});
        expect(approval.contains(document.activeElement)).toBe(true);
        expect(approvalAnswers).toEqual([]);
        expect(screen.getByTestId('mcp-app-frame')).toBe(frame);
        expect(sink.sessions).toHaveLength(1);
      });

      it('is refused fullscreen while an approval shows: the app hears the refusal, the approval stays unanswered', async () => {
        const sink: SessionSink = {};
        renderBlock({}, sink, { beside: <Approval /> });
        await settle();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'an approval arrives' })); });
        const approval = windowBox(APPROVAL_TITLE)!;
        const focused = document.activeElement;
        expect(approval.contains(focused)).toBe(true);

        // The answer is a refusal, not "fullscreen" followed by "inline".
        await expect(
          sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never),
        ).rejects.toThrow(/while a window, a question or an approval is open/);
        await act(async () => {});

        expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'inline');
        expect(screen.queryByTestId('mcp-app-fullscreen-backdrop')).toBeNull();
        expect(screen.queryByTestId('mcp-app-fullscreen-exit')).toBeNull();
        expect(sink.session!.hostContextPatches.some((patch) => patch.displayMode === 'fullscreen')).toBe(false);
        expect(windowBox(APPROVAL_TITLE)).not.toHaveAttribute('hidden');
        expect(document.activeElement).toBe(focused);
        expect(approvalAnswers).toEqual([]);

        // Enter and Space pressed where the app is answer nothing.
        const block = screen.getByTestId('mcp-app-block');
        for (const key of ['Enter', ' ']) fireEvent.keyDown(block, { key });
        expect(approvalAnswers).toEqual([]);

        // The refusal spent no grace and started no cool-down: once the approval has been
        // answered, the same unprompted request is honoured.
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'the approval is answered', hidden: true })); });
        await act(async () => {});
        expect(windowBox(APPROVAL_TITLE)).toBeNull();
        let answer: unknown;
        await act(async () => {
          answer = await sink.handlers!.onrequestdisplaymode!({ mode: 'fullscreen' } as never);
        });
        expect(answer).toEqual({ mode: 'fullscreen' });
        expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'fullscreen');
        expect(approvalAnswers).toEqual([]);
      });
    });

    it('asks about a link over the fullscreen app; Escape refuses the link and leaves the app fullscreen', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();
      await goFullscreen(sink);
      const frame = screen.getByTestId('mcp-app-frame');

      let settled: 'opened' | 'refused' | undefined;
      await act(async () => {
        void Promise.resolve(sink.handlers!.onopenlink!({ url: 'https://example.com/fixture' } as never))
          .then(() => { settled = 'opened'; }, () => { settled = 'refused'; });
        await Promise.resolve();
      });
      const question = screen.getByRole('alertdialog');
      expect(question).toHaveTextContent('https://example.com/fixture');
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'fullscreen');

      await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });
      await act(async () => {});

      expect(settled).toBe('refused');
      expect(openLink).not.toHaveBeenCalled();
      expect(screen.getByTestId('mcp-app-block')).toHaveAttribute('data-display-mode', 'fullscreen');
      expect(screen.getByTestId('mcp-app-frame')).toBe(frame);
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

    it('opens an audit row from a disclosure button and prints its details in the code font', async () => {
      const sink: SessionSink = {};
      renderBlock({ deps: { findTool: () => searchTool, checkApproval: async () => ({ decision: 'allow' as const }), callTool: async () => 'two results' } }, sink);
      await settle();
      await act(async () => {
        await sink.handlers?.oncalltool?.({ name: 'search', arguments: { q: 'abu' } } as never);
      });

      const button = screen.getByTestId('mcp-app-audit-row').querySelector('button')!;
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).toHaveClass('text-label-tertiary');
      await act(async () => { fireEvent.click(button); });
      expect(button).toHaveAttribute('aria-expanded', 'true');
      for (const pre of screen.getByTestId('mcp-app-audit-row').querySelectorAll('pre')) {
        expect(pre).toHaveClass('font-code');
        expect(pre).toHaveClass('text-caption');
        expect(pre).toHaveClass('text-label-secondary');
      }
    });

    it('marks a refused call with the danger shape', async () => {
      const sink: SessionSink = {};
      renderBlock({
        deps: {
          findTool: () => searchTool,
          checkApproval: async () => ({ decision: 'deny' as const, reason: 'Error: 用户已取消' }),
          callTool: async () => 'never',
        },
      }, sink);
      await settle();
      await expect(
        sink.handlers!.oncalltool!({ name: 'search', arguments: { q: 'abu' } } as never),
      ).rejects.toThrow('用户已取消');
      await act(async () => {});
      expect(screen.getByTestId('mcp-app-audit-row').querySelector('svg.lucide-circle-x')).toHaveClass('text-danger');
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

    it('says whether the model context is open and prints it in the code font', async () => {
      renderBlock({ modelContext: '来自上一次会话' });
      await settle();
      const button = screen.getByTestId('mcp-app-context').querySelector('button')!;
      expect(button).toHaveAttribute('aria-expanded', 'false');
      await act(async () => { fireEvent.click(button); });
      expect(button).toHaveAttribute('aria-expanded', 'true');
      const pre = screen.getByTestId('mcp-app-context').querySelector('pre')!;
      expect(pre).toHaveClass('font-code');
      expect(pre).toHaveClass('text-label-secondary');
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
        // Swallow the rejection until the test awaits it, so a declined prompt
        // (one declined at once included) does not surface as an unhandled rejection.
        promise.catch(() => {});
        await Promise.resolve();
      });
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

    it('prints a long address whole, and keeps it as the title too', async () => {
      const sink: SessionSink = {};
      // As long as the host accepts (MAX_APP_LINK_URL_CHARS): what the user decides on is all of it.
      const url = `https://example.com/?q=${'x'.repeat(2048 - 'https://example.com/?q='.length)}`;
      renderBlock({}, sink);
      await settle();
      const { promise } = await askToOpen(sink, url);
      const shown = screen.getByTestId('mcp-app-open-link-url');
      expect(url).toHaveLength(2048);
      expect(shown).toHaveAttribute('title', url);
      expect(shown.textContent).toBe(url);
      expect(shown).toHaveClass('break-all');
      expect(shown).toHaveClass('font-code');
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

    // What an answer means, and what ends a request without one. The address in these tests is made up.
    const FIRST = 'https://first.example.test/path?token=not-a-secret';
    const SECOND = 'https://second.example.test/other';
    const shownAddress = () => screen.queryByTestId('mcp-app-open-link-url');

    it('shows the address letter for letter, with the same address as its title', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      expect(shownAddress()!.textContent).toBe(FIRST);
      expect(shownAddress()).toHaveAttribute('title', FIRST);
      await act(async () => { fireEvent.click(screen.getByText('取消')); });
      await expect(promise).rejects.toThrow('user declined');
    });

    it('opens the address once for one press on 打开', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      await act(async () => { fireEvent.click(screen.getByText('打开')); });
      await expect(promise).resolves.toEqual({});
      expect(openLink.mock.calls).toEqual([[FIRST]]);
      expect(shownAddress()).toBeNull();
    });

    it('takes Escape as a refusal', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
      await expect(promise).rejects.toThrow('user declined');
      expect(openLink).not.toHaveBeenCalled();
      expect(shownAddress()).toBeNull();
    });

    it('declines a second request outright while the first is being asked, and the first stays', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const first = await askToOpen(sink, FIRST);
      const second = await askToOpen(sink, SECOND);
      await expect(second.promise).rejects.toThrow('user declined');
      expect(shownAddress()!.textContent).toBe(FIRST);
      expect(openLink).not.toHaveBeenCalled();

      await act(async () => { fireEvent.click(screen.getByText('打开')); });
      await expect(first.promise).resolves.toEqual({});
      // The press was for the first address only.
      expect(openLink.mock.calls).toEqual([[FIRST]]);
    });

    it('asks again for a request that arrives after an answer', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const first = await askToOpen(sink, FIRST);
      await act(async () => { fireEvent.click(screen.getByText('取消')); });
      await expect(first.promise).rejects.toThrow('user declined');

      const second = await askToOpen(sink, SECOND);
      expect(shownAddress()!.textContent).toBe(SECOND);
      expect(openLink).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(screen.getByText('打开')); });
      await expect(second.promise).resolves.toEqual({});
      expect(openLink.mock.calls).toEqual([[SECOND]]);
    });

    it('refuses and takes the question away when the connector drops', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      setServerStatus('weather', 'connected');
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      await act(async () => { setServerStatus('weather', 'disconnected'); });
      await settle();

      await expect(promise).rejects.toThrow('user declined');
      expect(shownAddress()).toBeNull();
      expect(openLink).not.toHaveBeenCalled();
    });

    it('refuses and takes the question away when the block leaves the page', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      const view = renderBlock({ deps: { openLink } }, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      await act(async () => { view.unmount(); });

      await expect(promise).rejects.toThrow('user declined');
      expect(shownAddress()).toBeNull();
      expect(openLink).not.toHaveBeenCalled();
    });

    const QUESTION = '界面想打开链接';

    it('asks in a question window that opens on 取消', async () => {
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      const box = screen.getByRole('alertdialog', { name: QUESTION });
      expect(box).toContainElement(shownAddress());
      expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

      await act(async () => { fireEvent.click(screen.getByText('取消')); });
      await expect(promise).rejects.toThrow('user declined');
    });

    it('puts the address in the page text and its title, and nowhere else', async () => {
      const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
      const sink: SessionSink = {};
      renderBlock({}, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      const carriers = Array.from(document.querySelectorAll('*')).flatMap((element) =>
        Array.from(element.attributes).filter((attribute) => attribute.value.includes(FIRST)).map((attribute) => `${element.getAttribute('data-testid')}:${attribute.name}`));
      expect(carriers).toEqual(['mcp-app-open-link-url:title']);
      await act(async () => { fireEvent.click(screen.getByText('取消')); });
      await expect(promise).rejects.toThrow('user declined');
      for (const log of logs) {
        expect(log.mock.calls.flat().some((value) => String(value).includes(FIRST))).toBe(false);
      }
    });

    it('opens the address once when 打开 is pressed twice in one go', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      await act(async () => {
        const open = screen.getByText('打开');
        fireEvent.click(open);
        fireEvent.click(open);
      });
      await expect(promise).resolves.toEqual({});
      expect(openLink.mock.calls).toEqual([[FIRST]]);
    });

    it('gives a request that follows an answer at once a window of its own', async () => {
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink);
      await settle();

      const first = await askToOpen(sink, FIRST);
      const firstBox = screen.getByRole('alertdialog', { name: QUESTION });
      // The user is about to open the first address.
      screen.getByRole('button', { name: '打开' }).focus();

      let second!: Promise<unknown>;
      await act(async () => {
        // The first is refused and the interface asks again before the page has drawn.
        fireEvent.click(screen.getByText('取消'));
        second = sink.handlers!.onopenlink!({ url: SECOND } as never);
        second.catch(() => {});
        await Promise.resolve();
      });

      await expect(first.promise).rejects.toThrow('user declined');
      expect(shownAddress()!.textContent).toBe(SECOND);
      expect(screen.getByRole('alertdialog', { name: QUESTION })).not.toBe(firstBox);
      expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
      expect(openLink).not.toHaveBeenCalled();

      await act(async () => { fireEvent.click(screen.getByText('取消')); });
      await expect(second).rejects.toThrow('user declined');
    });

    it('is refused when another window opens and takes its place', async () => {
      function Other() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <Button onClick={() => setOpen(true)}>open settings</Button>
            <Dialog open={open} onOpenChange={setOpen} title="Settings" closeButton />
          </>
        );
      }
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink, { beside: <Other /> });
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'open settings', hidden: true })); });

      await expect(promise).rejects.toThrow('user declined');
      expect(shownAddress()).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
      expect(openLink).not.toHaveBeenCalled();
    });

    it('steps aside for an approval without an answer, and returns on 取消', async () => {
      const approvalAnswers: boolean[] = [];
      function Approval() {
        const [shown, setShown] = useState(false);
        return (
          <>
            <Button onClick={() => setShown(true)}>an approval arrives</Button>
            <Button onClick={() => setShown(false)}>the approval is answered</Button>
            {approvalProbe(shown, (open) => approvalAnswers.push(open))}
          </>
        );
      }
      const sink: SessionSink = {};
      const openLink = vi.fn();
      renderBlock({ deps: { openLink } }, sink, { beside: <Approval /> });
      await settle();

      const { promise } = await askToOpen(sink, FIRST);
      let settled = false;
      void promise.then(() => { settled = true; }, () => { settled = true; });
      // The user had moved to 打开 when the approval arrived.
      screen.getByRole('button', { name: '打开' }).focus();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'an approval arrives', hidden: true })); });

      expect(windowBox(APPROVAL_TITLE)).not.toBeNull();
      expect(windowBox(QUESTION)).toHaveAttribute('hidden');
      await act(async () => {});
      expect(settled).toBe(false);
      expect(approvalAnswers).toEqual([]);
      expect(openLink).not.toHaveBeenCalled();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'the approval is answered', hidden: true })); });
      expect(windowBox(QUESTION)).not.toHaveAttribute('hidden');
      expect(shownAddress()!.textContent).toBe(FIRST);
      expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
      expect(settled).toBe(false);

      await act(async () => { fireEvent.click(screen.getByText('打开')); });
      await expect(promise).resolves.toEqual({});
      expect(openLink.mock.calls).toEqual([[FIRST]]);
    });

    it('gives a request from another interface its own window: the first is refused, nothing carries over', async () => {
      const sinks: Record<string, SessionSink> = {};
      const openLink = vi.fn();
      const block = (id: string) => (
        <McpAppBlock
          key={id}
          toolCallId={id}
          server="weather"
          resourceUri="ui://weather/view.html"
          input={{}}
          result="ok"
          conversationId="conv-1"
          deps={{
            readResource: async () => appResource(),
            isConnected: () => true,
            handshakeTimeoutMs: 0,
            isDark: () => false,
            openLink,
            createSession: (options) => {
              const s = makeSession();
              sinks[id] = { session: s, handlers: options.handlers };
              return s;
            },
          }}
        />
      );
      render(<>{block('tc-1')}{block('tc-2')}</>, { wrapper: DesignSystemProvider });
      await settle();

      const first = await askToOpen(sinks['tc-1'], FIRST);
      const firstBox = screen.getByRole('alertdialog', { name: QUESTION });
      // The user is about to open the first address.
      screen.getByRole('button', { name: '打开' }).focus();

      const second = await askToOpen(sinks['tc-2'], SECOND);
      await act(async () => {});

      await expect(first.promise).rejects.toThrow('user declined');
      const boxes = screen.getAllByRole('alertdialog', { name: QUESTION });
      expect(boxes).toHaveLength(1);
      expect(boxes[0]).not.toBe(firstBox);
      expect(shownAddress()!.textContent).toBe(SECOND);
      expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
      expect(openLink).not.toHaveBeenCalled();

      await act(async () => { fireEvent.click(screen.getByText('打开')); });
      await expect(second.promise).resolves.toEqual({});
      expect(openLink.mock.calls).toEqual([[SECOND]]);
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

    // 🔴 Pools, not one flat list: resource reads have a 3x larger per-minute
    // budget, so a single cap lets an app page through its own resources until
    // every tool-call row is gone — hiding exactly what the trail is for.
    it('does not let a resource storm evict the tool-call rows', async () => {
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
          listServerResources: async () => ({ resources: [] }),
        },
      }, sink);
      await settle();

      await act(async () => {
        for (let i = 0; i < 5; i++) {
          await sink.handlers!.oncalltool!({ name: 'ping', arguments: { i } } as never).catch(() => {});
        }
        for (let i = 0; i < 60; i++) {
          await sink.handlers!.onlistresources!({} as never).catch(() => {});
        }
      });

      const rows = screen.getAllByTestId('mcp-app-audit-row');
      const callRows = rows.filter((r) => r.textContent?.includes('ping'));
      expect(callRows).toHaveLength(5);
      expect(rows.filter((r) => r.textContent?.includes('resources/list'))).toHaveLength(MAX_AUDIT_ROWS);
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
