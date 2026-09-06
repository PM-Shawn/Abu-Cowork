// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import type { McpAppResource } from '@/core/mcp/appResources';
import type { AppBridgeSession } from '@/core/mcp/appBridgeSession';
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

function renderBlock(over: Partial<McpAppBlockProps> = {}, sessionSink: { session?: ReturnType<typeof makeSession> } = {}) {
  const defaultDeps: McpAppBlockProps['deps'] = {
    readResource: async () => appResource(),
    isConnected: () => true,
    handshakeTimeoutMs: 0,
    isDark: () => false,
    createSession: () => {
      const s = makeSession();
      sessionSink.session = s;
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
  return render(<McpAppBlock {...props} />);
}

/** Let the resource promise + the effects it unblocks settle. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('McpAppBlock', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetMcpAppSlots();
  });
  afterEach(() => {
    cleanup();
    resetMcpAppSlots();
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

  describe('concurrency cap', () => {
    it('collapses the oldest blocks past the cap into a click-to-load placeholder', async () => {
      const blocks = Array.from({ length: 7 }, (_, i) => i);
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
                createSession: () => makeSession(),
              }}
            />
          ))}
        </>,
      );
      await settle();

      expect(screen.getAllByTestId('mcp-app-frame')).toHaveLength(6);
      const placeholders = screen.getAllByTestId('mcp-app-placeholder');
      expect(placeholders).toHaveLength(1);

      await act(async () => { fireEvent.click(placeholders[0]); });
      await settle();
      // Re-activating the evicted block pushes the next-oldest out instead.
      expect(screen.getAllByTestId('mcp-app-frame')).toHaveLength(6);
      expect(screen.getAllByTestId('mcp-app-placeholder')).toHaveLength(1);
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
});
