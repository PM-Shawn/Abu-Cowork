/**
 * Integration coverage for the browser observability collection points added
 * to registry.ts (T2, docs/plans/2026-09-01-browser-batch1-observability.md):
 *  - tool_call + blocked_page + frameHint recorded at the MCP execution
 *    boundary, after the approval gate, without changing the returned
 *    ToolResult (behavior zero-change is the hard requirement).
 *  - confirm_prompt recorded exactly when a real confirmation dialog is
 *    about to be shown for a state-changing browser tool.
 *  - repeat_action recorded once the same tool+target repeats >=3 times.
 *  - fallback_to_script recorded when execute_js follows a failed call.
 *
 * These exercise `executeAnyTool`/`checkToolApproval` through a mocked
 * mcpManager — no real browser transport involved.
 *
 * Mock note: a state-changing browser tool's approval gate already calls
 * `mcpManager.callTool(server, 'get_tabs', {})` to resolve the action's
 * origin (`resolveBrowserActionOrigin`, pre-existing behavior, unrelated to
 * this batch). The mock below special-cases `get_tabs` so it never consumes
 * a response queued for the tool under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isConnected: vi.fn().mockReturnValue(true),
  callTool: vi.fn(),
}));

vi.mock('../mcp/client', () => ({
  mcpManager: {
    isConnected: mocks.isConnected,
    callTool: mocks.callTool,
    listTools: () => [],
  },
}));

import { executeAnyTool, checkToolApproval } from './registry';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { __resetBrowserGrantsForTests } from '../permissions/browserToolPolicy';
import {
  clearBrowserSignals,
  clearBrowserToolTrackers,
  getRecentBrowserSignals,
} from '../observability/browserSignals';

function makeLocator(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

let responseQueue: string[] = [];
let defaultResponse = 'ok';

/** Queue a one-shot response for the NEXT non-get_tabs callTool invocation. */
function queueResponse(text: string): void {
  responseQueue.push(text);
}

/** Response returned for every non-get_tabs call once the queue is empty. */
function setDefaultResponse(text: string): void {
  defaultResponse = text;
}

describe('registry.ts browser observability collection', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
    __resetBrowserGrantsForTests();
    clearBrowserSignals();
    clearBrowserToolTrackers();
    mocks.isConnected.mockReturnValue(true);
    responseQueue = [];
    defaultResponse = 'ok';
    mocks.callTool.mockReset();
    mocks.callTool.mockImplementation(async (_server: string, toolName: string) => {
      if (toolName === 'get_tabs') return JSON.stringify({ windows: [] });
      return responseQueue.length > 0 ? responseQueue.shift() : defaultResponse;
    });
  });

  afterEach(() => {
    clearBrowserSignals();
    clearBrowserToolTrackers();
  });

  it('records a successful read-only tool_call without altering the returned result', async () => {
    setDefaultResponse('{"elements":[]}');

    const result = await executeAnyTool(
      'abu-browser__snapshot',
      { tabId: 1 },
      undefined,
      undefined,
      { conversationId: 'conv-1' },
    );

    expect(result).toBe('{"elements":[]}');
    const signals = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'tool_call',
      tool: 'abu-browser__snapshot',
      ok: true,
      channel: 'builtin',
      conversationId: 'conv-1',
    });
    expect(typeof (signals[0] as { durationMs: number }).durationMs).toBe('number');
  });

  it('records ok:false and an errorClass for a failing call, without altering the returned error text', async () => {
    setDefaultResponse('Error: Browser extension is not connected.');

    const result = await executeAnyTool(
      'abu-browser-bridge__extract_text',
      { tabId: 1, selector: '#content' },
      undefined,
      undefined,
      { conversationId: 'conv-1' },
    );

    expect(result).toBe('Error: Browser extension is not connected.');
    const signals = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      tool: 'abu-browser-bridge__extract_text',
      ok: false,
      errorClass: 'not_connected',
      channel: 'chrome',
    });
  });

  it('records a blocked_page signal alongside tool_call when the result matches a known block pattern', async () => {
    setDefaultResponse('Error: request failed with status 429 Too Many Requests');

    await executeAnyTool(
      'abu-browser__extract_text',
      { tabId: 1, selector: '#content' },
      undefined,
      undefined,
      { conversationId: 'conv-1' },
    );

    const blocked = getRecentBrowserSignals().filter((s) => s.kind === 'blocked_page');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ kind: 'blocked_page', className: 'http_429' });
  });

  it('does not affect the existing read-only browser tool result path when the result has no error/block markers', async () => {
    setDefaultResponse('plain page text, nothing special');

    const result = await executeAnyTool(
      'abu-browser__extract_text',
      { tabId: 1 },
      undefined,
      undefined,
      { conversationId: 'conv-1' },
    );

    expect(result).toBe('plain page text, nothing special');
    expect(getRecentBrowserSignals().filter((s) => s.kind === 'blocked_page')).toHaveLength(0);
  });

  it('records repeat_action once the same tool+target repeats 3 times, and not before', async () => {
    for (let i = 0; i < 2; i++) {
      await executeAnyTool(
        'abu-browser__extract_text',
        { tabId: 1, selector: '#a' },
        undefined,
        undefined,
        { conversationId: 'conv-1' },
      );
    }
    expect(getRecentBrowserSignals().filter((s) => s.kind === 'repeat_action')).toHaveLength(0);

    await executeAnyTool(
      'abu-browser__extract_text',
      { tabId: 1, selector: '#a' },
      undefined,
      undefined,
      { conversationId: 'conv-1' },
    );
    const repeats = getRecentBrowserSignals().filter((s) => s.kind === 'repeat_action');
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ kind: 'repeat_action', targetKey: 'selector:#a', count: 3 });
  });

  it('resets the repeat streak when the target changes', async () => {
    await executeAnyTool('abu-browser__extract_text', { tabId: 1, selector: '#a' }, undefined, undefined, { conversationId: 'conv-1' });
    await executeAnyTool('abu-browser__extract_text', { tabId: 1, selector: '#a' }, undefined, undefined, { conversationId: 'conv-1' });
    await executeAnyTool('abu-browser__extract_text', { tabId: 1, selector: '#b' }, undefined, undefined, { conversationId: 'conv-1' });
    expect(getRecentBrowserSignals().filter((s) => s.kind === 'repeat_action')).toHaveLength(0);
  });

  it('records fallback_to_script when execute_js follows a failed browser tool call in the same conversation', async () => {
    queueResponse('Error: no element found');
    await executeAnyTool(
      'abu-browser__extract_text',
      { tabId: 1, selector: '#missing' },
      undefined,
      undefined,
      { conversationId: 'conv-1' },
    );

    queueResponse('42');
    const confirmAlways = async () => true;
    await executeAnyTool(
      'abu-browser__execute_js',
      { tabId: 1, code: 'document.title' },
      confirmAlways,
      undefined,
      { conversationId: 'conv-1' },
    );

    const fallbacks = getRecentBrowserSignals().filter((s) => s.kind === 'fallback_to_script');
    expect(fallbacks).toHaveLength(1);
  });

  it('does not record fallback_to_script when the previous call succeeded', async () => {
    queueResponse('some text');
    await executeAnyTool('abu-browser__extract_text', { tabId: 1, selector: '#ok' }, undefined, undefined, { conversationId: 'conv-1' });

    queueResponse('42');
    const confirmAlways = async () => true;
    await executeAnyTool('abu-browser__execute_js', { tabId: 1, code: 'x' }, confirmAlways, undefined, { conversationId: 'conv-1' });

    expect(getRecentBrowserSignals().filter((s) => s.kind === 'fallback_to_script')).toHaveLength(0);
  });

  it('records confirm_prompt exactly when a real confirmation dialog is shown for a state-changing tool, and not again once granted', async () => {
    const confirm = async () => true;

    await checkToolApproval('abu-browser__click', { tabId: 1, locator: makeLocator({ ref: 'e1' }) }, { conversationId: 'conv-1' } as never, confirm as never);
    await checkToolApproval('abu-browser__click', { tabId: 1, locator: makeLocator({ ref: 'e1' }) }, { conversationId: 'conv-1' } as never, confirm as never);

    const prompts = getRecentBrowserSignals().filter((s) => s.kind === 'confirm_prompt');
    expect(prompts).toHaveLength(1);
  });

  it('does not record confirm_prompt when there is no confirmation channel (fails closed without ever prompting)', async () => {
    const decision = await checkToolApproval('abu-browser__click', { tabId: 1 }, { conversationId: 'conv-1' } as never, undefined);
    expect(decision.decision).toBe('deny');
    expect(getRecentBrowserSignals().filter((s) => s.kind === 'confirm_prompt')).toHaveLength(0);
  });

  it('does not record confirm_prompt for read-only browser tools (never gated)', async () => {
    const confirm = async () => true;
    await checkToolApproval('abu-browser__snapshot', { tabId: 1 }, { conversationId: 'conv-1' } as never, confirm as never);
    expect(getRecentBrowserSignals().filter((s) => s.kind === 'confirm_prompt')).toHaveLength(0);
  });

  it('never lets a signal-recording failure affect the tool result, even for a malformed locator', async () => {
    const result = await executeAnyTool(
      'abu-browser__click',
      { tabId: 1, locator: 'not-json-at-all' },
      async () => true,
      undefined,
      { conversationId: 'conv-1' },
    );
    expect(result).toBe('ok');
  });

  it('does not record any signal for a non-browser MCP tool', async () => {
    setDefaultResponse('unrelated result');
    await executeAnyTool('some-other-server__do_thing', {}, undefined, undefined, { conversationId: 'conv-1' });
    expect(getRecentBrowserSignals()).toHaveLength(0);
  });
});
