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
let getTabsCallCount = 0;

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
    getTabsCallCount = 0;
    mocks.callTool.mockReset();
    mocks.callTool.mockImplementation(async (_server: string, toolName: string) => {
      if (toolName === 'get_tabs') {
        getTabsCallCount++;
        return JSON.stringify({ windows: [] });
      }
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

  it('records the three moments of a page dialog: it appeared, it was answered, it timed out', async () => {
    // A dialog is invisible in this stream unless it is recorded on purpose:
    // it shows up as a scatter of failed clicks with nothing saying they all
    // died behind one confirm box.
    setDefaultResponse(
      'Error: This tab is blocked by a JavaScript dialog the page opened (confirm). '
      + 'Call get_dialog to read it. Dialog text: "确定要提交吗"',
    );
    const approve = async () => true;
    await executeAnyTool(
      'abu-browser__click',
      { tabId: 1, locator: makeLocator({ css: '#submit' }) },
      approve,
      undefined,
      { conversationId: 'conv-dialog' },
    );

    setDefaultResponse(JSON.stringify({
      tabId: 1, action: 'accept', handled: true,
      dialog: { type: 'confirm', message: '确定要提交吗', url: 'https://erp.example/', openedAt: 1 },
      message: 'Accepted',
    }));
    await executeAnyTool(
      'abu-browser__handle_dialog',
      { tabId: 1, action: 'accept' },
      approve,
      undefined,
      { conversationId: 'conv-dialog' },
    );

    setDefaultResponse(JSON.stringify({
      tabId: 1, pending: false,
      last: { type: 'alert', message: '会话已过期', url: 'https://erp.example/', openedAt: 2, disposition: 'auto-dismissed' },
      message: 'No dialog is open on this tab.',
    }));
    await executeAnyTool(
      'abu-browser__get_dialog',
      { tabId: 1 },
      undefined,
      undefined,
      { conversationId: 'conv-dialog' },
    );

    const dialogs = getRecentBrowserSignals().filter((s) => s.kind === 'js_dialog');
    expect(dialogs).toMatchObject([
      { event: 'opened', dialogType: 'confirm', tabId: 1, conversationId: 'conv-dialog' },
      { event: 'handled', dialogType: 'confirm', action: 'accept' },
      { event: 'timed_out', dialogType: 'alert' },
    ]);
    // No page text, ever — same rule the rest of this stream follows.
    expect(JSON.stringify(dialogs)).not.toContain('确定要提交吗');
    expect(JSON.stringify(dialogs)).not.toContain('会话已过期');
    // And the blocked click is filed under its own error class rather than
    // disappearing into `unknown_error`.
    const blocked = getRecentBrowserSignals().find(
      (s) => s.kind === 'tool_call' && s.tool === 'abu-browser__click',
    );
    expect(blocked).toMatchObject({ ok: false, errorClass: 'dialog_pending' });
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
    // targetKey is tab-id-prefixed (fix-wave finding #4: same selector on a
    // different tab must not collide into the same repeat streak).
    expect(repeats[0]).toMatchObject({ kind: 'repeat_action', targetKey: 'tab:1 selector:#a', count: 3 });
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

  // ── Fix-wave finding #3: frameHint/blocked_page must not fire on success ──
  describe('frameHint/blocked_page are only classified on a FAILED call (fix-wave finding #3)', () => {
    it('does not flag frameHint on a successful result that happens to contain "iframe"', async () => {
      setDefaultResponse(JSON.stringify({ elements: [{ tag: 'iframe', ref: 'e1' }] }));
      await executeAnyTool('abu-browser__snapshot', { tabId: 1 }, undefined, undefined, { conversationId: 'conv-1' });
      const [signal] = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
      expect(signal).toMatchObject({ ok: true });
      expect((signal as { frameHint?: boolean }).frameHint).toBeUndefined();
    });

    it('does not record blocked_page for a successful result mentioning "429" as a price/count', async () => {
      setDefaultResponse('In stock: 429 units available');
      await executeAnyTool('abu-browser__extract_text', { tabId: 1 }, undefined, undefined, { conversationId: 'conv-1' });
      expect(getRecentBrowserSignals().filter((s) => s.kind === 'blocked_page')).toHaveLength(0);
    });

    it('still flags frameHint on a FAILED result mentioning iframe', async () => {
      setDefaultResponse('Error: element not found (it may be inside an iframe)');
      await executeAnyTool('abu-browser__click', { tabId: 1, locator: makeLocator({ ref: 'e1' }) }, async () => true, undefined, { conversationId: 'conv-1' });
      const [signal] = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
      expect(signal).toMatchObject({ ok: false, frameHint: true });
    });
  });

  // ── Fix-wave: navigate success caches tabId→origin, zero extra round trips ──
  describe('tab origin cache (fix-wave)', () => {
    it('gives a later call on the same tab the origin a prior successful navigate resolved, without an extra get_tabs call', async () => {
      queueResponse('ok'); // response for the navigate call itself
      await executeAnyTool(
        'abu-browser__navigate',
        { tabId: 1, url: 'https://example.com/page', action: 'goto' },
        async () => true,
        undefined,
        { conversationId: 'conv-1' },
      );
      const getTabsCallsAfterNavigate = getTabsCallCount;

      queueResponse('extracted text');
      await executeAnyTool(
        'abu-browser__extract_text',
        { tabId: 1, selector: '#content' },
        undefined,
        undefined,
        { conversationId: 'conv-1' },
      );

      const toolCalls = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
      const extractSignal = toolCalls.find((s) => s.kind === 'tool_call' && s.tool === 'abu-browser__extract_text');
      expect(extractSignal).toMatchObject({ origin: 'https://example.com' });
      // No additional get_tabs round trip was spent resolving it.
      expect(getTabsCallCount).toBe(getTabsCallsAfterNavigate);
    });

    it('does not cache an origin when the navigate call itself failed', async () => {
      queueResponse('Error: navigation failed');
      await executeAnyTool(
        'abu-browser__navigate',
        { tabId: 1, url: 'https://example.com/page', action: 'goto' },
        async () => true,
        undefined,
        { conversationId: 'conv-1' },
      );

      queueResponse('extracted text');
      await executeAnyTool('abu-browser__extract_text', { tabId: 1, selector: '#content' }, undefined, undefined, { conversationId: 'conv-1' });

      const extractSignal = getRecentBrowserSignals().find((s) => s.kind === 'tool_call' && s.tool === 'abu-browser__extract_text');
      expect((extractSignal as { origin?: string })?.origin).toBeUndefined();
    });

    it('scopes the cached origin by conversation — an unrelated conversation reusing the same tabId does not inherit it', async () => {
      queueResponse('ok');
      await executeAnyTool(
        'abu-browser__navigate',
        { tabId: 1, url: 'https://example.com/page', action: 'goto' },
        async () => true,
        undefined,
        { conversationId: 'conv-1' },
      );

      queueResponse('extracted text');
      await executeAnyTool('abu-browser__extract_text', { tabId: 1, selector: '#content' }, undefined, undefined, { conversationId: 'conv-2' });

      const extractSignal = getRecentBrowserSignals().find((s) => s.kind === 'tool_call' && s.tool === 'abu-browser__extract_text' && s.conversationId === 'conv-2');
      expect((extractSignal as { origin?: string })?.origin).toBeUndefined();
    });
  });


  // ── batch: one tool call, N page actions ─────────────────────────────────
  describe('a batch is recorded as the actions it ran, not as one opaque call', () => {
    const envelope = JSON.stringify({
      tabId: 1,
      origin: 'https://erp.example.com',
      completedSteps: [
        { index: 0, action: 'fill', ok: true, durationMs: 12 },
        { index: 1, action: 'fill', ok: true, durationMs: 9 },
      ],
      failedStep: { index: 2, action: 'click', ok: false, durationMs: 4, error: 'Element not found: #submit' },
      remainingSteps: 1,
      stopped: 'step-failed',
      message: 'Batch stopped',
    });

    /** A batch touches the page, so it asks — approve it and get on with it. */
    const approveOnce = (async () => true) as never;

    it('emits one tool_call per step it ran, with each step named as itself', async () => {
      // Recording it as a single `batch` event would make an eight-field form
      // read as one browser interaction — blind to exactly what batching does.
      setDefaultResponse(envelope);

      await executeAnyTool(
        'abu-browser__batch',
        { tabId: 1, steps: '[{"action":"fill","locator":{"css":"#a"},"value":"1"}]' },
        approveOnce,
        undefined,
        { conversationId: 'conv-batch' },
      );

      const signals = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
      expect(signals.map((s) => (s as { tool: string }).tool)).toEqual([
        'abu-browser__fill', 'abu-browser__fill', 'abu-browser__click',
      ]);
      expect(signals.map((s) => (s as { ok: boolean }).ok)).toEqual([true, true, false]);
      expect(signals[2]).toMatchObject({ errorClass: 'unknown_error', durationMs: 4 });
      // And no leftover `batch` event double-counting the same work.
      expect(signals.some((s) => (s as { tool: string }).tool.endsWith('__batch'))).toBe(false);
    });

    it('falls back to recording the call itself when the result is not a batch envelope', async () => {
      // A refusal, a transport error, or a future shape change must not make
      // the run invisible to the signal stream.
      setDefaultResponse('Error: Browser extension is not connected.');

      await executeAnyTool(
        'abu-browser__batch',
        { tabId: 1, steps: '[{"action":"fill","locator":{"css":"#a"},"value":"1"}]' },
        approveOnce,
        undefined,
        { conversationId: 'conv-batch' },
      );

      const signals = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ tool: 'abu-browser__batch', ok: false });
    });
  });

  // ── Fix-wave minor: callTool throwing must propagate untouched + still record ──
  describe('mcpManager.callTool throwing (fix-wave minor, registry.ts callTool-throw branch)', () => {
    it('propagates the original error object unchanged and still records ok:false', async () => {
      const originalError = new Error('transport exploded');
      mocks.callTool.mockImplementationOnce(async () => { throw originalError; });

      await expect(
        executeAnyTool('abu-browser__snapshot', { tabId: 1 }, undefined, undefined, { conversationId: 'conv-1' }),
      ).rejects.toBe(originalError);

      const [signal] = getRecentBrowserSignals().filter((s) => s.kind === 'tool_call');
      expect(signal).toMatchObject({ tool: 'abu-browser__snapshot', ok: false });
    });

    it('propagates a thrown non-Error value unchanged too', async () => {
      mocks.callTool.mockImplementationOnce(async () => { throw 'plain string failure'; });

      await expect(
        executeAnyTool('abu-browser__snapshot', { tabId: 1 }, undefined, undefined, { conversationId: 'conv-1' }),
      ).rejects.toBe('plain string failure');

      expect(getRecentBrowserSignals().filter((s) => s.kind === 'tool_call')).toHaveLength(1);
    });
  });
});
