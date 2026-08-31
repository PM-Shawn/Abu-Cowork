/**
 * Pure-function/type layer for browser-automation observability signals.
 * See docs/plans/2026-09-01-browser-batch1-observability.md (T1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  RepeatTracker,
  FallbackToScriptTracker,
  classifyBlockedPage,
  classifyBrowserToolError,
  detectFrameHint,
  isBrowserToolResultError,
  deriveTargetKey,
  browserChannelForTool,
  buildBrowserSignalRecord,
  recordBrowserSignal,
  getRecentBrowserSignals,
  clearBrowserSignals,
  noteBrowserToolOutcome,
  clearBrowserToolTrackers,
  noteTabCreated,
  noteTabClosed,
  recordSchedulerDriftSignal,
  getRecentSchedulerDriftSignals,
  clearSchedulerDriftSignals,
  buildSchedulerDriftSignal,
  approximateTaskSuccess,
  summarizeBrowserSignals,
  type BrowserSignalContext,
} from './browserSignals';

const ctx = (overrides: Partial<BrowserSignalContext> = {}): BrowserSignalContext => ({
  platform: 'macos',
  appVersion: '0.42.0',
  channel: 'builtin',
  ts: 1000,
  ...overrides,
});

describe('buildBrowserSignalRecord', () => {
  it('merges event fields with the collector-supplied context', () => {
    const record = buildBrowserSignalRecord(
      { kind: 'confirm_prompt', origin: 'https://example.com' },
      ctx({ conversationId: 'conv-1' }),
    );
    expect(record).toEqual({
      kind: 'confirm_prompt',
      origin: 'https://example.com',
      platform: 'macos',
      appVersion: '0.42.0',
      channel: 'builtin',
      conversationId: 'conv-1',
      ts: 1000,
    });
  });
});

describe('RepeatTracker', () => {
  it('does not emit for the first two calls on the same tool+target', () => {
    const tracker = new RepeatTracker();
    expect(tracker.track('click', 'ref:e1')).toEqual({ count: 1, shouldEmit: false });
    expect(tracker.track('click', 'ref:e1')).toEqual({ count: 2, shouldEmit: false });
  });

  it('emits starting at the 3rd consecutive call on the same tool+target', () => {
    const tracker = new RepeatTracker();
    tracker.track('click', 'ref:e1');
    tracker.track('click', 'ref:e1');
    expect(tracker.track('click', 'ref:e1')).toEqual({ count: 3, shouldEmit: true });
    expect(tracker.track('click', 'ref:e1')).toEqual({ count: 4, shouldEmit: true });
  });

  it('resets the streak when the target changes', () => {
    const tracker = new RepeatTracker();
    tracker.track('click', 'ref:e1');
    tracker.track('click', 'ref:e1');
    tracker.track('click', 'ref:e1'); // count 3
    expect(tracker.track('click', 'ref:e2')).toEqual({ count: 1, shouldEmit: false });
  });

  it('resets the streak when the tool changes even if the target is the same', () => {
    const tracker = new RepeatTracker();
    tracker.track('click', 'ref:e1');
    tracker.track('click', 'ref:e1');
    expect(tracker.track('fill', 'ref:e1')).toEqual({ count: 1, shouldEmit: false });
  });

  it('reset() clears the streak explicitly', () => {
    const tracker = new RepeatTracker();
    tracker.track('click', 'ref:e1');
    tracker.track('click', 'ref:e1');
    tracker.reset();
    expect(tracker.track('click', 'ref:e1')).toEqual({ count: 1, shouldEmit: false });
  });
});

describe('FallbackToScriptTracker', () => {
  it('does not flag execute_js as fallback when the previous call succeeded', () => {
    const tracker = new FallbackToScriptTracker();
    tracker.note('click', true);
    expect(tracker.note('execute_js', true)).toBe(false);
  });

  it('flags execute_js as fallback when the previous browser call failed', () => {
    const tracker = new FallbackToScriptTracker();
    tracker.note('click', false);
    expect(tracker.note('execute_js', true)).toBe(true);
  });

  it('does not flag a non-execute_js call even after a failure', () => {
    const tracker = new FallbackToScriptTracker();
    tracker.note('click', false);
    expect(tracker.note('snapshot', true)).toBe(false);
  });

  it('does not flag consecutive execute_js calls unless the immediately preceding one failed', () => {
    const tracker = new FallbackToScriptTracker();
    tracker.note('execute_js', true);
    expect(tracker.note('execute_js', true)).toBe(false);
  });
});

describe('classifyBlockedPage', () => {
  it('returns null for ordinary page text', () => {
    expect(classifyBlockedPage('Welcome to the dashboard')).toBeNull();
  });
  it('returns null for undefined/empty input', () => {
    expect(classifyBlockedPage(undefined)).toBeNull();
    expect(classifyBlockedPage('')).toBeNull();
  });
  it('classifies HTTP 429 text', () => {
    expect(classifyBlockedPage('Error: request failed with status 429 Too Many Requests')).toBe('http_429');
  });
  it('classifies a Cloudflare-style challenge page', () => {
    expect(classifyBlockedPage('Checking your browser before accessing the site (Cloudflare)')).toBe('challenge');
  });
  it('classifies a human-verification wall', () => {
    expect(classifyBlockedPage('Please verify you are human to continue')).toBe('verify_wall');
  });
});

describe('classifyBrowserToolError', () => {
  it('returns undefined for a non-error result', () => {
    expect(classifyBrowserToolError('{"title":"ok"}')).toBeUndefined();
  });
  it('returns undefined for empty/undefined input', () => {
    expect(classifyBrowserToolError(undefined)).toBeUndefined();
    expect(classifyBrowserToolError('')).toBeUndefined();
  });
  it('classifies a timeout error', () => {
    expect(classifyBrowserToolError('Error: operation timed out after 30000ms')).toBe('timeout');
  });
  it('classifies a not-connected error', () => {
    expect(classifyBrowserToolError('Error: Browser extension is not connected.')).toBe('not_connected');
  });
  it('falls back to unknown_error for an unrecognized Error: string', () => {
    expect(classifyBrowserToolError('Error: something unexpected happened')).toBe('unknown_error');
  });
});

describe('detectFrameHint', () => {
  it('detects an iframe mention', () => {
    expect(detectFrameHint('Error: element not found (element may be inside an iframe)')).toBe(true);
  });
  it('returns false when there is no frame mention', () => {
    expect(detectFrameHint('Error: element not found')).toBe(false);
  });
  it('returns false for undefined', () => {
    expect(detectFrameHint(undefined)).toBe(false);
  });
});

describe('isBrowserToolResultError', () => {
  it('treats a string starting with "Error" as a failure', () => {
    expect(isBrowserToolResultError('Error: Unknown tool')).toBe(true);
  });
  it('treats ordinary text as success', () => {
    expect(isBrowserToolResultError('{"tabId":1}')).toBe(false);
  });
  it('treats the "[image]" placeholder as success', () => {
    expect(isBrowserToolResultError('[image]')).toBe(false);
  });
});

describe('deriveTargetKey', () => {
  it('prefers a ref locator', () => {
    expect(deriveTargetKey('click', { tabId: 1, locator: JSON.stringify({ ref: 'e3' }) })).toBe('ref:e3');
  });
  it('uses a css locator when no ref is present', () => {
    expect(deriveTargetKey('click', { tabId: 1, locator: JSON.stringify({ css: '#submit' }) })).toBe('css:#submit');
  });
  it('buckets text/role/name/testId locators together instead of serializing page content', () => {
    expect(deriveTargetKey('click', { tabId: 1, locator: JSON.stringify({ text: '立即购买' }) })).toBe('locator:other');
  });
  it('falls back gracefully for an unparsable locator string', () => {
    expect(deriveTargetKey('click', { tabId: 1, locator: 'not-json' })).toBe('locator:unparsable');
  });
  it('uses a top-level selector when there is no locator', () => {
    expect(deriveTargetKey('extract_text', { tabId: 1, selector: '#content' })).toBe('selector:#content');
  });
  it('falls back to tabId when there is no locator/selector', () => {
    expect(deriveTargetKey('screenshot', { tabId: 7 })).toBe('tabId:7');
  });
  it('falls back to the tool name when nothing else is available', () => {
    expect(deriveTargetKey('get_tabs', {})).toBe('tool:get_tabs');
  });
  it('never includes the literal fill/select value', () => {
    const key = deriveTargetKey('fill', { tabId: 1, locator: JSON.stringify({ css: '#name' }), value: 'super-secret-value' });
    expect(key).not.toContain('super-secret-value');
  });
});

describe('browserChannelForTool', () => {
  it('classifies the builtin browser server', () => {
    expect(browserChannelForTool('abu-browser__click')).toBe('builtin');
  });
  it('classifies the chrome extension bridge server', () => {
    expect(browserChannelForTool('abu-browser-bridge__click')).toBe('chrome');
  });
  it('returns undefined for a non-browser tool', () => {
    expect(browserChannelForTool('read_file')).toBeUndefined();
  });
});

describe('browser signal ring buffer', () => {
  beforeEach(() => {
    clearBrowserSignals();
  });

  it('starts empty', () => {
    expect(getRecentBrowserSignals()).toEqual([]);
  });

  it('records and returns signals in insertion order', () => {
    recordBrowserSignal(buildBrowserSignalRecord({ kind: 'confirm_prompt' }, ctx({ ts: 1 })));
    recordBrowserSignal(buildBrowserSignalRecord({ kind: 'blocked_page', className: 'http_429' }, ctx({ ts: 2 })));
    const recent = getRecentBrowserSignals();
    expect(recent).toHaveLength(2);
    expect(recent[0].ts).toBe(1);
    expect(recent[1].ts).toBe(2);
  });

  it('never throws even if a malformed record is pushed', () => {
    expect(() => recordBrowserSignal(null as never)).not.toThrow();
  });

  it('caps memory usage by evicting the oldest entries once the buffer is full', () => {
    const CAP = 5000; // keep in sync with the module's rolling cap
    for (let i = 0; i < CAP + 10; i++) {
      recordBrowserSignal(buildBrowserSignalRecord({ kind: 'confirm_prompt' }, ctx({ ts: i })));
    }
    const recent = getRecentBrowserSignals();
    expect(recent).toHaveLength(CAP);
    expect(recent[0].ts).toBe(10); // the oldest 10 were evicted
    expect(recent[recent.length - 1].ts).toBe(CAP + 9);
  });
});

describe('scheduler drift signal ring buffer', () => {
  beforeEach(() => {
    clearSchedulerDriftSignals();
  });

  it('builds a drift signal with a computed driftMs', () => {
    const signal = buildSchedulerDriftSignal('task-1', 1000, 1500);
    expect(signal).toEqual({ kind: 'scheduler_drift', taskId: 'task-1', plannedAt: 1000, actualAt: 1500, driftMs: 500 });
  });

  it('includes tokensUsed only when provided', () => {
    const signal = buildSchedulerDriftSignal('task-1', 1000, 1500, 4321);
    expect(signal.tokensUsed).toBe(4321);
  });

  it('records and returns drift signals', () => {
    recordSchedulerDriftSignal(buildSchedulerDriftSignal('task-1', 1000, 1200));
    expect(getRecentSchedulerDriftSignals()).toHaveLength(1);
  });

  it('never throws on a malformed record', () => {
    expect(() => recordSchedulerDriftSignal(null as never)).not.toThrow();
  });
});

describe('noteBrowserToolOutcome (stateful per-conversation trackers)', () => {
  beforeEach(() => {
    clearBrowserToolTrackers();
  });

  it('tracks repeat and fallback state independently per conversation', () => {
    const a1 = noteBrowserToolOutcome('conv-a', 'click', 'ref:e1', false);
    expect(a1.repeat).toEqual({ count: 1, shouldEmit: false });
    expect(a1.fallback).toBe(false);

    // Different conversation must not share the streak.
    const b1 = noteBrowserToolOutcome('conv-b', 'click', 'ref:e1', false);
    expect(b1.repeat).toEqual({ count: 1, shouldEmit: false });

    const a2 = noteBrowserToolOutcome('conv-a', 'execute_js', 'ref:e1', true);
    expect(a2.fallback).toBe(true); // conv-a's previous call failed
    const b2 = noteBrowserToolOutcome('conv-b', 'execute_js', 'ref:e1', true);
    expect(b2.fallback).toBe(true); // conv-b's previous call also failed independently
  });

  it('clearBrowserToolTrackers(conversationId) only clears that conversation', () => {
    noteBrowserToolOutcome('conv-a', 'click', 'ref:e1', false);
    noteBrowserToolOutcome('conv-a', 'click', 'ref:e1', false); // count 2
    clearBrowserToolTrackers('conv-a');
    const after = noteBrowserToolOutcome('conv-a', 'click', 'ref:e1', false);
    expect(after.repeat).toEqual({ count: 1, shouldEmit: false });
  });

  it('falls back to a shared bucket when conversationId is undefined, without throwing', () => {
    expect(() => noteBrowserToolOutcome(undefined, 'click', 'ref:e1', true)).not.toThrow();
  });
});

describe('tab lifetime tracking', () => {
  it('computes aliveMs from creation to close', () => {
    noteTabCreated('tab-1', 1000);
    expect(noteTabClosed('tab-1', 2500)).toBe(1500);
  });

  it('returns undefined for a tab that was never recorded as created', () => {
    expect(noteTabClosed('never-created', 1000)).toBeUndefined();
  });

  it('forgets the tab after it is closed (closing twice yields undefined the second time)', () => {
    noteTabCreated('tab-2', 1000);
    noteTabClosed('tab-2', 2000);
    expect(noteTabClosed('tab-2', 3000)).toBeUndefined();
  });
});

describe('approximateTaskSuccess (F1.2)', () => {
  it('is successful when there were no failures, no takeover, and no script fallback', () => {
    expect(approximateTaskSuccess({
      hadConsecutiveFailures: false,
      hadManualTakeover: false,
      usedScriptFallback: false,
    })).toBe(true);
  });

  it('is not successful when there were consecutive failures', () => {
    expect(approximateTaskSuccess({
      hadConsecutiveFailures: true,
      hadManualTakeover: false,
      usedScriptFallback: false,
    })).toBe(false);
  });

  it('is not successful when the user manually took over', () => {
    expect(approximateTaskSuccess({
      hadConsecutiveFailures: false,
      hadManualTakeover: true,
      usedScriptFallback: false,
    })).toBe(false);
  });

  it('is not successful when it only completed via the execute_js fallback', () => {
    expect(approximateTaskSuccess({
      hadConsecutiveFailures: false,
      hadManualTakeover: false,
      usedScriptFallback: true,
    })).toBe(false);
  });
});

describe('summarizeBrowserSignals', () => {
  it('returns a no-data summary for an empty input', () => {
    const summary = summarizeBrowserSignals([]);
    expect(summary.taskCount).toBe(0);
    expect(summary.successRateApprox).toBeNull();
    expect(summary.fallbackCount).toBe(0);
    expect(summary.confirmPromptCount).toBe(0);
    expect(summary.repeatActionTop3).toEqual([]);
    expect(summary.blockedPageCount).toBe(0);
    expect(summary.avgTabAliveMs).toBeNull();
    expect(summary.bySiteAndPlatform).toEqual([]);
  });

  it('counts fallback, confirm_prompt and blocked_page occurrences', () => {
    const records = [
      buildBrowserSignalRecord({ kind: 'fallback_to_script' }, ctx({ ts: 1 })),
      buildBrowserSignalRecord({ kind: 'confirm_prompt', origin: 'https://a.com' }, ctx({ ts: 2 })),
      buildBrowserSignalRecord({ kind: 'confirm_prompt', origin: 'https://a.com' }, ctx({ ts: 3 })),
      buildBrowserSignalRecord({ kind: 'blocked_page', className: 'challenge' }, ctx({ ts: 4 })),
    ];
    const summary = summarizeBrowserSignals(records);
    expect(summary.fallbackCount).toBe(1);
    expect(summary.confirmPromptCount).toBe(2);
    expect(summary.blockedPageCount).toBe(1);
  });

  it('returns the top-3 repeat_action entries by max observed count', () => {
    const records = [
      buildBrowserSignalRecord({ kind: 'repeat_action', tool: 'click', targetKey: 'ref:e1', count: 3 }, ctx({ ts: 1 })),
      buildBrowserSignalRecord({ kind: 'repeat_action', tool: 'click', targetKey: 'ref:e1', count: 5 }, ctx({ ts: 2 })),
      buildBrowserSignalRecord({ kind: 'repeat_action', tool: 'fill', targetKey: 'css:#x', count: 4 }, ctx({ ts: 3 })),
      buildBrowserSignalRecord({ kind: 'repeat_action', tool: 'scroll', targetKey: 'tabId:1', count: 3 }, ctx({ ts: 4 })),
      buildBrowserSignalRecord({ kind: 'repeat_action', tool: 'select', targetKey: 'css:#y', count: 3 }, ctx({ ts: 5 })),
    ];
    const summary = summarizeBrowserSignals(records);
    expect(summary.repeatActionTop3).toHaveLength(3);
    expect(summary.repeatActionTop3[0]).toEqual({ tool: 'click', targetKey: 'ref:e1', count: 5 });
    expect(summary.repeatActionTop3.map((r) => r.count)).toEqual([5, 4, 3]);
  });

  it('averages tab_lifetime close events with a known aliveMs', () => {
    const records = [
      buildBrowserSignalRecord({ kind: 'tab_lifetime', event: 'created' }, ctx({ ts: 1 })),
      buildBrowserSignalRecord({ kind: 'tab_lifetime', event: 'closed', aliveMs: 1000 }, ctx({ ts: 2 })),
      buildBrowserSignalRecord({ kind: 'tab_lifetime', event: 'closed', aliveMs: 3000 }, ctx({ ts: 3 })),
      buildBrowserSignalRecord({ kind: 'tab_lifetime', event: 'closed' }, ctx({ ts: 4 })), // unknown aliveMs, excluded
    ];
    const summary = summarizeBrowserSignals(records);
    expect(summary.avgTabAliveMs).toBe(2000);
  });

  it('breaks tool_call ok-rate down by origin x platform', () => {
    const records = [
      buildBrowserSignalRecord({ kind: 'tool_call', tool: 'abu-browser__click', ok: true, durationMs: 10, origin: 'https://a.com' }, ctx({ ts: 1, platform: 'macos' })),
      buildBrowserSignalRecord({ kind: 'tool_call', tool: 'abu-browser__click', ok: false, durationMs: 10, origin: 'https://a.com' }, ctx({ ts: 2, platform: 'macos' })),
      buildBrowserSignalRecord({ kind: 'tool_call', tool: 'abu-browser__click', ok: true, durationMs: 10, origin: 'https://b.com' }, ctx({ ts: 3, platform: 'windows' })),
    ];
    const summary = summarizeBrowserSignals(records);
    expect(summary.bySiteAndPlatform).toEqual(
      expect.arrayContaining([
        { origin: 'https://a.com', platform: 'macos', toolCallCount: 2, okRate: 0.5 },
        { origin: 'https://b.com', platform: 'windows', toolCallCount: 1, okRate: 1 },
      ]),
    );
  });

  it('computes an approximate per-task success rate from task_end-delimited segments, grouped by conversation', () => {
    const records = [
      // conv-1: clean task, 1 tool_call ok, then task_end → success
      buildBrowserSignalRecord({ kind: 'tool_call', tool: 'abu-browser__click', ok: true, durationMs: 10 }, ctx({ ts: 1, conversationId: 'conv-1' })),
      buildBrowserSignalRecord({ kind: 'task_end', browserToolCalls: 1, unfinishedHint: false }, ctx({ ts: 2, conversationId: 'conv-1' })),
      // conv-2: two consecutive failures, then task_end → not success
      buildBrowserSignalRecord({ kind: 'tool_call', tool: 'abu-browser__click', ok: false, durationMs: 10 }, ctx({ ts: 3, conversationId: 'conv-2' })),
      buildBrowserSignalRecord({ kind: 'tool_call', tool: 'abu-browser__click', ok: false, durationMs: 10 }, ctx({ ts: 4, conversationId: 'conv-2' })),
      buildBrowserSignalRecord({ kind: 'task_end', browserToolCalls: 2, unfinishedHint: true }, ctx({ ts: 5, conversationId: 'conv-2' })),
    ];
    const summary = summarizeBrowserSignals(records);
    expect(summary.taskCount).toBe(2);
    expect(summary.successRateApprox).toBe(0.5);
  });
});
